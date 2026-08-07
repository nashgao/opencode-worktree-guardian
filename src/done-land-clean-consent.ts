import crypto from "node:crypto";
import type { DeletionFingerprintEntry } from "./deletion-fingerprint.ts";
import { buildDirtySessionDoneIntentFromInspection, DoneIntentBuildError, inspectDirtySessionDoneIntent } from "./done-intent.ts";
import type { DirtySnapshot } from "./done-primary-snapshot.ts";
import { buildSafetyRef, fetchRemote, getCurrentBranch, getHeadCommit, getRefCommit, getSymbolicRefTarget, listStashes, remoteTrackingRef, runGit, tryGit } from "./git.ts";
import type { GitStashEntry } from "./git.ts";
import { configuredRemoteAuthority } from "./git-authority.ts";
import { dirtyCommitPolicyBlocker } from "./state-dirty-commit-reservation.ts";
import type { GuardianConfig, GuardianSession } from "./types.ts";

type SessionLandCleanTokenContext = {
  readonly input: Record<string, unknown>;
  readonly repoRoot: string;
  readonly sessionId: string;
};

type SessionLandCleanTokenPreflight = {
  readonly branch: string;
  readonly worktreePath: string;
  readonly head: string;
  readonly dirtyFiles: readonly string[];
  readonly snapshot: DirtySnapshot;
  readonly remote: string;
  readonly baseBranch: string;
  readonly baseRef: string;
  readonly baseRefOid: string;
  readonly remoteBranchOid: string | null;
  readonly safetyRef: string;
  readonly ignoredFiles: readonly string[];
  readonly ignoredFileFingerprint: readonly DeletionFingerprintEntry[];
  readonly sourceIndexTree: string;
  readonly candidateTree: string;
};

type SessionLandCleanTokenInput = {
  readonly action: "already-landed-clean" | "land-and-clean";
  readonly context: SessionLandCleanTokenContext;
  readonly preflight: SessionLandCleanTokenPreflight;
  readonly commitMessage: string;
};

export type LandCleanPreflight =
  | { readonly ok: false; readonly status: string; readonly reason: string; readonly [key: string]: unknown }
  | {
      readonly ok: true;
      readonly branch: string;
      readonly worktreePath: string;
      readonly head: string;
      readonly dirtyFiles: readonly string[];
      readonly snapshot: DirtySnapshot;
      readonly stashCount: number;
      readonly stashes: readonly GitStashEntry[];
      readonly remote: string;
       readonly baseBranch: string;
       readonly baseRef: string;
       readonly baseRefOid: string;
       readonly remoteBranchOid: string | null;
       readonly safetyRef: string;
       readonly ignoredFiles: readonly string[];
       readonly ignoredFileFingerprint: readonly DeletionFingerprintEntry[];
       readonly sourceIndexTree: string;
       readonly candidateTree: string;
     };

export type SuccessfulLandCleanPreflight = Extract<LandCleanPreflight, { readonly ok: true }>;

export type BatchLandAuthorization = {
  readonly kind: "done-all";
  readonly originalConfirmToken: string;
  readonly originalBaseRefOid: string;
  readonly authorizedBaseRefOid: string;
};

export function classifyLandBaseTransition(input: { readonly before: string; readonly after: string; readonly approvedHead: string; readonly parents: readonly string[]; readonly approvedHeadIsAncestor: boolean; readonly beforeIsAncestor: boolean }) {
  if (input.after === input.before) return input.approvedHeadIsAncestor ? { ok: true, kind: "unchanged-approved" } : { ok: false, code: "approved-head-not-landed" };
  if (input.after === input.approvedHead) return input.beforeIsAncestor ? { ok: true, kind: "fast-forward" } : { ok: false, code: "external-before" };
  return input.parents.length === 2 && input.parents[0] === input.before && input.parents[1] === input.approvedHead ? { ok: true, kind: "merge" } : { ok: false, code: "unauthorized-base-transition" };
}

export function batchChildFailureCanContinue(finishOk: boolean, before: string, after: string): boolean {
  return !finishOk && before === after;
}

export type SessionLandCleanPreflightContext = {
  readonly repoRoot: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly input: Record<string, unknown>;
  readonly session: GuardianSession;
  readonly config: GuardianConfig;
};

type SessionLandCleanPreflightOptions = {
  readonly refreshRemote?: boolean;
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function sessionLandCleanPreflight(context: SessionLandCleanPreflightContext, options: SessionLandCleanPreflightOptions = {}): Promise<LandCleanPreflight> {
  const branch = typeof context.session.branch === "string" && context.session.branch.length > 0 ? context.session.branch : null;
  if (!branch) return { ok: false, status: "blocked", reason: "Guardian session has no recorded branch to land", sessionId: context.sessionId };
  const remote = context.config.remote;
  const baseBranch = context.config.baseBranch;
  const baseRef = `${remote}/${baseBranch}`;
  let baseAuthorityRef: string;
  let remoteBranchRef: string;
  try {
    baseAuthorityRef = configuredRemoteAuthority(context.config).authorityRef;
    remoteBranchRef = remoteTrackingRef(remote, branch);
  } catch (error) {
    return { ok: false, status: "blocked", reason: "remote base or session branch ref is invalid", sessionId: context.sessionId, remote, baseBranch, baseRef, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    await runGit(context.cwd, ["check-ref-format", `refs/heads/${branch}`]);
  } catch (error) {
    return { ok: false, status: "blocked", reason: "Guardian session branch is invalid", sessionId: context.sessionId, branch, error: error instanceof Error ? error.message : String(error) };
  }
  const symbolicTarget = await getSymbolicRefTarget(context.repoRoot, `refs/heads/${branch}`);
  if (symbolicTarget) return { ok: false, status: "blocked", reason: "Guardian session branch is symbolic", sessionId: context.sessionId, branch, symbolicTarget };
  const liveBranch = await getCurrentBranch(context.cwd);
  if (liveBranch !== branch) return { ok: false, status: "blocked", reason: "live worktree branch mismatch", sessionId: context.sessionId, branch, liveBranch };
  const worktreePath = typeof context.session.worktree_path === "string" ? context.session.worktree_path : context.cwd;
  const head = await getHeadCommit(context.cwd);
  let inspection;
  try {
    inspection = await inspectDirtySessionDoneIntent({ cwd: context.cwd, worktreePath });
  } catch (error) {
    if (error instanceof DoneIntentBuildError) {
      return { ok: false, status: "blocked", reason: "remote base ref could not be fetched or resolved", sessionId: context.sessionId, remote, baseBranch, baseRef, error: error.message };
    }
    throw error;
  }
  const snapshot = inspection.snapshot;
  const dirtyFiles = inspection.commitPaths;
  if (dirtyFiles.length > 0) {
    let policyBlocker: string | null;
    try {
      policyBlocker = await dirtyCommitPolicyBlocker(context.cwd, dirtyFiles);
    } catch (error) {
      return { ok: false, status: "blocked", reason: "Guardian commit policy could not be resolved", sessionId: context.sessionId, branch, error: error instanceof Error ? error.message : String(error) };
    }
    if (policyBlocker) return { ok: false, status: "blocked", reason: policyBlocker, sessionId: context.sessionId, branch };
  }
  // Only build the candidate tree (which stages and hashes dirty file content, invoking any
  // configured clean filter) after the commit-policy check above has already approved proceeding.
  let intent;
  try {
    intent = await buildDirtySessionDoneIntentFromInspection({ cwd: context.cwd, inspection });
  } catch (error) {
    if (error instanceof DoneIntentBuildError) {
      return { ok: false, status: "blocked", reason: "commit candidate tree could not be resolved", sessionId: context.sessionId, error: error.message };
    }
    throw error;
  }
  const stashes = await listStashes(context.repoRoot);
  try {
    if (intent.ignoredFiles.length > 0 && context.input.allowIgnoredFiles !== true) {
      return { ok: false, status: "blocked", reason: "worktree has ignored files", sessionId: context.sessionId, branch, ignoredFiles: intent.ignoredFiles, ignoredFileFingerprint: intent.ignoredFileFingerprint };
    }
    if (options.refreshRemote !== false) await fetchRemote(context.repoRoot, remote);
    const baseRefOid = await getRefCommit(context.repoRoot, baseAuthorityRef);
    const remoteBranch = await tryGit(context.repoRoot, ["rev-parse", "--verify", `${remoteBranchRef}^{commit}`]);
    const stamp = context.input.timestamp ?? context.session.created_at ?? context.sessionId;
    return { ok: true, branch, worktreePath, head, dirtyFiles, snapshot, stashCount: stashes.length, stashes, remote, baseBranch, baseRef, baseRefOid, remoteBranchOid: remoteBranch.ok ? remoteBranch.stdout : null, safetyRef: buildSafetyRef(context.sessionId, `commit/${branch}`, stamp), ignoredFiles: intent.ignoredFiles, ignoredFileFingerprint: intent.ignoredFileFingerprint, sourceIndexTree: intent.sourceIndexTree, candidateTree: intent.candidateTree };
  } catch (error) {
    return { ok: false, status: "blocked", reason: "remote base ref could not be fetched or resolved", sessionId: context.sessionId, remote, baseBranch, baseRef, error: error instanceof Error ? error.message : String(error) };
  }
}

export function sessionLandCleanCommitMessage(input: Record<string, unknown>): string {
  if (typeof input.commitMessage === "string") {
    return input.commitMessage.trim();
  }
  return "";
}

export function createSessionLandCleanConfirmToken(input: SessionLandCleanTokenInput): string {
  const material = {
    action: input.action,
    repoRoot: input.context.repoRoot,
    worktreePath: input.preflight.worktreePath,
    sessionId: input.context.sessionId,
    branch: input.preflight.branch,
    head: input.preflight.head,
    dirtyFiles: [...input.preflight.dirtyFiles].sort(compareText),
    dirtyEntries: input.preflight.snapshot.entries
      .map((entry) => ({ status: entry.status, path: entry.path, ...(entry.sourcePath ? { sourcePath: entry.sourcePath } : {}) }))
      .sort((left, right) => `${left.status}\0${left.path}\0${left.sourcePath ?? ""}` < `${right.status}\0${right.path}\0${right.sourcePath ?? ""}` ? -1 : `${left.status}\0${left.path}\0${left.sourcePath ?? ""}` > `${right.status}\0${right.path}\0${right.sourcePath ?? ""}` ? 1 : 0),
    dirtyFingerprints: input.preflight.snapshot.fingerprints
      .map((fingerprint) => ({ path: fingerprint.path, kind: fingerprint.kind, size: fingerprint.size, hash: fingerprint.hash }))
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0),
    commitMessage: input.commitMessage,
    allowIgnoredFiles: input.context.input.allowIgnoredFiles === true,
    allowAdminBypass: input.context.input.allowAdminBypass === true,
    remote: input.preflight.remote,
    baseBranch: input.preflight.baseBranch,
    baseRef: input.preflight.baseRef,
    baseRefOid: input.preflight.baseRefOid,
    remoteBranchOid: input.preflight.remoteBranchOid,
    safetyRef: input.preflight.safetyRef,
    ignoredFiles: [...input.preflight.ignoredFiles].sort(compareText),
    ignoredFileFingerprint: input.preflight.ignoredFileFingerprint,
    sourceIndexTree: input.preflight.sourceIndexTree,
    candidateTree: input.preflight.candidateTree,
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

export function deriveBatchExecutionToken(input: SessionLandCleanTokenInput, authorization: BatchLandAuthorization): { readonly ok: true; readonly token: string } | { readonly ok: false; readonly code: "authorized-base-mismatch" | "original-token-mismatch" } {
  if (input.preflight.baseRefOid !== authorization.authorizedBaseRefOid) return { ok: false, code: "authorized-base-mismatch" };
  const originalToken = createSessionLandCleanConfirmToken({ ...input, preflight: { ...input.preflight, baseRefOid: authorization.originalBaseRefOid } });
  if (originalToken !== authorization.originalConfirmToken) return { ok: false, code: "original-token-mismatch" };
  return { ok: true, token: createSessionLandCleanConfirmToken(input) };
}
