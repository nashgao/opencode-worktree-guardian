import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gitMetadataFromError, withGitMetadata } from "./types.ts";
import type { ExecFileOptionsWithStringEncoding } from "node:child_process";
import type { GitCommandOutput } from "./types.ts";

type GitCommand = {
  readonly name: string;
  readonly rest: readonly string[];
};

const execFileAsync = promisify(execFile);
const guardianSubprocessTimeoutMs = 30_000;
const trustedGitEnvironmentKeys = new Set(["GIT_INDEX_FILE", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]);
type GitExecOptions = Omit<ExecFileOptionsWithStringEncoding, "encoding">;

const safeGlobalOptions: ReadonlySet<string> = new Set([
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
] as const);

const readOnlyCommands: ReadonlySet<string> = new Set([
  "add",
  "annotate",
  "blame",
  "cat-file",
  "check-attr",
  "check-ignore",
  "check-mailmap",
  "check-ref-format",
  "count-objects",
  "commit-tree",
  "describe",
  "diff",
  "diff-files",
  "diff-index",
  "diff-tree",
  "for-each-ref",
  "fsck",
  "grep",
  "log",
  "ls-files",
  "ls-tree",
  "merge-base",
  "name-rev",
  "range-diff",
  "read-tree",
  "rev-list",
  "rev-parse",
  "restore",
  "show",
  "show-branch",
  "show-ref",
  "status",
  "verify-commit",
  "verify-pack",
  "write-tree",
] as const);

function normalizedCommand(args: readonly string[]): GitCommand | null {
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === undefined || token === "--") return null;
    if (!token.startsWith("-")) return { name: token, rest: args.slice(index + 1) };
    if (safeGlobalOptions.has(token)) {
      index += 1;
      continue;
    }
    return null;
  }
  return null;
}

export class GitGlobalOptionPolicyError extends Error {
  constructor() {
    super("Guardian refuses a global Git option other than pathspec matching controls");
    this.name = "GitGlobalOptionPolicyError";
  }
}

export function assertSafeGitGlobalOptions(args: readonly string[]): void {
  if (!normalizedCommand(args)) throw new GitGlobalOptionPolicyError();
}

function isConfigRead(rest: readonly string[]): boolean {
  return rest.some((token) => token === "--get" || token === "--get-all" || token === "--get-regexp" || token === "--get-urlmatch" || token === "--list" || token === "--show-origin" || token === "--show-scope");
}

function isSymbolicRefRead(rest: readonly string[]): boolean {
  if (rest.includes("--delete")) return false;
  const values = rest.filter((token) => !token.startsWith("-"));
  return values.length === 1;
}

function isReadOnlySubcommand(command: GitCommand): boolean {
  if (readOnlyCommands.has(command.name)) return true;
  if (command.name === "clean") return command.rest.includes("-n") || command.rest.includes("--dry-run");
  if (command.name === "config") return isConfigRead(command.rest);
  if (command.name === "symbolic-ref") return isSymbolicRefRead(command.rest);
  if (command.name === "worktree") return command.rest[0] === "list";
  if (command.name === "stash") return command.rest[0] === "list" || command.rest[0] === "show";
  if (command.name === "notes") return command.rest[0] === "list" || command.rest[0] === "show";
  if (command.name === "init") return true;
  if (command.name === "branch") return command.rest.length === 0 || command.rest.includes("--show-current") || command.rest.includes("--list") || command.rest.includes("-l");
  if (command.name === "remote") return command.rest[0] === "get-url" || command.rest[0] === "show" || command.rest[0] === "-v";
  return false;
}

export function requiresReferenceTransactionFirewall(args: readonly string[]): boolean {
  const command = normalizedCommand(args); return command === null || !isReadOnlySubcommand(command);
}

export class ReferenceTransactionHookPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceTransactionHookPolicyError";
  }
}

function processErrorCode(error: unknown): string | number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const { code } = error;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}

export function controlledGitEnvironment(trustedOptions: NodeJS.ProcessEnv | undefined = {}): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const trusted = Object.fromEntries(Object.entries(trustedOptions).filter(([key]) => trustedGitEnvironmentKeys.has(key)));
  return {
    ...environment,
    ...trusted,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "false",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
  };
}

export async function runGitWithEnvironment(repoPath: string, args: readonly string[], options: GitExecOptions, environment: NodeJS.ProcessEnv): Promise<GitCommandOutput> {
  assertSafeGitGlobalOptions(args);
  if (requiresReferenceTransactionFirewall(args)) await assertReferenceTransactionHookSafe(repoPath);
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", repoPath, ...args], {
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf8",
      ...options,
      env: environment,
      timeout: guardianSubprocessTimeoutMs,
      killSignal: "SIGTERM",
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw withGitMetadata(error, gitMetadataFromError(args, error));
  }
}

async function effectiveHooksPath(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "config", "--path", "--get", "core.hooksPath"], {
      encoding: "utf8",
      env: controlledGitEnvironment(),
      timeout: guardianSubprocessTimeoutMs,
      killSignal: "SIGTERM",
    });
    const configured = stdout.trim();
    if (!configured) throw new ReferenceTransactionHookPolicyError("Guardian cannot determine the effective core.hooksPath policy before a ref write");
    return path.resolve(repoPath, configured);
  } catch (error) {
    if (error instanceof ReferenceTransactionHookPolicyError) throw error;
    if (processErrorCode(error) !== 1) throw new ReferenceTransactionHookPolicyError("Guardian cannot inspect effective core.hooksPath policy before a ref write");
  }
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      env: controlledGitEnvironment(),
      timeout: guardianSubprocessTimeoutMs,
      killSignal: "SIGTERM",
    });
    const commonDir = stdout.trim();
    if (!commonDir) throw new ReferenceTransactionHookPolicyError("Guardian cannot determine the common Git directory before a ref write");
    return path.join(path.resolve(repoPath, commonDir), "hooks");
  } catch (error) {
    if (error instanceof ReferenceTransactionHookPolicyError) throw error;
    throw new ReferenceTransactionHookPolicyError("Guardian cannot inspect the standard hooks directory before a ref write");
  }
}

async function isExecutableReferenceTransactionHook(hooksPath: string): Promise<boolean> {
  const hookPath = path.join(hooksPath, "reference-transaction");
  try {
    const stat = await fs.stat(hookPath);
    if (!stat.isFile()) return false;
  } catch (error) {
    if (processErrorCode(error) === "ENOENT") return false;
    throw new ReferenceTransactionHookPolicyError("Guardian cannot inspect the effective reference-transaction hook before a ref write");
  }
  try {
    await fs.access(hookPath, constants.X_OK);
    return true;
  } catch (error) {
    if (processErrorCode(error) === "EACCES") throw new ReferenceTransactionHookPolicyError("Guardian cannot determine whether the effective reference-transaction hook is executable before a ref write");
    throw new ReferenceTransactionHookPolicyError("Guardian cannot inspect the effective reference-transaction hook before a ref write");
  }
}

export async function assertReferenceTransactionHookSafe(repoPath: string): Promise<void> {
  const hooksPath = await effectiveHooksPath(repoPath);
  if (await isExecutableReferenceTransactionHook(hooksPath)) {
    throw new ReferenceTransactionHookPolicyError("Guardian refuses a ref write while an effective executable reference-transaction hook is configured");
  }
}

const artifactSandboxBrand: unique symbol = Symbol("artifactSandbox");
export type GitArtifactSandbox = { readonly [artifactSandboxBrand]: true };
type ArtifactSandboxPaths = {
  readonly indexPath: string;
  readonly objectDirectory: string;
  readonly alternateObjectDirectory: string;
};
const artifactSandboxPaths = new WeakMap<GitArtifactSandbox, ArtifactSandboxPaths>();

export function artifactEnvironment(sandbox: GitArtifactSandbox): NodeJS.ProcessEnv {
  const paths = artifactSandboxPaths.get(sandbox);
  if (!paths) throw new Error("Guardian artifact sandbox is not active");
  return {
    ...controlledGitEnvironment({ GIT_INDEX_FILE: paths.indexPath }),
    GIT_OBJECT_DIRECTORY: paths.objectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: paths.alternateObjectDirectory,
    GIT_OPTIONAL_LOCKS: "0",
  };
}

export async function runGitInArtifactSandbox(repoPath: string, args: readonly string[], sandbox: GitArtifactSandbox): Promise<GitCommandOutput> {
  return runGitWithEnvironment(repoPath, args, {}, artifactEnvironment(sandbox));
}

type GitNullSeparatedRunner = (repoPath: string, args: readonly string[], environment: NodeJS.ProcessEnv) => Promise<string[]>;
export async function runGitNullSeparatedInArtifactSandbox(repoPath: string, args: readonly string[], sandbox: GitArtifactSandbox, runNullSeparated: GitNullSeparatedRunner): Promise<string[]> {
  return runNullSeparated(repoPath, args, artifactEnvironment(sandbox));
}

type GitArtifactSandboxRunner = (repoPath: string, args: readonly string[]) => Promise<GitCommandOutput>;
export async function withGitArtifactSandbox<T>(repoPath: string, runGit: GitArtifactSandboxRunner, operation: (sandbox: GitArtifactSandbox) => Promise<T>, options: { readonly indexPath?: string } = {}): Promise<T> {
  const [indexPath, objectDirectory] = await Promise.all([
    runGit(repoPath, ["rev-parse", "--path-format=absolute", "--git-path", "index"]),
    runGit(repoPath, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]),
  ]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-artifact-sandbox-"));
  const sandbox: GitArtifactSandbox = { [artifactSandboxBrand]: true };
  const sandboxIndex = path.join(root, "index");
  try {
    await fs.copyFile(options.indexPath ?? indexPath.stdout, sandboxIndex);
    artifactSandboxPaths.set(sandbox, { indexPath: sandboxIndex, objectDirectory: path.join(root, "objects"), alternateObjectDirectory: objectDirectory.stdout });
    await fs.mkdir(path.join(root, "objects"));
    return await operation(sandbox);
  } finally {
    artifactSandboxPaths.delete(sandbox);
    await fs.rm(root, { recursive: true, force: true });
  }
}
