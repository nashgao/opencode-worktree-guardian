import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit, runGitNullSeparated } from "./git-process.ts";

export type SnapshotWorktreeDirtOptions = { readonly parentCommit: string; readonly paths: readonly string[]; readonly message: string };

export class DirtSnapshotPathError extends Error {
  readonly filePath: string;
  constructor(filePath: string) {
    super(`Dirt snapshot requires an exact file path, not a directory or gitlink: ${filePath}`);
    this.name = "DirtSnapshotPathError";
    this.filePath = filePath;
  }
}

export async function snapshotWorktreeDirtCommit(repoPath: string, { parentCommit, paths, message }: SnapshotWorktreeDirtOptions): Promise<string> {
  if (paths.length === 0) throw new RangeError("snapshotWorktreeDirtCommit requires at least one path");
  for (const file of paths) {
    if (!file || file === "." || path.isAbsolute(file) || path.normalize(file) !== file || file.startsWith(`..${path.sep}`) || file === "..") throw new DirtSnapshotPathError(file);
    const stat = await fs.lstat(path.join(repoPath, file)).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stat?.isDirectory()) throw new DirtSnapshotPathError(file);
  }
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-snapshot-index-"));
  const env = { GIT_INDEX_FILE: path.join(tempDirectory, "index"), GIT_AUTHOR_NAME: "opencode-worktree-guardian", GIT_AUTHOR_EMAIL: "guardian@opencode.local", GIT_COMMITTER_NAME: "opencode-worktree-guardian", GIT_COMMITTER_EMAIL: "guardian@opencode.local" };
  try {
    await runGit(repoPath, ["read-tree", parentCommit], { env });
    const requested = new Set(paths);
    const cachedPaths = new Set<string>();
    const records = await runGitNullSeparated(repoPath, ["--literal-pathspecs", "ls-files", "--cached", "--stage", "-z", "--", ...paths], { env });
    for (const record of records) {
      const file = record.slice(record.indexOf("\t") + 1);
      if (!requested.has(file) || record.startsWith("160000 ")) throw new DirtSnapshotPathError(file);
      cachedPaths.add(file);
    }
    const trackedPaths = paths.filter((file) => cachedPaths.has(file));
    const newPaths = paths.filter((file) => !cachedPaths.has(file));
    if (trackedPaths.length > 0) await runGit(repoPath, ["--literal-pathspecs", "add", "-u", "--", ...trackedPaths], { env });
    if (newPaths.length > 0) await runGit(repoPath, ["--literal-pathspecs", "add", "--", ...newPaths], { env });
    const tree = (await runGit(repoPath, ["write-tree"], { env })).stdout;
    return (await runGit(repoPath, ["commit-tree", tree, "-p", parentCommit, "-m", message], { env })).stdout;
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}
