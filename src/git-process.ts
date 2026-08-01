import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { assertReferenceTransactionHookSafe, assertSafeGitGlobalOptions, controlledGitEnvironment, runGitNullSeparatedInArtifactSandbox as runGitNullSeparatedInSandbox, runGitWithEnvironment, requiresReferenceTransactionFirewall, withGitArtifactSandbox as withGitArtifactSandboxInClassifier } from "./git-command-classifier.ts";
import type { GitArtifactSandbox } from "./git-command-classifier.ts";
import { areStructuredConfigsReadOnly, isStructuredReadOnlyCommand } from "./git-structured-read-policy.ts";
export { promoteGitArtifactSandboxTree } from "./git-authority.ts";
export { ReferenceTransactionHookPolicyError, assertReferenceTransactionHookSafe, controlledGitEnvironment, runGitInArtifactSandbox } from "./git-command-classifier.ts";
export type { GitArtifactSandbox } from "./git-command-classifier.ts";
import { gitMetadataFromError, withGitMetadata } from "./types.ts";
import type { ExecFileOptionsWithStringEncoding, SpawnOptionsWithoutStdio } from "node:child_process";
import type { GitCommandFailure, GitCommandOutput, WorktreeEntry } from "./types.ts";

const execFileAsync = promisify(execFile);
export const GUARDIAN_SUBPROCESS_TIMEOUT_MS = 30_000;

export type TryGitResult =
  | ({ readonly ok: true } & GitCommandOutput)
  | ({ readonly ok: false; readonly error: GitCommandFailure } & GitCommandOutput);

export type GitReadTarget = {
  readonly cwd: string;
  readonly gitDir: string | null;
  readonly workTree: string | null;
  readonly configs: readonly string[];
};

type GitExecOptions = Omit<ExecFileOptionsWithStringEncoding, "encoding">;
type GitSpawnOptions = Omit<SpawnOptionsWithoutStdio, "stdio">;

export class GitReadOnlyPolicyError extends Error {
  constructor() {
    super("Guardian structured Git targets permit read-only commands only");
    this.name = "GitReadOnlyPolicyError";
  }
}

function structuredTargetOptions(target: GitReadTarget): string[] {
  return [
    ...(target.gitDir ? [`--git-dir=${target.gitDir}`] : []),
    ...(target.workTree ? [`--work-tree=${target.workTree}`] : []),
    ...target.configs.flatMap((config) => ["-c", config]),
  ];
}

function assertReadOnlyStructuredCommand(target: GitReadTarget, args: readonly string[]): void {
  assertSafeGitGlobalOptions(args);
  if (!areStructuredConfigsReadOnly(target.configs) || !isStructuredReadOnlyCommand(args)) throw new GitReadOnlyPolicyError();
}

export async function runGit(repoPath: string, args: readonly string[], options: GitExecOptions = {}): Promise<GitCommandOutput> {
  return runGitWithEnvironment(repoPath, args, options, controlledGitEnvironment(options.env));
}

export async function runGitReadOnly(target: GitReadTarget, args: readonly string[]): Promise<GitCommandOutput> {
  assertReadOnlyStructuredCommand(target, args);
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", target.cwd, ...structuredTargetOptions(target), ...args], {
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf8",
      env: { ...controlledGitEnvironment(), GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
      timeout: GUARDIAN_SUBPROCESS_TIMEOUT_MS,
      killSignal: "SIGTERM",
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw withGitMetadata(error, gitMetadataFromError(args, error));
  }
}

export async function tryGitReadOnly(target: GitReadTarget, args: readonly string[]): Promise<TryGitResult> {
  try {
    return { ok: true, ...(await runGitReadOnly(target, args)) };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const failure = withGitMetadata(error, gitMetadataFromError(args, error));
    return { ok: false, error: failure, stdout: failure.gitStdout, stderr: failure.gitStderr };
  }
}

export async function runGitWithInput(repoPath: string, args: readonly string[], input: string): Promise<GitCommandOutput> {
  assertSafeGitGlobalOptions(args);
  if (requiresReferenceTransactionFirewall(args)) await assertReferenceTransactionHookSafe(repoPath);
  return new Promise<GitCommandOutput>((resolve, reject) => {
    const child = spawn("git", ["-C", repoPath, ...args], { env: controlledGitEnvironment(), stdio: ["pipe", "pipe", "pipe"], timeout: GUARDIAN_SUBPROCESS_TIMEOUT_MS, killSignal: "SIGTERM" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error: NodeJS.ErrnoException) => reject(withGitMetadata(error, gitMetadataFromError(args, error, { stdout: stdout.trim(), stderr: stderr.trim() }))));
    child.on("close", (code, signal) => {
      if (code === 0) return resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      const error = new Error(`git ${args.join(" ")} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`);
      reject(withGitMetadata(error, { gitArgs: [...args], gitStdout: stdout.trim(), gitStderr: stderr.trim(), ...(typeof code === "number" ? { gitExitCode: code } : {}), ...(signal ? { gitSignal: signal } : {}) }));
    });
    child.stdin.end(input);
  });
}

async function runGitNullSeparatedWithEnvironment(repoPath: string, args: readonly string[], options: GitSpawnOptions, environment: NodeJS.ProcessEnv): Promise<string[]> {
  assertSafeGitGlobalOptions(args);
  if (requiresReferenceTransactionFirewall(args)) await assertReferenceTransactionHookSafe(repoPath);
  return new Promise<string[]>((resolve, reject) => {
    const child = spawn("git", ["-C", repoPath, ...args], {
      ...options,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GUARDIAN_SUBPROCESS_TIMEOUT_MS,
      killSignal: "SIGTERM",
    });
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
        if (part.length > 0) entries.push(part);
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
      if (current.length > 0) entries.push(current);
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

export async function runGitNullSeparated(repoPath: string, args: readonly string[], options: GitSpawnOptions = {}): Promise<string[]> {
  const optionalLocksDisabled = options.env?.GIT_OPTIONAL_LOCKS === "0";
  return runGitNullSeparatedWithEnvironment(repoPath, args, options, { ...controlledGitEnvironment(options.env), ...(optionalLocksDisabled ? { GIT_OPTIONAL_LOCKS: "0" } : {}) });
}

export async function runGitNullSeparatedInArtifactSandbox(repoPath: string, args: readonly string[], sandbox: GitArtifactSandbox): Promise<string[]> {
  return runGitNullSeparatedInSandbox(repoPath, args, sandbox, (sandboxRepoPath, sandboxArgs, environment) => runGitNullSeparatedWithEnvironment(sandboxRepoPath, sandboxArgs, {}, environment));
}

export async function withGitArtifactSandbox<T>(repoPath: string, operation: (sandbox: GitArtifactSandbox) => Promise<T>, options: { readonly indexPath?: string } = {}): Promise<T> {
  return withGitArtifactSandboxInClassifier(repoPath, runGit, operation, options);
}

export async function withGitArtifactSandboxFromIndex<T>(repoPath: string, indexPath: string, operation: (sandbox: GitArtifactSandbox) => Promise<T>): Promise<T> {
  return withGitArtifactSandboxInClassifier(repoPath, runGit, operation, { indexPath });
}

export async function tryGit(repoPath: string, args: readonly string[]): Promise<TryGitResult> {
  try {
    return { ok: true, ...(await runGit(repoPath, args)) };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const failure = withGitMetadata(error, gitMetadataFromError(args, error));
    return { ok: false, error: failure, stdout: failure.gitStdout, stderr: failure.gitStderr };
  }
}

export type GitStashEntry = { readonly name: string; readonly commit: string; readonly message: string };

export async function getStatusPorcelain(repoRoot: string): Promise<string> {
  return (await runGit(repoRoot, ["status", "--porcelain"])).stdout;
}

export async function getDirtyFiles(repoRoot: string) {
  const entries = await runGitNullSeparated(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  const files: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const [statusCode, filePath] = [entry.slice(0, 2), entry.slice(3)];
    if (filePath) files.push(filePath);
    if (statusCode.includes("R") || statusCode.includes("C")) {
      const sourcePath = entries[index + 1];
      if (sourcePath) files.push(sourcePath);
      index += 1;
    }
  }
  return [...new Set(files)];
}

export async function getIgnoredFiles(repoRoot: string, options: { readonly optionalLocksDisabled?: boolean } = {}): Promise<string[]> {
  const entries = await runGitNullSeparated(repoRoot, ["status", "--porcelain=v1", "--ignored", "--untracked-files=all", "-z"], options.optionalLocksDisabled ? { env: { GIT_OPTIONAL_LOCKS: "0" } } : {});
  return entries.flatMap((entry) => entry.startsWith("!! ") ? [entry.slice(3)] : []);
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
    } else if (current && line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (current && line.startsWith("branch ")) current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    else if (current && line === "detached") current.detached = true;
    else if (current && line === "bare") current.bare = true;
  }
  if (current) entries.push(current);
  return entries;
}

export type SnapshotWorktreeDirtOptions = { readonly parentCommit: string; readonly paths: readonly string[]; readonly message: string };

export async function snapshotWorktreeDirtCommit(repoPath: string, { parentCommit, paths, message }: SnapshotWorktreeDirtOptions): Promise<string> {
  if (paths.length === 0) throw new Error("snapshotWorktreeDirtCommit requires at least one path");
  const tempIndex = path.join(os.tmpdir(), `guardian-snapshot-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: tempIndex, GIT_AUTHOR_NAME: "opencode-worktree-guardian", GIT_AUTHOR_EMAIL: "guardian@opencode.local", GIT_COMMITTER_NAME: "opencode-worktree-guardian", GIT_COMMITTER_EMAIL: "guardian@opencode.local" };
  try {
    await runGit(repoPath, ["read-tree", parentCommit], { env });
    await runGit(repoPath, ["--literal-pathspecs", "add", "-A", "--", ...paths], { env });
    const tree = (await runGit(repoPath, ["write-tree"], { env })).stdout;
    return (await runGit(repoPath, ["commit-tree", tree, "-p", parentCommit, "-m", message], { env })).stdout;
  } finally {
    await fs.rm(tempIndex, { force: true });
  }
}

type ReadEffectiveGitConfigOptions = { readonly pathValue?: boolean; readonly booleanValue?: boolean };

export async function readEffectiveGitConfig(repoPath: string, key: string, options: ReadEffectiveGitConfigOptions = {}): Promise<string | null> {
  const result = await tryGit(repoPath, [
    "config",
    ...(options.pathValue ? ["--path"] : []),
    ...(options.booleanValue ? ["--bool"] : []),
    "--get",
    key,
  ]);
  if (result.ok) return result.stdout || null;
  if (result.error.gitExitCode === 1 && !result.error.gitSignal && !result.error.gitStdout && !result.error.gitStderr) return null;
  throw result.error;
}
