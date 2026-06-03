#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const safeTempDirectoryName = "opencode-worktree-guardian-node";
const fallbackTempBases = [
  "/var/folders/tw/rrg4001s2bdg6m3ht0dz0j1h0000gn/T/opencode",
  path.join("/tmp", "opencode"),
  path.join(os.homedir(), ".cache", "opencode", "tmp"),
];

function isSameOrInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function resolveSafeTempRoot(projectRoot) {
  for (const candidate of [os.tmpdir(), ...fallbackTempBases]) {
    try {
      const candidatePath = path.resolve(candidate);
      await fs.mkdir(candidatePath, { recursive: true });
      const realCandidate = await fs.realpath(candidatePath);
      if (isSameOrInside(realCandidate, projectRoot)) continue;
      const safeRoot = path.join(realCandidate, safeTempDirectoryName);
      await fs.mkdir(safeRoot, { recursive: true });
      return fs.realpath(safeRoot);
    } catch {}
  }
  throw new Error("Unable to resolve an external temp directory for Node test scripts");
}

function envPathInsideProject(value, projectRoot) {
  if (!value) return false;
  return isSameOrInside(path.resolve(value), projectRoot);
}

const separatorIndex = process.argv.indexOf("--");
const command = separatorIndex >= 0 ? process.argv[separatorIndex + 1] : process.argv[2];
const args = separatorIndex >= 0 ? process.argv.slice(separatorIndex + 2) : process.argv.slice(3);

if (!command) {
  console.error("Usage: node scripts/with-safe-node-temp.mjs -- <command> [...args]");
  process.exit(2);
}

const projectRoot = await fs.realpath(process.cwd());
const safeTempRoot = await resolveSafeTempRoot(projectRoot);
const nodeCompileCache = path.join(safeTempRoot, "node-compile-cache");
await fs.mkdir(nodeCompileCache, { recursive: true });

const env = {
  ...process.env,
  TMPDIR: safeTempRoot,
  TMP: safeTempRoot,
  TEMP: safeTempRoot,
  NODE_COMPILE_CACHE: envPathInsideProject(process.env.NODE_COMPILE_CACHE, projectRoot) ? nodeCompileCache : process.env.NODE_COMPILE_CACHE ?? nodeCompileCache,
};

if (args.includes("--experimental-test-coverage") || envPathInsideProject(process.env.NODE_V8_COVERAGE, projectRoot)) {
  const existingCoverage = process.env.NODE_V8_COVERAGE;
  env.NODE_V8_COVERAGE = existingCoverage && !envPathInsideProject(existingCoverage, projectRoot)
    ? existingCoverage
    : path.join(safeTempRoot, `node-coverage-${process.pid}`);
}

const child = spawn(command, args, { stdio: "inherit", env });
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`${command} exited with signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
