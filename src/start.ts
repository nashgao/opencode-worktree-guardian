import fs from "node:fs/promises";
import path from "node:path";
import { expandWorktreeRoot } from "./config.ts";
import { getCurrentBranch, getHeadCommit, getRepoRoot, runGit } from "./git.ts";
import { isTerminalSession } from "./lifecycle.ts";
import { getGuardianPaths, readState, recordSession } from "./state.ts";
import type { GuardianSession, GuardianToolInput, GuardianToolResult, MutableRecord } from "./types.ts";
import { errorCode, isRecordLike } from "./types.ts";
import { configFromInput, sessionIdFromInput } from "./session/context.ts";
import { protectedBranchReason, validateOwnedSession } from "./session/worktree-binding.ts";

async function safeRealpath(candidate: string) {
  try {
    return await fs.realpath(candidate);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return path.resolve(candidate);
  }
}

function isSameOrInside(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
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

async function resolveWorktreeTarget(repoRoot: string, config: Awaited<ReturnType<typeof configFromInput>>, requestedPath: string | undefined, branchName: string) {
  const root = path.resolve(repoRoot, expandWorktreeRoot(config.worktreeRoot, repoRoot));
  await fs.mkdir(root, { recursive: true });
  const resolvedRoot = await safeRealpath(root);
  const target = requestedPath ? path.resolve(repoRoot, requestedPath) : path.join(resolvedRoot, slug(branchName));
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const resolvedParent = await safeRealpath(parent);
  const resolvedTarget = path.join(resolvedParent, path.basename(target));
  if (!isSameOrInside(resolvedTarget, resolvedRoot)) {
    throw new Error(`worktreePath must stay inside configured worktreeRoot: ${config.worktreeRoot}`);
  }
  return resolvedTarget;
}

function slug(value: unknown) {
  return String(value ?? "work")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "work";
}

async function createSessionWorktree(repoRoot: string, config: Awaited<ReturnType<typeof configFromInput>>, input: GuardianToolInput, sessionId: string): Promise<CreateSessionWorktreeResult> {
  const branchName = typeof input.branch === "string" ? input.branch : `${config.branchPrefix}${slug(input.taskName)}-${slug(sessionId).slice(0, 8)}`;
  const unsafeReason = protectedBranchReason(config, branchName);
  if (unsafeReason) return { ok: false, status: "blocked", reason: unsafeReason, branch: branchName };
  const worktreePath = await resolveWorktreeTarget(repoRoot, config, typeof input.worktreePath === "string" ? input.worktreePath : undefined, branchName);
  await runGit(repoRoot, ["worktree", "add", "-b", branchName, worktreePath, `${config.remote}/${config.baseBranch}`]);
  return { ok: true, branch: branchName, worktreePath };
}

export function guardianStart(input?: GuardianToolInput): Promise<GuardianStartResult>;
export async function guardianStart(input: GuardianToolInput = {}): Promise<GuardianToolResult> {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const config = await configFromInput(input, repoRoot);
  const sessionId = sessionIdFromInput(input);
  if (!sessionId) throw new Error("sessionId is required");
  const guardianPaths = await getGuardianPaths(repoRoot);
  const state = await readState(guardianPaths, { repoRoot, config });
  const rawExisting = state.sessions?.[sessionId];
  const existing = isRecordLike(rawExisting) ? rawExisting : undefined;
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
    if (binding.ok) return { ok: true, session: existing, stateVersion: state.state_version, existing: true };
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
    const created = await createSessionWorktree(repoRoot, config, input, sessionId);
    if (!created.ok) return { ...created, session: existing, stateVersion: state.state_version, previous };
    const headCommit = await getHeadCommit(created.worktreePath);
    const repairedSession = {
      ...existing,
      session_id: sessionId,
      status: "active",
      branch: created.branch,
      worktree_path: created.worktreePath,
      base_ref: `${config.remote}/${config.baseBranch}`,
      head_commit: headCommit,
      safety_refs: Array.isArray(existing.safety_refs) ? existing.safety_refs.filter((value): value is string => typeof value === "string") : [],
    };
    const repairedState = await recordSession(repoRoot, config, repairedSession, { event: { type: "guardian_start_repair", session_id: sessionId, reason: binding.reason } });
    const recordedSession = repairedState.sessions[sessionId];
    if (!recordedSession) throw new Error(`guardian_start repair failed to record session ${sessionId}`);
    return { ok: true, session: recordedSession, stateVersion: repairedState.state_version, existing: false, repaired: true, previous };
  }

  let worktreePath = await getRepoRoot(cwd);
  let branch = await getCurrentBranch(worktreePath);

  if (input.createWorktree === true) {
    const created = await createSessionWorktree(repoRoot, config, input, sessionId);
    if (!created.ok) return { ...created, stateVersion: state.state_version };
    worktreePath = created.worktreePath;
    branch = created.branch;
  }

  if (!branch) throw new Error("Cannot start guardian session from detached HEAD");
  if (input.createWorktree !== true && path.resolve(worktreePath) === path.resolve(repoRoot)) {
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
  const session = {
    session_id: sessionId,
    status: "active",
    branch,
    worktree_path: worktreePath,
    base_ref: `${config.remote}/${config.baseBranch}`,
    head_commit: headCommit,
    safety_refs: [],
  };

  const recordedState = await recordSession(repoRoot, config, session, { event: { type: "guardian_start", session_id: sessionId } });
  return { ok: true, session: recordedState.sessions[sessionId], stateVersion: recordedState.state_version };
}
