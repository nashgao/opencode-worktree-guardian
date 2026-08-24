import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const decoder = new TextDecoder("utf-8", { fatal: true });
const excludedRoots = new Set([".git", ".worktrees", "node_modules"]);
const coverageEnvironmentNames = ["NODE_V8_COVERAGE", "NODE_COMPILE_CACHE", "OPENCODE_WORKTREE_GUARDIAN_COVERAGE_RUN", "OPENCODE_WORKTREE_GUARDIAN_COVERAGE_CAPABILITY"] as const;
const runnerEnvironmentName = "OPENCODE_WORKTREE_GUARDIAN_DISPOSABLE_COVERAGE";
const shutdownSignals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
const fallbackTempRoots = ["/tmp/opencode", path.join(os.homedir(), ".cache", "opencode", "tmp")] as const;

type ChildOutcome =
  | { readonly kind: "close"; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly kind: "error"; readonly error: Error };

function isSafeRelativePath(value: string): boolean {
  return value.length > 0 && !path.isAbsolute(value) && !value.split(path.sep).some((part) => part === "" || part === "." || part === "..");
}

function decodePaths(value: Buffer): readonly string[] {
  return value.toString("binary").split("\0").slice(0, -1).map((entry) => {
    const relativePath = decoder.decode(Buffer.from(entry, "binary"));
    if (!isSafeRelativePath(relativePath)) throw new Error(`Unsafe Git path: ${JSON.stringify(relativePath)}`);
    return relativePath;
  });
}

async function gitBuffer(cwd: string, args: readonly string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

async function gitText(cwd: string, args: readonly string[]): Promise<string> {
  return decoder.decode(await gitBuffer(cwd, args)).trim();
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isSameOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function nearestExistingAncestor(candidate: string): Promise<string> {
  let current = path.resolve(candidate);
  while (true) {
    try {
      return await fs.realpath(current);
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function isInsideGitWorktree(candidate: string): Promise<boolean> {
  let current = await nearestExistingAncestor(candidate);
  while (true) {
    try {
      await fs.lstat(path.join(current, ".git"));
      return true;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
}

async function externalTempRoot(projectRoot: string): Promise<string> {
  for (const candidate of [os.tmpdir(), ...fallbackTempRoots]) {
    try {
      await fs.mkdir(candidate, { recursive: true });
      const canonical = await fs.realpath(candidate);
      if (isSameOrInside(canonical, projectRoot) || await isInsideGitWorktree(canonical)) continue;
      return canonical;
    } catch (error) {
      if (error instanceof Error) continue;
      throw error;
    }
  }
  throw new Error("Unable to resolve an external temp directory for disposable coverage");
}

async function snapshotPath(root: string, relativePath: string): Promise<string> {
  let current = root;
  for (const part of relativePath.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Symlinked snapshot ancestor: ${relativePath}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return path.join(root, relativePath);
}

async function overlayPath(sourceRoot: string, snapshotRoot: string, relativePath: string): Promise<void> {
  const sourcePath = path.join(sourceRoot, relativePath);
  const targetPath = await snapshotPath(snapshotRoot, relativePath);
  let stat;
  try {
    stat = await fs.lstat(sourcePath);
  } catch (error) {
    if (!isMissing(error)) throw error;
    await fs.rm(targetPath, { recursive: true, force: true });
    return;
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.rm(targetPath, { recursive: true, force: true });
  if (stat.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(sourcePath), targetPath);
    return;
  }
  if (!stat.isFile()) throw new Error(`Unsupported snapshot entry: ${relativePath}`);
  await fs.copyFile(sourcePath, targetPath);
  await fs.chmod(targetPath, stat.mode & 0o777);
}

async function overlay(sourceRoot: string, snapshotRoot: string): Promise<void> {
  const [head, indexAndUntracked] = await Promise.all([
    gitBuffer(sourceRoot, ["ls-tree", "-rz", "--name-only", "HEAD"]),
    gitBuffer(sourceRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
  ]);
  const paths = new Set([...decodePaths(head), ...decodePaths(indexAndUntracked)].filter((relativePath) => !excludedRoots.has(relativePath.split(path.sep)[0] ?? "")));
  for (const relativePath of [...paths].sort((left, right) => left.localeCompare(right))) await overlayPath(sourceRoot, snapshotRoot, relativePath);
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ kind: "error", error }));
    child.once("close", (code, signal) => resolve({ kind: "close", code, signal }));
  });
}

async function run(snapshotRoot: string, runRoot: string): Promise<ChildOutcome> {
  const tests = (await fs.readdir(path.join(snapshotRoot, "test")))
    .filter((entry) => entry.endsWith(".test.ts"))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => path.join("test", entry));
  const tempRoot = path.join(runRoot, "tmp");
  await fs.mkdir(tempRoot, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot, [runnerEnvironmentName]: "1" };
  for (const name of coverageEnvironmentNames) env[name] = "";
  const child = spawn(process.execPath, [path.join(snapshotRoot, "scripts", "with-safe-node-temp.mjs"), "--", process.execPath, "--import", "tsx", "--test", "--test-isolation=none", "--experimental-test-coverage", "--test-coverage-lines=80", ...tests], { cwd: snapshotRoot, env, stdio: "inherit" });
  const listeners = new Map<NodeJS.Signals, () => void>();
  let forwardedSignal: NodeJS.Signals | undefined;
  for (const signal of shutdownSignals) {
    const listener = () => {
      if (forwardedSignal) return;
      forwardedSignal = signal;
      child.kill(signal);
    };
    listeners.set(signal, listener);
    process.on(signal, listener);
  }
  const outcome = await waitForChild(child);
  for (const [signal, listener] of listeners) process.removeListener(signal, listener);
  if (forwardedSignal) return { kind: "close", code: null, signal: forwardedSignal };
  return outcome;
}

const sourceRoot = await fs.realpath(process.cwd());
const runRoot = await fs.mkdtemp(path.join(await externalTempRoot(sourceRoot), "guardian-coverage-disposable-"));
let outcome: ChildOutcome | undefined;
try {
  const snapshotRoot = path.join(runRoot, "snapshot");
  const [sourceHead, sourceBranch] = await Promise.all([
    gitText(sourceRoot, ["rev-parse", "HEAD"]),
    gitText(sourceRoot, ["symbolic-ref", "--short", "HEAD"]),
  ]);
  await execFileAsync("git", ["clone", "--no-hardlinks", sourceRoot, snapshotRoot]);
  await gitText(snapshotRoot, ["remote", "remove", "origin"]);
  const [snapshotHead, snapshotBranch] = await Promise.all([
    gitText(snapshotRoot, ["rev-parse", "HEAD"]),
    gitText(snapshotRoot, ["symbolic-ref", "--short", "HEAD"]),
  ]);
  if (snapshotHead !== sourceHead || snapshotBranch !== sourceBranch) throw new Error("Coverage snapshot Git identity mismatch");
  await overlay(sourceRoot, snapshotRoot);
  await fs.symlink(await fs.realpath(path.join(sourceRoot, "node_modules")), path.join(snapshotRoot, "node_modules"), "dir");
  outcome = await run(snapshotRoot, runRoot);
} finally {
  await fs.rm(runRoot, { recursive: true, force: true });
}
if (outcome?.kind === "error") throw outcome.error;
if (outcome?.kind === "close" && outcome.signal) process.kill(process.pid, outcome.signal);
process.exitCode = outcome?.kind === "close" ? (outcome.code ?? 1) : 1;

