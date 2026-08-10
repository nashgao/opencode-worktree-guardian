import crypto from "node:crypto";
import path from "node:path";
import { createSafetyRef, fetchRemote, getCurrentBranch, getHeadCommit, getRefCommit, getRepoRoot, isAncestor, listStashes, runGit, validateConfiguredRemote, validateGitRef } from "./git.ts";
import { configuredRemoteAuthority, isTrustedRemoteNamespaceOverlapError } from "./git-authority.ts";
import { finalPostflightCommitsFromCleanupSweep, runCleanupSweep } from "./done-cleanup-sweep.ts";
import { normalizeAllowedRemoteBranches, runFinalCleanupPostflight } from "./final-postflight.ts";
import { hasBlockingStashInventory } from "./stash-policy.ts";
import type { GuardianConfig, MutableRecord } from "./types.ts";
import type { DirtySnapshot } from "./done-primary-snapshot.ts";
import { dirtySnapshot } from "./done-primary-snapshot.ts";
import { blocked, errorMessage, samePath, text } from "./done-shared.ts";

type PrimaryPreflightResult =
  | { readonly ok: false; readonly preflight: MutableRecord; readonly result: MutableRecord }
  | { readonly ok: true; readonly preflight: MutableRecord; readonly snapshot: DirtySnapshot; readonly commitMessage: string; readonly confirmToken: string };

type RemoteRefresh = "required" | "forbidden";

export function createPrimaryToken(preflight: Record<string, unknown>, snapshot: Record<string, unknown>, commitMessage: string): string {
  const material = {
    repoRoot: preflight.repoRoot,
    branch: preflight.currentBranch,
    head: preflight.head,
    baseRef: preflight.baseRef,
    baseRefOid: preflight.baseRefOid,
    commitMessage,
    snapshot,
    allowedRemoteBranches: normalizeAllowedRemoteBranches(preflight.allowedRemoteBranches),
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

export async function primaryPreflight(repoRoot: string, cwd: string, config: GuardianConfig, input: Record<string, unknown>, remoteRefresh: RemoteRefresh = "required"): Promise<PrimaryPreflightResult> {
  const currentWorktree = await getRepoRoot(cwd);
  const branch = await getCurrentBranch(currentWorktree);
  const baseRef = `${String(config.remote)}/${String(config.baseBranch)}`;
  const preflight: MutableRecord = {
    repoRoot: path.resolve(repoRoot),
    currentWorktree,
    currentBranch: branch,
    baseBranch: config.baseBranch,
    remote: config.remote,
    baseRef,
    baseRefOid: null,
    baseRefFetched: false,
    remoteRefresh,
    remoteFreshness: remoteRefresh === "required" ? "verified" : "unverified",
    head: null,
    branchProtected: Array.isArray(config.protectedBranches) && typeof branch === "string" ? config.protectedBranches.includes(branch) : false,
    stashCount: 0,
    dirtyFileCount: 0,
    dirtyFiles: [],
    blockers: [],
  };
  preflight.allowedRemoteBranches = normalizeAllowedRemoteBranches(input.allowedRemoteBranches);
  let baseAuthorityRef: string;
  try {
    baseAuthorityRef = configuredRemoteAuthority(config).authorityRef;
  } catch (error) {
    if (!isTrustedRemoteNamespaceOverlapError(error)) throw error;
    if (!(error instanceof Error)) throw error;
    return { ok: false, preflight, result: blocked("configured remote authority is invalid", { baseRef, error: errorMessage(error) }, preflight) };
  }

  if (!samePath(currentWorktree, repoRoot)) return { ok: false, preflight, result: blocked("primary-main publish requires the primary repository worktree", { currentWorktree, repoRoot }, preflight) };
  if (!branch) return { ok: false, preflight, result: blocked("detached HEAD cannot be published by guardian_done", {}, preflight) };
  if (branch !== config.baseBranch) return { ok: false, preflight, result: blocked("primary-main publish requires the configured base branch", { branch, baseBranch: config.baseBranch }, preflight) };
  if (!preflight.branchProtected) return { ok: false, preflight, result: blocked("primary-main publish lane requires a protected base branch", { branch }, preflight) };

  try {
    if (remoteRefresh === "required") {
      await fetchRemote(repoRoot, String(config.remote));
      preflight.baseRefFetched = true;
    }
    preflight.baseRefOid = await getRefCommit(repoRoot, baseAuthorityRef);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { ok: false, preflight, result: blocked(remoteRefresh === "required" ? "remote base ref could not be fetched or resolved" : "local remote-tracking base ref could not be resolved without refresh", { baseRef, error: errorMessage(error) }, preflight) };
  }

  const head = await getHeadCommit(repoRoot);
  preflight.head = head;

  const stashes = await listStashes(repoRoot);
  preflight.stashCount = stashes.length;
  preflight.stashes = stashes;
  if (hasBlockingStashInventory(config, stashes)) return { ok: false, preflight, result: blocked("stash inventory is non-empty", { stashes }, preflight) };

  const snapshot = await dirtySnapshot(repoRoot, config, { optionalLocksDisabled: remoteRefresh === "forbidden" });
  preflight.dirtyFiles = snapshot.paths;
  preflight.dirtyFileCount = snapshot.paths.length;
  if (snapshot.paths.length === 0) return { ok: false, preflight, result: blocked("primary-main publish requires dirty implemented code; use cleanup-only lane instead", {}, preflight) };

  const commitMessage = text(input.commitMessage).trim();
  if (!commitMessage) return { ok: false, preflight, result: blocked("commitMessage is required for primary-main publish", { dirtyFiles: snapshot.paths }, preflight) };

  const confirmToken = createPrimaryToken(preflight, snapshot, commitMessage);
  return { ok: true, preflight, snapshot, commitMessage, confirmToken };
}

function baseSyncBlocker(preflight: MutableRecord): MutableRecord | null {
  if (preflight.head === preflight.baseRefOid) return null;
  return blocked("primary base branch is not synced to remote; sync before publishing dirty primary work", { head: preflight.head, baseRefOid: preflight.baseRefOid }, preflight);
}

export async function primaryMainDone(repoRoot: string, cwd: string, config: GuardianConfig, input: Record<string, unknown>): Promise<MutableRecord> {
  const mode = input.mode ?? "plan";
  if (mode !== "plan" && mode !== "apply") return blocked("mode must be plan or apply", { mode });
  const confirmationRequired = mode === "apply" && input.confirm !== true;
  const planned = await primaryPreflight(repoRoot, cwd, config, input, confirmationRequired ? "forbidden" : "required");
  if (!planned.ok) return planned.result;
  const { preflight, snapshot, commitMessage, confirmToken } = planned;
  const plan = {
    ok: true,
    status: "planned",
    lane: "primary-main-publish",
    confirmToken,
    commitMessage,
    preflight,
    dirtySnapshot: snapshot,
    remoteRefresh: "required",
    nextAction: "After explicit user confirmation, apply with confirm=true and the same commitMessage to create a safety ref, commit the token-bound dirty files, push the base branch, fetch, and return a fresh cleanup plan.",
  };
  if (mode === "plan") {
    const syncBlocker = baseSyncBlocker(preflight);
    return syncBlocker ?? plan;
  }
  if (confirmationRequired) {
    if (input.confirmToken !== confirmToken) return blocked("plan changed; rerun plan and review the updated dirty files before applying", { tokenMatched: false, remoteRefresh: "forbidden", remoteFreshness: "unverified" }, preflight);
    return blocked("primary-main publish apply requires confirm=true", { tokenMatched: true, confirmationRequired: true, remoteRefresh: "forbidden", remoteFreshness: "unverified", nextAction: "guardian_done mode=apply confirm=true" }, preflight);
  }
  if (input.confirmToken !== confirmToken) return blocked("plan changed; rerun plan and review the updated dirty files before applying", { tokenMatched: false, driftDetected: true, plannedConfirmToken: input.confirmToken, refreshedConfirmToken: confirmToken, remoteRefresh: "required", remoteFreshness: "verified" }, preflight);
  const syncBlocker = baseSyncBlocker(preflight);
  if (syncBlocker) return syncBlocker;

  const branch = String(preflight.currentBranch);
  const head = String(preflight.head);
  const safetySessionId = typeof input.sessionId === "string" && input.sessionId.length > 0 ? input.sessionId : "primary-main";
  const safetyRef = await createSafetyRef(repoRoot, { sessionId: safetySessionId, branch, commit: head, timestamp: input.timestamp });
  preflight.safetyRef = safetyRef;
  const dirtyPaths = snapshot.paths;
  const snapshotEntries = snapshot.entries;
  const missingPaths = new Set(snapshot.fingerprints.filter((fingerprint) => fingerprint.kind === "missing").map((fingerprint) => fingerprint.path));
  const unstagedDeletedPaths = new Set(snapshotEntries.filter((entry) => entry.status[1] === "D").flatMap((entry) => [entry.path, entry.sourcePath].filter((value): value is string => typeof value === "string")));
  const stageablePaths = dirtyPaths.filter((dirtyPath) => !missingPaths.has(dirtyPath) || unstagedDeletedPaths.has(dirtyPath));
  try {
    if (stageablePaths.length > 0) await runGit(repoRoot, ["add", "--all", "--", ...stageablePaths]);
    await runGit(repoRoot, ["commit", "-m", commitMessage]);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return blocked("commit failed", { safetyRef, error: errorMessage(error) }, preflight);
  }

  const commit = await getHeadCommit(repoRoot);
  try {
    await validateConfiguredRemote(repoRoot, String(config.remote));
    validateGitRef(branch);
    await runGit(repoRoot, ["push", String(config.remote), branch]);
    await fetchRemote(repoRoot, String(config.remote));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return blocked("push failed after commit; safety ref preserves the pre-commit head", { safetyRef, commit, error: errorMessage(error) }, preflight);
  }

  const proven = await isAncestor(repoRoot, commit, configuredRemoteAuthority(config).authorityRef);
  if (!proven) return blocked("published commit is not proven reachable from remote base", { safetyRef, commit }, preflight);
  const cleanupSweep = await runCleanupSweep(repoRoot, config, input);
  if (cleanupSweep.freshPlanRequired === true) return { ok: false, status: "partial", reason: "published, but reservation retirement requires a fresh cleanup plan", lane: "primary-main-publish", branch, commit, safetyRef, preflight, cleanupSweep, freshPlanRequired: true };
  const finalPostflight = await runFinalCleanupPostflight({ repoRoot, config, requiredCommits: [{ commit, source: branch, reason: "published primary-main commit must be present on final base" }, ...finalPostflightCommitsFromCleanupSweep(cleanupSweep)], allowedRemoteBranches: preflight.allowedRemoteBranches });
  const ok = cleanupSweep.ok !== false && finalPostflight.ok === true;
  return { ok, status: ok ? "published" : "partial", ...(ok ? {} : { reason: finalPostflight.ok === false ? "published, but final cleanup postflight failed" : "published, but post-publish cleanup has remaining blockers" }), lane: "primary-main-publish", branch, commit, safetyRef, preflight, cleanupSweep, finalPostflight };
}
