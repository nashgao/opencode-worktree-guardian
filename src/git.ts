import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { gitMetadataFromError, withGitMetadata } from "./types.ts";
import type { ExecFileOptionsWithStringEncoding, SpawnOptionsWithoutStdio } from "node:child_process";
import type { GitCommandFailure, GitCommandOutput, WorktreeEntry } from "./types.ts";

const execFileAsync = promisify(execFile);

export type TryGitResult =
  | ({ readonly ok: true } & GitCommandOutput)
  | ({ readonly ok: false; readonly error: GitCommandFailure } & GitCommandOutput);

export type GitStashEntry = { readonly name: string; readonly commit: string; readonly message: string };
export type GitRefEntry = { readonly name: string; readonly commit: string; readonly date: string; readonly subject: string };
export type GitBranchEntry = { readonly name: string; readonly commit: string };
export type GitCommitEntry = { readonly commit: string; readonly subject: string };
export type GitRecoveryCandidates = { readonly reflog: readonly (GitCommitEntry & { readonly selector: string })[]; readonly unreachable: readonly string[] };
type CreateSafetyRefOptions = { readonly sessionId?: unknown; readonly branch?: unknown; readonly commit?: string; readonly timestamp?: unknown };
type GitExecOptions = Omit<ExecFileOptionsWithStringEncoding, "encoding">;
type GitSpawnOptions = Omit<SpawnOptionsWithoutStdio, "stdio">;

export async function runGit(repoPath: string, args: readonly string[], options: GitExecOptions = {}): Promise<GitCommandOutput> {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", repoPath, ...args], {
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf8",
      ...options,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    throw withGitMetadata(error, gitMetadataFromError(args, error));
  }
}

export async function runGitNullSeparated(repoPath: string, args: readonly string[], options: GitSpawnOptions = {}): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const child = spawn("git", ["-C", repoPath, ...args], { ...options, stdio: ["ignore", "pipe", "pipe"] });
    const decoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const entries: string[] = [];
    let current = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = decoder.write(chunk);
      const parts = text.split("\0");
      parts[0] = current + parts[0];
      current = parts.pop() ?? "";
      for (const part of parts) {
        const entry = part.trim();
        if (entry) entries.push(entry);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += stderrDecoder.write(chunk);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(withGitMetadata(error, gitMetadataFromError(args, error, { stdout: "", stderr: stderr.trim() })));
    });

    child.on("close", (code, signal) => {
      const finalText = decoder.end();
      if (finalText) current += finalText;
      stderr += stderrDecoder.end();
      const finalEntry = current.trim();
      if (finalEntry) entries.push(finalEntry);
      if (code === 0) {
        resolve(entries);
        return;
      }
      const error = new Error(`git ${args.join(" ")} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`);
      reject(withGitMetadata(error, {
        gitArgs: [...args],
        gitStdout: "",
        gitStderr: stderr.trim(),
        ...(typeof code === "number" ? { gitExitCode: code } : {}),
        ...(signal ? { gitSignal: signal } : {}),
      }));
    });
  });
}

export async function tryGit(repoPath: string, args: readonly string[]): Promise<TryGitResult> {
  try {
    return { ok: true, ...(await runGit(repoPath, args)) };
  } catch (error) {
    const failure = withGitMetadata(error, gitMetadataFromError(args, error));
    return { ok: false, error: failure, stdout: failure.gitStdout, stderr: failure.gitStderr };
  }
}

export async function getRepoRoot(cwd: string) {
  return (await runGit(cwd, ["rev-parse", "--show-toplevel"])).stdout;
}

export async function getCommonGitDir(repoRoot: string) {
  return (await runGit(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout;
}

export async function getCurrentBranch(repoRoot: string) {
  const result = await tryGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return result.ok ? result.stdout : null;
}

export async function getBranchUpstream(repoRoot: string, branch: string) {
  const result = await tryGit(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`]);
  return result.ok && result.stdout ? result.stdout : null;
}

export async function getHeadCommit(repoRoot: string) {
  return (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
}

export async function getBranchCommit(repoRoot: string, branch: string) {
  return (await runGit(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`])).stdout;
}

export async function getRefCommit(repoRoot: string, ref: string) {
  return (await runGit(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout;
}

export async function getStatusPorcelain(repoRoot: string) {
  return (await runGit(repoRoot, ["status", "--porcelain"])).stdout;
}

export async function getDirtyFiles(repoRoot: string) {
  const { stdout: status } = await execFileAsync("git", ["-C", repoRoot, "status", "--porcelain=v1", "--untracked-files=all", "-z"], { maxBuffer: 10 * 1024 * 1024 });
  if (!status) return [];
  const files: string[] = [];
  const entries = status.split("\0").filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const statusCode = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (filePath) files.push(filePath);
    if (statusCode.includes("R") || statusCode.includes("C")) {
      const sourcePath = entries[index + 1];
      if (sourcePath) files.push(sourcePath);
      index += 1;
    }
  }
  return [...new Set(files)];
}

export async function getIgnoredFiles(repoRoot: string) {
  const status = (await runGit(repoRoot, ["status", "--porcelain", "--ignored"])).stdout;
  if (!status) return [];
  return status.split("\n").filter((line) => line.startsWith("!! ")).map((line) => line.slice(3)).filter(Boolean);
}

export async function listStashes(repoRoot: string): Promise<GitStashEntry[]> {
  const result = await tryGit(repoRoot, ["stash", "list", "--format=%gd%x00%H%x00%gs"]);
  if (!result.ok || !result.stdout) return [];
  return result.stdout.split("\n").map((line: string) => {
    const [name, commit, message] = line.split("\0");
    return { name, commit, message };
  });
}

export async function listWorktrees(repoRoot: string): Promise<WorktreeEntry[]> {
  const { stdout } = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!stdout) return [];
  const entries: WorktreeEntry[] = [];
  let current: { path: string; head?: string; branch?: string; detached?: boolean; bare?: boolean } | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (current && line === "detached") {
      current.detached = true;
    } else if (current && line === "bare") {
      current.bare = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

function safeRefSegment(value: unknown) {
  const segment = String(value ?? "")
    .replace(/^refs\//, "")
    .replace(/\.\.+/g, ".")
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
  return segment.length > 0 ? segment : "unknown";
}

function defaultRefTimestamp() {
  return new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
}

function safeRefTimestamp(timestamp: unknown) {
  if (timestamp instanceof Date) return defaultRefTimestampFromDate(timestamp);
  const stamp = safeRefSegment(timestamp);
  return stamp === "unknown" ? defaultRefTimestamp() : stamp;
}

function defaultRefTimestampFromDate(timestamp: Date) {
  return timestamp.toISOString().replace(/[-:.]/g, "").slice(0, 15);
}

export function buildSafetyRef(sessionId: string, branch: string, timestamp: unknown = new Date()) {
  const stamp = safeRefTimestamp(timestamp);
  return `refs/opencode-guardian/${safeRefSegment(sessionId)}/${safeRefSegment(branch)}/${stamp}`;
}

export function buildPreservedRef(sessionId: string, branch: string, timestamp: unknown = new Date()) {
  const stamp = safeRefTimestamp(timestamp);
  return `refs/opencode-guardian/preserved/${safeRefSegment(sessionId)}/${safeRefSegment(branch)}/${stamp}`;
}

export async function createRef(repoRoot: string, refName: string, commit = "HEAD") {
  await runGit(repoRoot, ["update-ref", refName, commit]);
  return refName;
}

export async function createSafetyRef(repoRoot: string, { sessionId, branch, commit = "HEAD", timestamp }: CreateSafetyRefOptions = {}) {
  const ref = buildSafetyRef(String(sessionId ?? ""), String(branch ?? ""), timestamp);
  await createRef(repoRoot, ref, commit);
  return ref;
}

export type SnapshotWorktreeDirtOptions = {
  readonly parentCommit: string;
  readonly paths: readonly string[];
  readonly message: string;
};

// Snapshots the worktree state of `paths` (including untracked files, which `git stash create` drops)
// into a commit parented on `parentCommit` via a scoped temporary index, leaving the real index/HEAD
// untouched. A fixed Guardian identity keeps commit-tree working on repos with no configured git user.
export async function snapshotWorktreeDirtCommit(repoPath: string, { parentCommit, paths, message }: SnapshotWorktreeDirtOptions): Promise<string> {
  if (paths.length === 0) throw new Error("snapshotWorktreeDirtCommit requires at least one path");
  const tempIndex = path.join(os.tmpdir(), `guardian-snapshot-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const env = {
    ...process.env,
    GIT_INDEX_FILE: tempIndex,
    GIT_AUTHOR_NAME: "opencode-worktree-guardian",
    GIT_AUTHOR_EMAIL: "guardian@opencode.local",
    GIT_COMMITTER_NAME: "opencode-worktree-guardian",
    GIT_COMMITTER_EMAIL: "guardian@opencode.local",
  };
  try {
    await runGit(repoPath, ["read-tree", parentCommit], { env });
    await runGit(repoPath, ["add", "-A", "--", ...paths], { env });
    const tree = (await runGit(repoPath, ["write-tree"], { env })).stdout;
    return (await runGit(repoPath, ["commit-tree", tree, "-p", parentCommit, "-m", message], { env })).stdout;
  } finally {
    await fs.rm(tempIndex, { force: true });
  }
}

export async function listRefs(repoRoot: string, prefix: string): Promise<GitRefEntry[]> {
  const result = await tryGit(repoRoot, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(committerdate:iso8601)%00%(subject)", prefix]);
  if (!result.ok || !result.stdout) return [];
  return result.stdout.split("\n").map((line: string) => {
    const [name, commit, date, subject] = line.split("\0");
    return { name, commit, date, subject };
  });
}

export async function isAncestor(repoRoot: string, commit: string, ref: string) {
  const result = await tryGit(repoRoot, ["merge-base", "--is-ancestor", commit, ref]);
  return result.ok;
}

export async function listUnmergedCommits(repoRoot: string, head: string, baseRef: string): Promise<GitCommitEntry[]> {
  const result = await runGit(repoRoot, ["log", "--format=%H%x00%s", `${baseRef}..${head}`]);
  if (!result.stdout) return [];
  return result.stdout.split("\n").map((line: string) => {
    const [commit, subject] = line.split("\0");
    return { commit, subject };
  });
}

export async function pushBranch(repoRoot: string, remote: string, branch: string) {
  await runGit(repoRoot, ["push", "-u", remote, branch]);
}

export async function fetchRemote(repoRoot: string, remote: string) {
  await runGit(repoRoot, ["fetch", remote]);
}

export async function removeWorktree(repoRoot: string, worktreePath: string) {
  await runGit(repoRoot, ["worktree", "remove", worktreePath]);
}

export async function deleteBranch(repoRoot: string, branch: string) {
  await runGit(repoRoot, ["branch", "-d", "--", branch]);
}

export async function abandonBranch(repoRoot: string, branch: string) {
  await runGit(repoRoot, ["branch", "-D", "--", branch]);
}

export async function listBranches(repoRoot: string): Promise<GitBranchEntry[]> {
  const result = await tryGit(repoRoot, ["for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads"]);
  if (!result.ok || !result.stdout) return [];
  return result.stdout.split("\n").map((line: string) => {
    const [name, commit] = line.split("\0");
    return { name, commit };
  });
}

export async function listRecoveryCandidates(repoRoot: string): Promise<GitRecoveryCandidates> {
  const reflog = await tryGit(repoRoot, ["reflog", "--format=%H%x00%gd%x00%gs", "-n", "25"]);
  const unreachable = await tryGit(repoRoot, ["fsck", "--no-reflogs", "--unreachable"]);
  return {
    reflog: reflog.ok && reflog.stdout ? reflog.stdout.split("\n").map((line: string) => {
      const [commit, selector, subject] = line.split("\0");
      return { commit, selector, subject };
    }) : [],
    unreachable: unreachable.stdout ? unreachable.stdout.split("\n").filter(Boolean) : [],
  };
}
