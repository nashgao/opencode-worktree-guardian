#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const safeTempDirectoryName = "opencode-worktree-guardian-node";
const coverageRunEnvName = "OPENCODE_WORKTREE_GUARDIAN_COVERAGE_RUN";
const fallbackTempBases = [
  path.join("/tmp", "opencode"),
  path.join(os.homedir(), ".cache", "opencode", "tmp"),
];

function isSameOrInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function findExistingSafeTempRoot(candidate) {
  const matches = [];
  let current = path.resolve(candidate);
  while (true) {
    if (path.basename(current) === safeTempDirectoryName) matches.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return matches.at(-1);
}

async function resolveSafeTempRoot(projectRoot) {
  for (const candidate of [os.tmpdir(), ...fallbackTempBases]) {
    try {
      const candidatePath = path.resolve(candidate);
      await fs.mkdir(candidatePath, { recursive: true });
      const realCandidate = await fs.realpath(candidatePath);
      if (isSameOrInside(realCandidate, projectRoot)) continue;
      const existingSafeRoot = findExistingSafeTempRoot(realCandidate);
      if (existingSafeRoot && !isSameOrInside(existingSafeRoot, projectRoot)) return existingSafeRoot;
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

function envPathInsideCoverageRun(value, coverageRunRoot) {
  if (!value || !coverageRunRoot) return false;
  const runRoot = path.resolve(coverageRunRoot);
  if (!path.basename(runRoot).startsWith("coverage-run-")) return false;
  const relative = path.relative(runRoot, path.resolve(value));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const [coverageDirectory, ...rest] = relative.split(path.sep);
  return Boolean(coverageDirectory) && coverageDirectory.startsWith("node-coverage-") && rest.length === 0;
}

function envPathInsideNodeTestCoverage(value, safeTempRoot, coverageRunRoot) {
  if (!value || !coverageRunRoot) return false;
  const runRoot = path.resolve(coverageRunRoot);
  if (!path.basename(runRoot).startsWith("coverage-run-")) return false;
  const coveragePath = path.resolve(value);
  return path.dirname(coveragePath) === safeTempRoot && path.basename(coveragePath).startsWith("node-coverage-");
}

function envPathMatchesCoverageCompileCache(value, coverageRunRoot, safeTempRoot) {
  if (!value || !coverageRunRoot) return false;
  const runRoot = path.resolve(coverageRunRoot);
  if (!path.basename(runRoot).startsWith("coverage-run-")) return false;
  const compileCache = path.resolve(value);
  return path.dirname(compileCache) === path.dirname(safeTempRoot)
    && path.basename(compileCache).startsWith(`node-compile-cache-${path.basename(runRoot)}-`);
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
const explicitCoverageRequested = args.includes("--experimental-test-coverage");
const coverageRequested = explicitCoverageRequested || envPathInsideProject(process.env.NODE_V8_COVERAGE, projectRoot);
const inheritedCoverageRun = process.env[coverageRunEnvName];
const existingCoverage = process.env.NODE_V8_COVERAGE;
const coverageInheritedFromWrapper = envPathInsideCoverageRun(existingCoverage, inheritedCoverageRun);
const coverageInheritedFromNodeTest = envPathInsideNodeTestCoverage(existingCoverage, safeTempRoot, inheritedCoverageRun);
const coverageTempRoot = coverageRequested && (coverageInheritedFromWrapper || coverageInheritedFromNodeTest)
  ? path.resolve(inheritedCoverageRun)
  : coverageRequested
    ? await fs.mkdtemp(path.join(safeTempRoot, "coverage-run-"))
    : safeTempRoot;
const activeCoverageRoot = coverageInheritedFromWrapper || coverageInheritedFromNodeTest ? path.resolve(inheritedCoverageRun) : coverageRequested ? coverageTempRoot : undefined;
const defaultNodeCompileCache = activeCoverageRoot
  ? await fs.mkdtemp(path.join(path.dirname(safeTempRoot), `node-compile-cache-${path.basename(activeCoverageRoot)}-`))
  : path.join(safeTempRoot, "node-compile-cache");
const existingCompileCache = process.env.NODE_COMPILE_CACHE;
const existingCompileCacheMatchesCoverageRun = envPathMatchesCoverageCompileCache(existingCompileCache, activeCoverageRoot, safeTempRoot);
const nodeCompileCache = existingCompileCache && !envPathInsideProject(existingCompileCache, projectRoot) && (!activeCoverageRoot || existingCompileCacheMatchesCoverageRun)
  ? existingCompileCache
  : defaultNodeCompileCache;
await fs.mkdir(nodeCompileCache, { recursive: true });

const env = {
  ...process.env,
  TMPDIR: safeTempRoot,
  TMP: safeTempRoot,
  TEMP: safeTempRoot,
  NODE_COMPILE_CACHE: nodeCompileCache,
};

if (coverageRequested) {
  env[coverageRunEnvName] = coverageTempRoot;
  env.NODE_V8_COVERAGE = existingCoverage && (coverageInheritedFromWrapper || coverageInheritedFromNodeTest || !explicitCoverageRequested && !envPathInsideProject(existingCoverage, projectRoot))
    ? existingCoverage
    : await fs.mkdtemp(path.join(coverageTempRoot, "node-coverage-"));
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
