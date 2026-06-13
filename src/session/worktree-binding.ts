import path from "node:path";
import { expandWorktreeRoot } from "../config.ts";
import { getCurrentBranch, getRepoRoot, listWorktrees } from "../git.ts";
import { isTerminalSession } from "../lifecycle.ts";
import { getGuardianPaths, readState } from "../state.ts";
import type { GuardianConfig, GuardianToolInput, MutableRecord, SessionWorktreeResult, WorktreeEntry } from "../types.ts";
import { isRecordLike } from "../types.ts";
import { configFromInput, sessionIdFromInput, stateFromInput, worktreeCache } from "./context.ts";

function isSameOrInside(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function collectKnownWorktreePaths(input: GuardianToolInput = {}): Promise<string[]> {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const config = await configFromInput(input, repoRoot);
  const paths = new Set<string>();
  if (typeof input.currentWorktree === "string") paths.add(path.resolve(input.currentWorktree));
  try {
    const worktreeRoot = path.resolve(repoRoot, expandWorktreeRoot(config.worktreeRoot, repoRoot));
    paths.add(worktreeRoot);
  } catch {}
  try {
    for (const entry of await listWorktrees(repoRoot)) paths.add(path.resolve(entry.path));
  } catch {}
  try {
    const guardianPaths = await getGuardianPaths(repoRoot);
    const state = await readState(guardianPaths, { repoRoot, config });
    const sessions = Object.values(state.sessions ?? {});
    for (const session of sessions) {
      if (isRecordLike(session) && typeof session.worktree_path === "string") paths.add(path.resolve(session.worktree_path));
    }
  } catch {}
  return [...paths];
}

function matchesWorktree(expectedWorktree: string, actualPath: string) {
  return isSameOrInside(path.resolve(actualPath), path.resolve(expectedWorktree));
}

function samePath(left: string, right: string) {
  return path.resolve(left) === path.resolve(right);
}

async function validateRecordedBinding(repoRoot: string, config: GuardianConfig, session: MutableRecord, actualWorktree: string) {
  const expectedWorktree = session.worktree_path;
  if (typeof expectedWorktree !== "string") return { ok: false, reason: "recorded session has no worktree path" };
  if (!matchesWorktree(expectedWorktree, actualWorktree)) return { ok: false, reason: "session worktree path does not match actual worktree" };
  const entries = await listWorktrees(repoRoot);
  const matches = entries.filter((entry: WorktreeEntry) => samePath(entry.path, expectedWorktree));
  if (matches.length !== 1) return { ok: false, reason: matches.length > 1 ? "recorded worktree path matches multiple git worktrees" : "recorded worktree is not checked out in git worktree list" };
  const entry = matches[0];
  if (!entry) return { ok: false, reason: "recorded worktree is not checked out in git worktree list" };
  if (entry.detached || !entry.branch) return { ok: false, reason: "recorded worktree is detached" };
  if (typeof session.branch === "string" && entry.branch !== session.branch) return { ok: false, reason: "recorded branch does not match checked-out worktree branch" };
  if (Array.isArray(config.protectedBranches) && config.protectedBranches.includes(entry.branch)) return { ok: false, reason: "recorded worktree branch is protected" };
  if (samePath(entry.path, repoRoot)) return { ok: false, reason: "recorded worktree is the primary repository worktree" };
  return { ok: true, branch: entry.branch };
}

export async function validateOwnedSession(repoRoot: string, config: GuardianConfig, session: MutableRecord) {
  if (typeof session.worktree_path !== "string") return { ok: false, reason: "recorded session has no worktree path" };
  return validateRecordedBinding(repoRoot, config, session, session.worktree_path);
}

export function protectedBranchReason(config: GuardianConfig, branch: string | null) {
  if (!branch) return "detached HEAD cannot be recorded by guardian";
  return Array.isArray(config.protectedBranches) && config.protectedBranches.includes(branch)
    ? "protected branches cannot be recorded as Guardian-owned worktrees"
    : null;
}

export async function resolveSessionWorktree(input: GuardianToolInput = {}): Promise<SessionWorktreeResult> {
  const sessionId = sessionIdFromInput(input);
  if (!sessionId) return { ok: true, sessionId: null, expectedWorktree: null, actualWorktree: null, matches: true };

  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const actualWorktree = typeof input.actualWorktree === "string" ? input.actualWorktree : await getRepoRoot(cwd);
  const cache = worktreeCache(input.cache);
  const validateBinding = input.validateBinding === true;
  const cachedWorktree = cache?.get(sessionId);

  if (typeof cachedWorktree === "string" && !validateBinding) {
    const matches = matchesWorktree(cachedWorktree, actualWorktree);
    return {
      ok: matches,
      sessionId,
      expectedWorktree: cachedWorktree,
      actualWorktree,
      matches,
      source: "cache",
    };
  }

  const config = await configFromInput(input, repoRoot);
  const state = stateFromInput(input.state) ?? await readState(await getGuardianPaths(repoRoot), { repoRoot, config });
  const rawSession = state.sessions?.[sessionId];
  const session = isRecordLike(rawSession) ? rawSession : undefined;
  if (session && isTerminalSession(session)) {
    return { ok: true, sessionId, expectedWorktree: null, actualWorktree, matches: true, source: "terminal-state", terminal: true, status: typeof session.status === "string" ? session.status : undefined };
  }
  const expectedWorktree = typeof session?.worktree_path === "string" ? session.worktree_path : null;
  if (!session || !expectedWorktree) {
    return { ok: true, sessionId, expectedWorktree: null, actualWorktree, matches: true, source: "state" };
  }

  cache?.set(sessionId, expectedWorktree);
  const matches = matchesWorktree(expectedWorktree, actualWorktree);
  if (matches && validateBinding) {
    const binding = await validateRecordedBinding(repoRoot, config, session, actualWorktree);
    if (!binding.ok) {
      return {
        ok: false,
        reason: binding.reason,
        sessionId,
        expectedWorktree,
        actualWorktree,
        matches: false,
        source: "state",
      };
    }
  }
  return {
    ok: matches,
    sessionId,
    expectedWorktree,
    actualWorktree,
    matches,
    source: "state",
  };
}

export async function currentWorktreeBranch(cwd: string) {
  const worktreePath = await getRepoRoot(cwd);
  const branch = await getCurrentBranch(worktreePath);
  return { worktreePath, branch };
}
