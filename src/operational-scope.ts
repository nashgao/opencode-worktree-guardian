import { tryGit, tryGitReadOnly } from "./git.ts";
import type { GitReadTarget } from "./git.ts";

export type OperationalScopeFreshness = "cached-read-only" | "freshly-fetched-effective-remote";

export type OperationalScope = {
  readonly effectiveRemote: string;
  readonly unexaminedSecondaryRemotes: readonly string[];
  readonly localBranchCount: number;
  readonly effectiveRemoteBranchCount: number;
  readonly freshness: OperationalScopeFreshness;
};

export type OperationalScopeInput = {
  readonly effectiveRemote: string;
  readonly remotes: readonly string[];
  readonly localBranchCount: number;
  readonly effectiveRemoteBranchCount: number;
  readonly freshness: OperationalScopeFreshness;
};

export const HYGIENE_OPERATIONAL_SCOPE = {
  enumeration: "git-untracked-and-ignored",
  emptyDirectories: "outside-coverage",
} as const;

const REMOTE_CONFIG_PATTERN = "^remote\\..*\\.(url|pushurl|fetch)$";

function readTarget(repoRoot: string): GitReadTarget {
  return { cwd: repoRoot, gitDir: null, workTree: null, configs: [] };
}

function remoteNameFromConfigKey(key: string): string | null {
  if (!key.startsWith("remote.")) return null;
  const finalSeparator = key.lastIndexOf(".");
  const variable = key.slice(finalSeparator + 1);
  if (finalSeparator <= "remote.".length || (variable !== "url" && variable !== "pushurl")) return null;
  return key.slice("remote.".length, finalSeparator);
}

function remoteNames(stdout: string): readonly string[] {
  return [...new Set(stdout.split("\0").flatMap((key) => {
    const remote = remoteNameFromConfigKey(key);
    return remote ? [remote] : [];
  }))].sort((left, right) => left.localeCompare(right));
}

export async function listRemoteNames(repoRoot: string): Promise<readonly string[]> {
  const result = await tryGit(repoRoot, ["config", "--includes", "--null", "--name-only", "--get-regexp", REMOTE_CONFIG_PATTERN]);
  if (!result.ok) {
    if (result.error.gitExitCode === 1 && !result.stderr) return [];
    throw result.error;
  }
  return remoteNames(result.stdout);
}

export async function listRemoteNamesReadOnly(repoRoot: string): Promise<readonly string[]> {
  const result = await tryGitReadOnly(readTarget(repoRoot), ["config", "--includes", "--null", "--name-only", "--get-regexp", REMOTE_CONFIG_PATTERN]);
  if (!result.ok) {
    if (result.error.gitExitCode === 1 && !result.stderr) return [];
    throw result.error;
  }
  return remoteNames(result.stdout);
}

export async function cachedRemoteBranchCount(repoRoot: string, remote: string): Promise<number> {
  const result = await tryGit(repoRoot, ["for-each-ref", "--format=%(refname)", `refs/remotes/${remote}`]);
  if (!result.ok) throw result.error;
  return result.stdout.split("\n").filter((ref) => ref.length > 0 && ref !== `refs/remotes/${remote}/HEAD`).length;
}

export async function cachedRemoteBranchCountReadOnly(repoRoot: string, remote: string): Promise<number> {
  const result = await tryGitReadOnly(readTarget(repoRoot), ["for-each-ref", "--format=%(refname)", `refs/remotes/${remote}`]);
  if (!result.ok) throw result.error;
  return result.stdout.split("\n").filter((ref) => ref.length > 0 && ref !== `refs/remotes/${remote}/HEAD`).length;
}

export function operationalScope({ effectiveRemote, remotes, localBranchCount, effectiveRemoteBranchCount, freshness }: OperationalScopeInput): OperationalScope {
  return {
    effectiveRemote,
    unexaminedSecondaryRemotes: remotes.filter((remote) => remote !== effectiveRemote),
    localBranchCount,
    effectiveRemoteBranchCount,
    freshness,
  };
}
