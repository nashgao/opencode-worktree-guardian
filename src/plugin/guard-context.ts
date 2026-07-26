import { loadConfig } from "../config.ts";
import { listWorktrees, tryGit } from "../git.ts";
import { collectKnownWorktreePaths } from "../session/worktree-binding.ts";
import { getGuardianPaths, readState } from "../state.ts";
import type { GuardianConfig, WorktreeEntry } from "../types.ts";
import type { GuardOptions } from "../tool-types.ts";
import { inspectEffectiveGitConfig, gitInspectionTarget, gitTargetArgs } from "./effective-git-config.ts";
import type { GitInspectionTarget } from "./effective-git-config.ts";
import { collectGuardPathFacts } from "./guard-path-facts.ts";

export type GuardRepository =
  | { readonly state: "repository"; readonly repoRoot: string }
  | { readonly state: "outside-git" }
  | { readonly state: "failed"; readonly reason: string };

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

async function primaryRepoRoot(target: GitInspectionTarget): Promise<string> {
  const topLevel = await tryGit(target.cwd, [...gitTargetArgs(target), "rev-parse", "--show-toplevel"]);
  if (!topLevel.ok) throw topLevel.error;
  const common = await tryGit(target.cwd, [...gitTargetArgs(target), "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) throw common.error;
  const entries = await listWorktrees(topLevel.stdout);
  const candidates = await Promise.all(entries.map(async (entry) => {
    const gitDir = await tryGit(entry.path, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    return gitDir.ok && gitDir.stdout === common.stdout ? entry.path : null;
  }));
  const matches = candidates.filter((entry): entry is string => entry !== null);
  if (matches.length !== 1) throw new Error("could not identify the primary Git worktree");
  return matches[0] ?? topLevel.stdout;
}

export async function resolveGuardRepository(cwd: string, command?: string | null): Promise<GuardRepository> {
  return resolveGuardRepositoryForTarget(gitInspectionTarget(command, cwd));
}

export async function resolveGuardRepositoryForTarget(target: GitInspectionTarget): Promise<GuardRepository> {
  try {
    return { state: "repository", repoRoot: await primaryRepoRoot(target) };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (/not a git repository|outside repository/i.test(error.message)) return { state: "outside-git" };
    return { state: "failed", reason: error.message };
  }
}

export async function collectGuardContext(input: {
  readonly repoRoot: string;
  readonly effectiveCwd: string;
  readonly command?: string | null;
  readonly currentWorktree?: string;
  readonly target?: GitInspectionTarget;
  readonly explicitPushSources?: readonly string[];
}) {
  const target = input.target ?? gitInspectionTarget(input.command, input.effectiveCwd);
  const configRoot = await tryGit(target.cwd, [...gitTargetArgs(target), "rev-parse", "--show-toplevel"]);
  const primaryConfig = await loadConfig(input.repoRoot);
  const targetConfig = configRoot.ok ? await loadConfig(configRoot.stdout) : primaryConfig;
  const guardConfig = targetConfig.loaded ? targetConfig.config : primaryConfig.config;
  let guardianBranches: string[] = [];
  let protectedBranchWorktreePaths: string[] = [];
  let knownWorktreePaths: string[] = [];
  const effectiveInspection = await inspectEffectiveGitConfig(target, {
    protectedBranches: guardConfig.protectedBranches,
    explicitPushSources: input.explicitPushSources ?? [],
  });
  let inspection = effectiveInspection.inspection;
  let revisionIdentities = effectiveInspection.revisionIdentities;
  try {
    [guardianBranches, protectedBranchWorktreePaths, knownWorktreePaths] = await Promise.all([
      collectRecordedBranches(input.repoRoot, guardConfig),
      collectProtectedBranchWorktrees(input.repoRoot, guardConfig),
      collectKnownWorktreePaths({ cwd: input.effectiveCwd, repoRoot: input.repoRoot, currentWorktree: input.currentWorktree, config: guardConfig }),
    ]);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    inspection = { state: "failed", stage: "state", reason: error.message };
    revisionIdentities = [];
  }
  let pathFacts = undefined;
  try {
    pathFacts = await collectGuardPathFacts({
      command: input.command,
      cwd: input.effectiveCwd,
      repoRoots: [input.repoRoot],
      knownWorktreePaths,
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    inspection = { state: "failed", stage: "path-facts", reason: error.message };
    revisionIdentities = [];
  }
  const branch = await tryGit(target.cwd, [...gitTargetArgs(target), "symbolic-ref", "--quiet", "--short", "HEAD"]);
  return {
    guardConfig,
    guardianBranches,
    protectedBranchWorktreePaths,
    knownWorktreePaths,
    currentBranch: branch.ok ? branch.stdout : null,
    inspection,
    revisionIdentities,
    pathFacts,
  };
}

export function guardOptionsFromContext(context: Awaited<ReturnType<typeof collectGuardContext>>, cwd: string, repoRoot: string): GuardOptions {
  return {
    cwd,
    repoRoot,
    knownWorktreePaths: context.knownWorktreePaths,
    protectedBranches: context.guardConfig.protectedBranches,
    branchPrefix: context.guardConfig.branchPrefix,
    guardianBranches: context.guardianBranches,
    protectedBranchWorktreePaths: context.protectedBranchWorktreePaths,
    currentBranch: context.currentBranch,
    inspection: context.inspection,
    revisionIdentities: context.revisionIdentities,
    ...(context.pathFacts ? { pathFacts: context.pathFacts } : {}),
  };
}
