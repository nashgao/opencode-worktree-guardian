import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { getDirtyFiles, getRepoRoot, listBranches, listRecoveryCandidates, listRefs, listStashes, listWorktrees } from "./git.ts";
import { getGuardianPaths, readState } from "./state.ts";

async function pathExists(candidate: string) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function guardianStatus(input: Record<string, any> = {}): Promise<Record<string, any>> {
  const repoRoot = input.repoRoot ?? await getRepoRoot(input.cwd ?? process.cwd());
  const { config } = input.config ? { config: input.config } : await loadConfig(repoRoot);
  const paths = await getGuardianPaths(repoRoot);
  const state = await readState(paths, { repoRoot, config });
  const worktrees = await listWorktrees(repoRoot);
  const worktreePaths = new Set(worktrees.map((entry) => path.resolve(entry.path)));
  const sessions = Object.values(state.sessions ?? {}) as Record<string, any>[];
  const sessionWorktreePaths = new Set(sessions.map((session) => session.worktree_path).filter(Boolean).map((entry) => path.resolve(entry)));
  const sessionBranches = new Set(sessions.map((session) => session.branch).filter(Boolean));
  const orphanedSessions = [];

  for (const session of sessions) {
    if (!session.worktree_path || !worktreePaths.has(path.resolve(session.worktree_path)) || !(await pathExists(session.worktree_path))) {
      orphanedSessions.push(session);
    }
  }

  const branches = await listBranches(repoRoot);
  const branchesWithoutWorktrees = branches.filter((branch: Record<string, any>) => !worktrees.some((worktree) => worktree.branch === branch.name));
  const worktreesWithoutState = worktrees.filter((worktree) => !sessionWorktreePaths.has(path.resolve(worktree.path)));
  const stateBranchesWithoutWorktrees = [...sessionBranches].filter((branch) => !worktrees.some((worktree) => worktree.branch === branch));

  return {
    repoRoot,
    config,
    stateVersion: state.state_version,
    sessions,
    orphanedSessions,
    worktrees,
    branchesWithoutWorktrees,
    worktreesWithoutState,
    stateBranchesWithoutWorktrees,
    safetyRefs: await listRefs(repoRoot, "refs/opencode-guardian"),
    preservedRefs: await listRefs(repoRoot, "refs/opencode-guardian/preserved"),
    stashes: await listStashes(repoRoot),
    dirtyFiles: await getDirtyFiles(repoRoot),
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
