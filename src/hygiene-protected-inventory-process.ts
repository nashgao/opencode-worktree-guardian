import { spawn } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  protectedInventoryResultSchema,
  type ProtectedInventoryRequest,
  type ProtectedInventoryResult,
  type ProtectedInventoryWorkerInput,
} from "./hygiene-protected-inventory-types.ts";

const MAX_STDOUT_BYTES = 1_048_576;
const MAX_STDERR_BYTES = 65_536;
const WORKER_TIMEOUT_MS = 60_000;
const require = createRequire(import.meta.url);
const tsxLoader = require.resolve("tsx");
const workerPath = fileURLToPath(new URL("./hygiene-protected-inventory-worker.ts", import.meta.url));
const nodeExecutable = process.versions.bun ? "node" : process.execPath;

function workerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "ComSpec", "PATHEXT"]) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}

function appendBounded(input: { chunks: Buffer[]; chunk: Buffer; currentBytes: number; maxBytes: number }): number {
  const nextBytes = input.currentBytes + input.chunk.length;
  if (nextBytes > input.maxBytes) throw new Error("Protected inventory worker output exceeded its bound");
  input.chunks.push(input.chunk);
  return nextBytes;
}

function validateResult(input: ProtectedInventoryRequest, raw: string): ProtectedInventoryResult {
  const decoded: unknown = JSON.parse(raw);
  const result = protectedInventoryResultSchema.parse(decoded);
  if (result.entries.length !== input.seeds.length || result.summary.rootCount !== input.seeds.length) {
    throw new Error("Protected inventory worker returned the wrong root cardinality");
  }
  for (let index = 0; index < input.seeds.length; index += 1) {
    const seed = input.seeds[index];
    const entry = result.entries[index];
    if (!seed || !entry || entry.path !== seed.path || entry.reason !== seed.reason) {
      throw new Error("Protected inventory worker returned a mismatched root identity");
    }
  }
  return result;
}

function spawnProtectedInventoryWorker(input: ProtectedInventoryWorkerInput, repoFd: number): Promise<ProtectedInventoryResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExecutable, ["--no-warnings", "--import", tsxLoader, workerPath], {
      cwd: input.repoRoot,
      env: workerEnvironment(),
      stdio: ["pipe", "pipe", "pipe", repoFd],
      timeout: WORKER_TIMEOUT_MS,
      killSignal: "SIGTERM",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdinStream = child.stdin;
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (!stdinStream || !stdoutStream || !stderrStream) {
      child.kill("SIGTERM");
      reject(new Error("Protected inventory worker pipes are unavailable"));
      return;
    }
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputError: Error | undefined;
    stdoutStream.on("data", (chunk: Buffer) => {
      try {
        stdoutBytes = appendBounded({ chunks: stdout, chunk, currentBytes: stdoutBytes, maxBytes: MAX_STDOUT_BYTES });
      } catch (error) {
        outputError = error instanceof Error ? error : new Error(String(error));
        child.kill("SIGTERM");
      }
    });
    stderrStream.on("data", (chunk: Buffer) => {
      try {
        stderrBytes = appendBounded({ chunks: stderr, chunk, currentBytes: stderrBytes, maxBytes: MAX_STDERR_BYTES });
      } catch (error) {
        outputError = error instanceof Error ? error : new Error(String(error));
        child.kill("SIGTERM");
      }
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (outputError) {
        reject(outputError);
        return;
      }
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        reject(new Error(`Protected inventory worker failed (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`));
        return;
      }
      try {
        resolve(validateResult(input, Buffer.concat(stdout).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    stdinStream.on("error", (error) => {
      outputError = error;
      child.kill("SIGTERM");
    });
    stdinStream.end(JSON.stringify(input));
  });
}

export async function runProtectedInventoryWorker(input: ProtectedInventoryRequest): Promise<ProtectedInventoryResult> {
  const repoHandle = await fs.open(input.repoRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const [handleStat, pathStat, canonicalPath] = await Promise.all([
      repoHandle.stat(),
      fs.lstat(input.repoRoot),
      fs.realpath(input.repoRoot),
    ]);
    if (!handleStat.isDirectory() || !pathStat.isDirectory() || handleStat.dev !== pathStat.dev || handleStat.ino !== pathStat.ino || canonicalPath !== input.repoRoot) {
      throw new Error("Protected inventory repository identity changed before worker startup");
    }
    return await spawnProtectedInventoryWorker({
      ...input,
      repoDevice: String(handleStat.dev),
      repoInode: String(handleStat.ino),
    }, repoHandle.fd);
  } finally {
    await repoHandle.close();
  }
}
