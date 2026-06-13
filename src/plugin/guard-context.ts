import { loadConfig } from "../config.ts";
import { getCurrentBranch, listWorktrees } from "../git.ts";
import { getGuardianPaths, readState } from "../state.ts";
import type { GuardianConfig, WorktreeEntry } from "../types.ts";
import { pathExists } from "./session-routing.ts";

export async function collectRecordedBranches(repoRoot: string, config: GuardianConfig) {
  const state = await readState(await getGuardianPaths(repoRoot), { repoRoot, config });
  const sessions = Object.values(state.sessions ?? {});
  return [...new Set(sessions.map((session) => session.branch).filter((branch): branch is string => typeof branch === "string" && branch.length > 0))];
}

export async function collectProtectedBranchWorktrees(repoRoot: string, config: GuardianConfig) {
  const protectedBranches = Array.isArray(config.protectedBranches) ? config.protectedBranches : [];
  return (await listWorktrees(repoRoot))
    .filter((entry: WorktreeEntry) => typeof entry.branch === "string" && protectedBranches.includes(entry.branch))
    .map((entry: WorktreeEntry) => entry.path)
    .filter((entry: unknown): entry is string => typeof entry === "string");
}

export async function collectGuardContext(input: {
  readonly pluginDirectory: string | undefined;
  readonly effectiveCwd: string;
}) {
  let guardConfig: GuardianConfig | null = null;
  let guardianBranches: string[] = [];
  let protectedBranchWorktreePaths: string[] = [];
  try {
    if (input.pluginDirectory !== undefined && await pathExists(input.pluginDirectory)) {
      guardConfig = (await loadConfig(input.pluginDirectory)).config;
      guardianBranches = await collectRecordedBranches(input.pluginDirectory, guardConfig);
      protectedBranchWorktreePaths = await collectProtectedBranchWorktrees(input.pluginDirectory, guardConfig);
    }
  } catch {}
  let currentBranch: string | null = null;
  try {
    currentBranch = await getCurrentBranch(input.effectiveCwd);
  } catch {}
  return { guardConfig, guardianBranches, protectedBranchWorktreePaths, currentBranch };
}
