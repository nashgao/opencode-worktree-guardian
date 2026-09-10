import { getHeadCommit, runGit, runGitNullSeparated, snapshotWorktreeDirtCommit, validateGitRef } from "./git.ts";

export class PreservedPrimaryDirtDriftError extends Error {
  readonly reason: "head-changed" | "content-changed";
  constructor(reason: "head-changed" | "content-changed") {
    super(`Primary worktree preservation changed before exact-path clearing: ${reason}`);
    this.name = "PreservedPrimaryDirtDriftError";
    this.reason = reason;
  }
}

export async function clearPreservedPrimaryDirt(repoRoot: string, parentCommit: string, preservedDirtCommit: string, paths: readonly string[]): Promise<void> {
  validateGitRef(parentCommit);
  validateGitRef(preservedDirtCommit);
  if (await getHeadCommit(repoRoot) !== parentCommit) throw new PreservedPrimaryDirtDriftError("head-changed");
  const currentSnapshot = await snapshotWorktreeDirtCommit(repoRoot, { parentCommit, paths, message: "verify preserved primary dirt before clearing" });
  const [preservedTree, currentTree] = await Promise.all([
    runGit(repoRoot, ["rev-parse", "--verify", `${preservedDirtCommit}^{tree}`]),
    runGit(repoRoot, ["rev-parse", "--verify", `${currentSnapshot}^{tree}`]),
  ]);
  if (preservedTree.stdout !== currentTree.stdout) throw new PreservedPrimaryDirtDriftError("content-changed");
  const [parentPaths, indexPaths] = await Promise.all([
    runGitNullSeparated(repoRoot, ["--literal-pathspecs", "ls-tree", "-r", "--name-only", "-z", parentCommit, "--", ...paths]),
    runGitNullSeparated(repoRoot, ["--literal-pathspecs", "ls-files", "--cached", "-z", "--", ...paths]),
  ]);
  const trackedPaths = new Set([...parentPaths, ...indexPaths]);
  const restorePaths = paths.filter((file) => trackedPaths.has(file));
  const untrackedPaths = paths.filter((file) => !trackedPaths.has(file));
  if (await getHeadCommit(repoRoot) !== parentCommit) throw new PreservedPrimaryDirtDriftError("head-changed");
  if (restorePaths.length > 0) await runGit(repoRoot, ["--literal-pathspecs", "restore", `--source=${parentCommit}`, "--staged", "--worktree", "--", ...restorePaths]);
  if (untrackedPaths.length > 0) await runGit(repoRoot, ["--literal-pathspecs", "clean", "-f", "--", ...untrackedPaths]);
}
