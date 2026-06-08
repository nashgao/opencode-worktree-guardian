import fs from "node:fs/promises";
import path from "node:path";
import { expandWorktreeRoot, loadConfig } from "./config.ts";
import { getCommonGitDir, getDirtyFiles, getRepoRoot, listBranches, listRecoveryCandidates, listRefs, listStashes, listWorktrees } from "./git.ts";
import { scanWorkspaceHygiene } from "./hygiene.ts";
import { isActiveSession, isTerminalSession } from "./lifecycle.ts";
import { getGuardianPaths, readState } from "./state.ts";

async function pathExists(candidate: string) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function isInside(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isTempPath(candidate: string) {
  const normalized = path.resolve(candidate);
  return path.basename(normalized).startsWith("opencode-") || normalized.includes(path.sep + "opencode" + path.sep) || normalized.includes(path.sep + "var" + path.sep + "folders" + path.sep) || normalized.startsWith(path.resolve("/private/tmp")) || normalized.startsWith(path.resolve("/tmp"));
}

async function annotateWorktreeWithoutState(worktree: Record<string, any>, repoRoot: string, config: Record<string, any>) {
  const worktreePath = path.resolve(worktree.path);
  const guardianRoot = path.resolve(repoRoot, expandWorktreeRoot(config.worktreeRoot, repoRoot));
  if (isInside(worktreePath, guardianRoot)) return worktree;

  const metadata: Record<string, any> = { guardianRoot };
  try {
    metadata.commonGitDir = await getCommonGitDir(worktreePath);
  } catch (error: any) {
    metadata.commonGitDirError = error.message;
  }

  return {
    ...worktree,
    category: isTempPath(worktreePath) ? "external-temp-worktree" : "external-worktree",
    severity: "fail",
    reason: "linked Git worktree is outside Guardian ownership and outside the configured Guardian worktree root",
    metadata,
  };
}

function poisonedSessionReason(session: Record<string, any>, repoRoot: string, config: Record<string, any>) {
  const reasons = [];
  if (typeof session.worktree_path === "string" && path.resolve(session.worktree_path) === path.resolve(repoRoot)) {
    reasons.push("active session is recorded on the primary repository worktree");
  }
  if (typeof session.branch === "string" && Array.isArray(config.protectedBranches) && config.protectedBranches.includes(session.branch)) {
    reasons.push("active session branch is protected");
  }
  return reasons.join("; ");
}

function annotatePoisonedSession(session: Record<string, any>, repoRoot: string, config: Record<string, any>) {
  const reason = poisonedSessionReason(session, repoRoot, config);
  if (!reason) return null;
  return {
    ...session,
    severity: "fail",
    reason,
    suggestedCommand: "guardian_start createWorktree=true",
  };
}

export async function guardianStatus(input: Record<string, any> = {}): Promise<Record<string, any>> {
  const repoRoot = input.repoRoot ?? await getRepoRoot(input.cwd ?? process.cwd());
  const { config } = input.config ? { config: input.config } : await loadConfig(repoRoot);
  const paths = await getGuardianPaths(repoRoot);
  const state = await readState(paths, { repoRoot, config });
  const worktrees = await listWorktrees(repoRoot);
  const worktreePaths = new Set(worktrees.map((entry) => path.resolve(entry.path)));
  const sessions = Object.values(state.sessions ?? {}) as Record<string, any>[];
  const activeSessions = sessions.filter(isActiveSession);
  const terminalSessions = sessions.filter(isTerminalSession);
  const sessionWorktreePaths = new Set(activeSessions.map((session) => session.worktree_path).filter(Boolean).map((entry) => path.resolve(entry)));
  const sessionBranches = new Set(activeSessions.map((session) => session.branch).filter(Boolean));
  const orphanedSessions = [];
  const poisonedSessions = [];

  for (const session of activeSessions) {
    if (!session.worktree_path || !worktreePaths.has(path.resolve(session.worktree_path)) || !(await pathExists(session.worktree_path))) {
      orphanedSessions.push(session);
    }
    const poisonedSession = annotatePoisonedSession(session, repoRoot, config);
    if (poisonedSession) poisonedSessions.push(poisonedSession);
  }

  const branches = await listBranches(repoRoot);
  const branchesWithoutWorktrees = branches.filter((branch: Record<string, any>) => !worktrees.some((worktree) => worktree.branch === branch.name));
  const worktreesWithoutState = await Promise.all(worktrees
    .filter((worktree) => !sessionWorktreePaths.has(path.resolve(worktree.path)))
    .map((worktree) => annotateWorktreeWithoutState(worktree, repoRoot, config)));
  const stateBranchesWithoutWorktrees = [...sessionBranches].filter((branch) => !worktrees.some((worktree) => worktree.branch === branch));

  return {
    repoRoot,
    config,
    stateVersion: state.state_version,
    sessions,
    activeSessions,
    terminalSessions,
    orphanedSessions,
    poisonedSessions,
    worktrees,
    branchesWithoutWorktrees,
    worktreesWithoutState,
    stateBranchesWithoutWorktrees,
    safetyRefs: await listRefs(repoRoot, "refs/opencode-guardian"),
    preservedRefs: await listRefs(repoRoot, "refs/opencode-guardian/preserved"),
    stashes: await listStashes(repoRoot),
    dirtyFiles: await getDirtyFiles(repoRoot),
    hygiene: await scanWorkspaceHygiene({ repoRoot, cwd: input.cwd, config }),
    suggestedCommands: ["guardian_status", "guardian_recover"],
  };
}

export async function guardianRecover(input: Record<string, any> = {}): Promise<Record<string, any>> {
  const status = await guardianStatus(input);
  const candidates = await listRecoveryCandidates(status.repoRoot);
  return {
    ...status,
    recoveryCandidates: candidates,
    suggestedCommands: [
      ...status.suggestedCommands,
      ...status.safetyRefs.map((ref: Record<string, any>) => `git branch recovery/<name> ${ref.commit}`),
      ...status.stashes.map((stash: Record<string, any>) => `git stash show -p ${stash.name}`),
    ],
  };
}
