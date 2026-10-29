import fs from "node:fs/promises";
import path from "node:path";
import { expandWorktreeRoot } from "./config.ts";
import { samePathOnDisk } from "./done-shared.ts";
import { getCommonGitDir, getCurrentBranch, getHeadCommit, getRepoRoot, runGit, validateConfiguredRemote, validateGitRef } from "./git.ts";
import { configuredRemoteAuthority, isTrustedRemoteNamespaceOverlapError } from "./git-authority.ts";
import { isTerminalSession } from "./lifecycle.ts";
import { applyRecordedSession, getGuardianPaths, readState, updateStateLocked, withStateTransaction } from "./state.ts";
import { captureStartProvenance, ineligibleSessionProvenance, isProvenanceEnabled, verifyStartProvenance } from "./session-provenance.ts";
import type { GuardianConfig, GuardianPaths, GuardianSession, GuardianStateRecord, GuardianToolInput, GuardianToolResult, MutableRecord } from "./types.ts";
import { errorCode, hasPendingExternalGoalCompletion, isRecordLike } from "./types.ts";
import { configFromInput, sessionIdFromInput } from "./session/context.ts";
import { protectedBranchReason, validateOwnedSession } from "./session/worktree-binding.ts";

async function safeRealpath(candidate: string): Promise<string> {
  try {
    return await fs.realpath(candidate);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    const parent = path.dirname(candidate);
    if (parent === candidate) throw error;
    return path.join(await safeRealpath(parent), path.basename(candidate));
  }
}

function isSameOrInside(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

type CreateSessionWorktreeResult =
  | { readonly ok: true; readonly branch: string; readonly worktreePath: string }
  | { readonly ok: false; readonly status: "blocked"; readonly reason: string; readonly branch: string };

type GuardianStartTypedSession = GuardianSession & {
  readonly session_id: string;
  readonly branch: string;
  readonly worktree_path: string;
};

export type GuardianStartResult = GuardianToolResult & {
  readonly session: GuardianStartTypedSession;
  readonly previous: MutableRecord & {
    readonly branch: string;
    readonly worktree_path: string;
    readonly reason: string;
  };
  readonly reason: string;
  readonly branch: string;
};

async function resolveWorktreeTarget(repoRoot: string, config: GuardianConfig, requestedPath: string | undefined, branchName: string) {
  const resolvedRoot = await safeRealpath(path.resolve(repoRoot, expandWorktreeRoot(config.worktreeRoot, repoRoot)));
  const target = requestedPath ? path.resolve(repoRoot, requestedPath) : path.join(resolvedRoot, slug(branchName));
  const resolvedParent = await safeRealpath(path.dirname(target));
  const resolvedTarget = path.join(resolvedParent, path.basename(target));
  if (!isSameOrInside(resolvedTarget, resolvedRoot)) {
    throw new Error(`worktreePath must stay inside configured worktreeRoot: ${config.worktreeRoot}`);
  }
  return { root: resolvedRoot, parent: resolvedParent, worktreePath: resolvedTarget };
}

function slug(value: unknown) {
  return String(value ?? "work")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "work";
}

async function createSessionWorktree(repoRoot: string, config: GuardianConfig, input: GuardianToolInput, sessionId: string, state: GuardianStateRecord): Promise<CreateSessionWorktreeResult> {
  const branchName = typeof input.branch === "string" ? input.branch : `${config.branchPrefix}${slug(input.taskName)}-${slug(sessionId).slice(0, 8)}`;
  const unsafeReason = protectedBranchReason(config, branchName);
  if (unsafeReason) return { ok: false, status: "blocked", reason: unsafeReason, branch: branchName };
  validateGitRef(branchName);
  const sessions = Object.values(state.sessions);
  for (const candidate of sessions) {
    if (hasPendingExternalGoalCompletion(candidate) && candidate.branch === branchName) {
      return { ok: false, status: "blocked", reason: "another session's prepared external Goal completion reserves this branch or path", branch: branchName };
    }
  }
  await validateConfiguredRemote(repoRoot, config.remote);
  validateGitRef(config.baseBranch);
  let baseAuthorityRef: string;
  try {
    baseAuthorityRef = configuredRemoteAuthority(config).authorityRef;
  } catch (error) {
    if (!isTrustedRemoteNamespaceOverlapError(error)) throw error;
    return { ok: false, status: "blocked", reason: error instanceof Error ? error.message : String(error), branch: branchName };
  }
  const target = await resolveWorktreeTarget(repoRoot, config, typeof input.worktreePath === "string" ? input.worktreePath : undefined, branchName);
  for (const candidate of sessions) {
    if (!hasPendingExternalGoalCompletion(candidate) || typeof candidate.worktree_path !== "string") continue;
    const reservedPath = await safeRealpath(candidate.worktree_path);
    if (isSameOrInside(target.worktreePath, reservedPath) || isSameOrInside(reservedPath, target.worktreePath)) {
      return { ok: false, status: "blocked", reason: "another session's prepared external Goal completion reserves this worktree path and overlapping targets", branch: branchName };
    }
  }
  await fs.mkdir(target.root, { recursive: true });
  await fs.mkdir(target.parent, { recursive: true });
  await runGit(repoRoot, ["worktree", "add", "-b", branchName, target.worktreePath, baseAuthorityRef]);
  return { ok: true, branch: branchName, worktreePath: target.worktreePath };
}

export function guardianStart(input?: GuardianToolInput): Promise<GuardianStartResult>;
export async function guardianStart(input: GuardianToolInput = {}): Promise<GuardianToolResult> {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const config = await configFromInput(input, repoRoot);
  const sessionId = sessionIdFromInput(input);
  if (!sessionId) throw new Error("sessionId is required");
  const guardianPaths = await getGuardianPaths(repoRoot);
  return withStateTransaction(guardianPaths, () => startLocked(input, cwd, repoRoot, config, sessionId, guardianPaths), { timeoutMs: config.lockTimeoutMs });
}

async function startLocked(input: GuardianToolInput, cwd: string, repoRoot: string, config: GuardianConfig, sessionId: string, guardianPaths: GuardianPaths): Promise<GuardianToolResult> {
  const state = await readState(guardianPaths, { repoRoot, config });
  const rawExisting = state.sessions?.[sessionId];
  const existing = isRecordLike(rawExisting) ? rawExisting : undefined;
  if (existing && hasPendingExternalGoalCompletion(existing)) {
    return { ok: false, status: "blocked", reason: "session has a prepared external Goal completion; reconcile that operation before repairing its baseline", session: existing, stateVersion: state.state_version };
  }
  if (existing && isTerminalSession(existing)) {
    return {
      ok: false,
      status: "blocked",
      reason: `session ${sessionId} is terminal (${String(existing.status)}); start a new session instead of recreating a deleted or finished worktree`,
      session: existing,
      stateVersion: state.state_version,
    };
  }
  if (existing?.status === "active" && typeof existing.worktree_path === "string") {
    const binding = await validateOwnedSession(repoRoot, config, existing);
    if (binding.ok) {
      if (isProvenanceEnabled(config)) {
        const verificationReason = await verifyStartProvenance({ repoRoot, worktreePath: existing.worktree_path, sessionId, session: existing });
        if (verificationReason) return { ok: false, status: "blocked", reason: verificationReason, session: existing, stateVersion: state.state_version };
      }
      return { ok: true, session: existing, stateVersion: state.state_version, existing: true };
    }
    if (input.createWorktree !== true) {
      return {
        ok: false,
        status: "blocked",
        reason: `recorded session cannot be used: ${binding.reason}; rerun guardian_start with createWorktree=true`,
        session: existing,
        stateVersion: state.state_version,
      };
    }
    const previous = { worktree_path: existing.worktree_path, branch: existing.branch, reason: binding.reason };
    try {
      const expected = JSON.stringify(existing);
      const repairedState = await updateStateLocked({ repoRoot, config, paths: guardianPaths, updater: async (current) => {
        const latest = current.sessions[sessionId];
        if (!latest || JSON.stringify(latest) !== expected || hasPendingExternalGoalCompletion(latest) || isTerminalSession(latest)) {
          throw new Error("recorded session changed before repair; reconcile its current operation first");
        }
        if ((await validateOwnedSession(repoRoot, config, latest)).ok) throw new Error("session binding changed before repair; re-run guardian_start");
        const created = await createSessionWorktree(repoRoot, config, input, sessionId, current);
        if (!created.ok) throw new Error(created.reason);
        const headCommit = await getHeadCommit(created.worktreePath);
        return applyRecordedSession(repoRoot, config, current, {
          ...latest,
          session_id: sessionId,
          status: "active",
          branch: created.branch,
          worktree_path: created.worktreePath,
          base_ref: `${config.remote}/${config.baseBranch}`,
          head_commit: headCommit,
          started_head_commit: headCommit,
          safety_refs: Array.isArray(latest.safety_refs) ? latest.safety_refs.filter((value): value is string => typeof value === "string") : [],
          ...ineligibleSessionProvenance(config),
        });
      }, event: { type: "guardian_start_repair", session_id: sessionId, reason: binding.reason } });
      const recordedSession = repairedState.sessions[sessionId];
      if (!recordedSession) throw new Error(`guardian_start repair failed to record session ${sessionId}`);
      return { ok: true, session: recordedSession, stateVersion: repairedState.state_version, existing: false, repaired: true, previous };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { ok: false, status: "blocked", reason: error.message, session: existing, previous };
    }
  }

  let worktreePath = await getRepoRoot(cwd);
  let branch = await getCurrentBranch(worktreePath);

  if (input.createWorktree === true) {
    const created = await createSessionWorktree(repoRoot, config, input, sessionId, state);
    if (!created.ok) return { ...created, stateVersion: state.state_version };
    worktreePath = created.worktreePath;
    branch = created.branch;
  }

  if (!branch) throw new Error("Cannot start guardian session from detached HEAD");
  // State lives at getCommonGitDir(repoRoot); a worktree in a different repo would contaminate the
  // wrong state.json and bypass the repoRoot-keyed primary/protected poison guards. Refuse it.
  const repoCommonDir = await getCommonGitDir(repoRoot);
  const worktreeCommonDir = await getCommonGitDir(worktreePath);
  if (path.resolve(repoCommonDir) !== path.resolve(worktreeCommonDir)) {
    return {
      ok: false,
      status: "blocked",
      reason: `session ${sessionId} worktree ${worktreePath} belongs to a different git repository than repoRoot ${repoRoot}; refusing to record cross-repo session state`,
      branch,
      worktreePath,
      stateVersion: state.state_version,
    };
  }
  if (input.createWorktree !== true && await samePathOnDisk(worktreePath, repoRoot)) {
    return {
      ok: false,
      status: "blocked",
      reason: `session ${sessionId} would be recorded on the primary repository worktree; rerun guardian_start with createWorktree=true`,
      branch,
      worktreePath,
      stateVersion: state.state_version,
    };
  }
  const unsafeReason = input.createWorktree === true ? null : protectedBranchReason(config, branch);
  if (unsafeReason) return { ok: false, status: "blocked", reason: unsafeReason, branch, worktreePath };
  const headCommit = await getHeadCommit(worktreePath);
  const provenance = isProvenanceEnabled(config)
    ? input.createWorktree === true
      ? await captureStartProvenance({ repoRoot, worktreePath, sessionId })
      : { ok: true as const, fields: ineligibleSessionProvenance(config) }
    : { ok: true as const, fields: {} };
  const session = {
    session_id: sessionId,
    status: "active",
    branch,
    worktree_path: worktreePath,
    base_ref: `${config.remote}/${config.baseBranch}`,
    head_commit: headCommit,
    started_head_commit: headCommit,
    safety_refs: [],
    ...provenance.fields,
  };

  const recordedState = await updateStateLocked({ repoRoot, config, paths: guardianPaths, updater: (current) => applyRecordedSession(repoRoot, config, current, session), event: { type: "guardian_start", session_id: sessionId } });
  if (!provenance.ok) {
    return {
      ok: false,
      status: "blocked",
      reason: `provenance capture failed after worktree creation: ${provenance.reason}`,
      session: recordedState.sessions[sessionId],
      stateVersion: recordedState.state_version,
    };
  }
  return { ok: true, session: recordedState.sessions[sessionId], stateVersion: recordedState.state_version };
}
