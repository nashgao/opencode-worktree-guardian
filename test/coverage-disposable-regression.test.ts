import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { projectRoot, run } from "./package-smoke-helpers.ts";

const execFileAsync = promisify(execFile);
const runnerEnvironmentName = "OPENCODE_WORKTREE_GUARDIAN_DISPOSABLE_COVERAGE";
const slowRegressionEnvironmentName = "OPENCODE_WORKTREE_GUARDIAN_RUN_DISPOSABLE_COVERAGE_REGRESSION";
const slowRegressionScriptName = "test:coverage:isolation";
const testTempParent = path.join(os.homedir(), ".cache", "opencode", "worktree-guardian-tests");
const coverageImplementationPaths = [
  "package.json",
  "scripts/coverage-disposable.ts",
  "scripts/with-safe-node-temp.mjs",
  "test/coverage-disposable-regression.test.ts",
  "test/coverage-execution-isolation.test.ts",
  "test/coverage-signal-cleanup.test.ts",
  "test/package-smoke-helpers.ts",
  "test/package-smoke.test.ts",
] as const;

async function createTestBase(prefix: string): Promise<string> {
  await fs.mkdir(testTempParent, { recursive: true });
  return fs.mkdtemp(path.join(testTempParent, prefix));
}

async function gitStatus(repository: string): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all", "-z"], {
    cwd: repository,
    encoding: "buffer",
  });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function coverageArtifactInventory(): Promise<readonly string[]> {
  const candidates = [os.tmpdir(), "/tmp/opencode", path.join(os.homedir(), ".cache", "opencode", "tmp")];
  const inventory = new Set<string>();
  for (const candidate of candidates) {
    let parent: string;
    try {
      parent = await fs.realpath(candidate);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    for (const entry of await fs.readdir(parent)) {
      if (entry.startsWith("guardian-coverage-disposable-") || entry.startsWith("node-compile-cache-coverage-run-")) inventory.add(path.join(parent, entry));
    }
    const safeRoot = path.basename(parent) === "opencode-worktree-guardian-node" ? parent : path.join(parent, "opencode-worktree-guardian-node");
    let safeEntries: readonly string[];
    try {
      safeEntries = await fs.readdir(safeRoot);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    for (const entry of safeEntries) if (entry.startsWith("coverage-run-")) inventory.add(path.join(safeRoot, entry));
  }
  return [...inventory].sort((left, right) => left.localeCompare(right));
}

async function overlayCoverageImplementation(repository: string): Promise<void> {
  for (const relativePath of coverageImplementationPaths) {
    const source = path.join(projectRoot, relativePath);
    const target = path.join(repository, relativePath);
    await fs.copyFile(source, target);
    const stat = await fs.stat(source);
    await fs.chmod(target, stat.mode & 0o777);
  }
}

async function logTail(logPath: string): Promise<string> {
  const stat = await fs.stat(logPath);
  const length = Math.min(stat.size, 32 * 1024);
  const buffer = Buffer.alloc(length);
  const log = await fs.open(logPath, "r");
  try {
    await log.read(buffer, 0, length, stat.size - length);
  } finally {
    await log.close();
  }
  return buffer.toString("utf8");
}

async function runCoverageRunner(repository: string, runner: string, logPath: string): Promise<void> {
  const output = await fs.open(logPath, "w");
  const child = spawn(process.execPath, ["--import", "tsx", runner], {
    cwd: repository,
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: "",
      NODE_V8_COVERAGE: "",
      NODE_COMPILE_CACHE: "",
      OPENCODE_WORKTREE_GUARDIAN_COVERAGE_RUN: "",
      OPENCODE_WORKTREE_GUARDIAN_COVERAGE_CAPABILITY: "",
    },
    stdio: ["ignore", output.fd, output.fd],
  });
  const outcome = await new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => output.close());
  if (outcome.code === 0 && outcome.signal === null) return;
  throw new Error(`Disposable coverage failed with code ${outcome.code ?? "null"} and signal ${outcome.signal ?? "none"}:\n${await logTail(logPath)}`);
}

const slowRegressionRequested = process.env[slowRegressionEnvironmentName] === "1" || process.env.npm_lifecycle_event === slowRegressionScriptName;

test("disposable coverage preserves dirty binary checkout state across two full runs", { skip: process.env[runnerEnvironmentName] === "1" || !slowRegressionRequested }, async (t) => {
  const base = await createTestBase("coverage-runner-");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const repository = path.join(base, "source");
  await run("git", ["clone", "--no-hardlinks", projectRoot, repository], { cwd: base, coverage: "suppress" });
  await run("git", ["remote", "remove", "origin"], { cwd: repository, coverage: "suppress" });
  await fs.symlink(await fs.realpath(path.join(projectRoot, "node_modules")), path.join(repository, "node_modules"), "dir");
  await overlayCoverageImplementation(repository);

  const tracked = path.join(repository, "tracked-binary.bin");
  const untracked = path.join(repository, "untracked file\nwith spaces.bin");
  await fs.writeFile(tracked, Buffer.from([0x00, 0x7f, 0xff, 0x0a]));
  await run("git", ["add", "--", path.basename(tracked)], { cwd: repository, coverage: "suppress" });
  await run("git", ["-c", "user.name=Coverage Test", "-c", "user.email=coverage@example.test", "commit", "--quiet", "-m", "binary fixture"], { cwd: repository, coverage: "suppress" });
  await fs.writeFile(tracked, Buffer.from([0xff, 0x00, 0x80, 0x0a]));
  await fs.writeFile(untracked, Buffer.from([0x80, 0x00, 0xff, 0x0a]));
  const [statusBefore, trackedBefore, untrackedBefore, inventoryBefore] = await Promise.all([
    gitStatus(repository),
    fs.readFile(tracked),
    fs.readFile(untracked),
    coverageArtifactInventory(),
  ]);

  const runner = path.join(repository, "scripts", "coverage-disposable.ts");
  await runCoverageRunner(repository, runner, path.join(base, "coverage-first.log"));
  await runCoverageRunner(repository, runner, path.join(base, "coverage-second.log"));

  const [statusAfter, trackedAfter, untrackedAfter, inventoryAfter] = await Promise.all([
    gitStatus(repository),
    fs.readFile(tracked),
    fs.readFile(untracked),
    coverageArtifactInventory(),
  ]);
  assert.deepEqual(statusAfter, statusBefore);
  assert.deepEqual(trackedAfter, trackedBefore);
  assert.deepEqual(untrackedAfter, untrackedBefore);
  assert.deepEqual(inventoryAfter, inventoryBefore);
});
