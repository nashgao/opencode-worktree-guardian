import { compareCodeUnits } from "./code-unit-order.ts";
import { runGitNullSeparated } from "./git.ts";
import { normalizeRelativePath } from "./filesystem-boundaries.ts";

export type HygieneCandidateStatus = "ignored" | "tracked-added" | "untracked";
export type ReviewableCandidateInput = { readonly path: string; readonly status: HygieneCandidateStatus };
export type NullSeparatedRunner = (repoPath: string, args: readonly string[]) => Promise<string[]>;

const IGNORED_ENUMERATION_ARGS = ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"] as const;

async function listIgnoredPaths(repoRoot: string, runNullSeparated: NullSeparatedRunner): Promise<string[]> {
  try {
    return await runNullSeparated(repoRoot, [...IGNORED_ENUMERATION_ARGS]);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    void error;
    const collapsed = await runNullSeparated(repoRoot, [...IGNORED_ENUMERATION_ARGS, "--directory"]);
    const expanded: string[] = [];
    for (const entry of collapsed) {
      try {
        const scoped = await runNullSeparated(repoRoot, [...IGNORED_ENUMERATION_ARGS, "--", entry]);
        expanded.push(...(scoped.length > 0 ? scoped : [entry]));
      } catch (scopedError) {
        if (!(scopedError instanceof Error)) throw scopedError;
        void scopedError;
        expanded.push(entry);
      }
    }
    return expanded;
  }
}

export async function listTrackedAddedPaths(repoRoot: string, trackedBaselineCommit: string, runNullSeparated: NullSeparatedRunner = runGitNullSeparated): Promise<readonly string[]> {
  const entries = await runNullSeparated(repoRoot, ["--literal-pathspecs", "diff", "--cached", "--name-only", "--diff-filter=A", "--no-renames", "-z", trackedBaselineCommit, "--"]);
  return [...new Set(entries.map(normalizeRelativePath))].sort(compareCodeUnits);
}

export async function listCandidatePaths(repoRoot: string, runNullSeparated: NullSeparatedRunner = runGitNullSeparated, trackedBaselineCommit?: string): Promise<readonly ReviewableCandidateInput[]> {
  const untracked = await runNullSeparated(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const ignored = await listIgnoredPaths(repoRoot, runNullSeparated);
  const trackedAdded = trackedBaselineCommit
    ? await listTrackedAddedPaths(repoRoot, trackedBaselineCommit, runNullSeparated)
    : [];
  const candidatesByPath = new Map<string, HygieneCandidateStatus>();
  for (const entry of untracked) candidatesByPath.set(normalizeRelativePath(entry), "untracked");
  for (const entry of ignored) candidatesByPath.set(normalizeRelativePath(entry), "ignored");
  for (const entry of trackedAdded) candidatesByPath.set(normalizeRelativePath(entry), "tracked-added");
  return [...candidatesByPath.entries()]
    .map(([candidatePath, status]) => ({ path: candidatePath, status }))
    .sort((left, right) => compareCodeUnits(left.path, right.path));
}
