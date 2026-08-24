#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const coverageRunName = "OPENCODE_WORKTREE_GUARDIAN_COVERAGE_RUN";
const capabilityName = "OPENCODE_WORKTREE_GUARDIAN_COVERAGE_CAPABILITY";
const markerName = ".owg-coverage-capability";
const safeRootName = "opencode-worktree-guardian-node";
const shutdownSignals = ["SIGTERM", "SIGINT", "SIGHUP"];
const fallbackTempRoots = ["/tmp/opencode", path.join(os.homedir(), ".cache", "opencode", "tmp")];

function isSameOrInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isMissing(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function nearestExistingAncestor(candidate) {
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

async function isInsideGitWorktree(candidate) {
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

async function isExternalPath(candidate, projectRoot) {
  if (!candidate) return false;
  const ancestor = await nearestExistingAncestor(candidate);
  return !isSameOrInside(ancestor, projectRoot) && !await isInsideGitWorktree(ancestor);
}

function findSafeRootAncestor(candidate) {
  let current = candidate;
  while (true) {
    if (path.basename(current) === safeRootName) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function safeTempRoot(projectRoot) {
  for (const candidate of [os.tmpdir(), ...fallbackTempRoots]) {
    try {
      await fs.mkdir(candidate, { recursive: true });
      const canonicalCandidate = await fs.realpath(candidate);
      if (isSameOrInside(canonicalCandidate, projectRoot) || await isInsideGitWorktree(canonicalCandidate)) continue;
      const root = findSafeRootAncestor(canonicalCandidate) ?? path.join(canonicalCandidate, safeRootName);
      await fs.mkdir(root, { recursive: true });
      if ((await fs.lstat(root)).isSymbolicLink()) continue;
      const canonicalRoot = await fs.realpath(root);
      if (!isSameOrInside(canonicalRoot, projectRoot) && !await isInsideGitWorktree(canonicalRoot)) return canonicalRoot;
    } catch (error) {
      if (error instanceof Error) continue;
      throw error;
    }
  }
  throw new Error("Unable to resolve an external temp directory for Node test scripts");
}

async function createCoverageContext(root) {
  const runRoot = await fs.mkdtemp(path.join(root, "coverage-run-"));
  try {
    const capability = crypto.randomBytes(32).toString("hex");
    await fs.writeFile(path.join(runRoot, markerName), capability, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const coverage = path.join(runRoot, "coverage");
    const compile = path.join(runRoot, "compile-cache");
    await Promise.all([fs.mkdir(coverage), fs.mkdir(compile)]);
    return { capability, compile, coverage, root: runRoot };
  } catch (error) {
    await fs.rm(runRoot, { recursive: true, force: true });
    throw error;
  }
}

async function validateCoverageContext(root, capability, coverage, compile, projectRoot, tempRoot) {
  if (!root || !capability || !coverage || !compile) return undefined;
  try {
    const [rootStat, coverageStat, compileStat] = await Promise.all([fs.lstat(root), fs.lstat(coverage), fs.lstat(compile)]);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !coverageStat.isDirectory() || coverageStat.isSymbolicLink() || !compileStat.isDirectory() || compileStat.isSymbolicLink()) return undefined;
    const [canonicalRoot, canonicalCoverage, canonicalCompile] = await Promise.all([fs.realpath(root), fs.realpath(coverage), fs.realpath(compile)]);
    if (!isSameOrInside(canonicalRoot, tempRoot) || isSameOrInside(canonicalRoot, projectRoot) || await isInsideGitWorktree(canonicalRoot)) return undefined;
    if (path.dirname(canonicalRoot) !== tempRoot || !path.basename(canonicalRoot).startsWith("coverage-run-")) return undefined;
    if (canonicalCoverage !== path.join(canonicalRoot, "coverage") || canonicalCompile !== path.join(canonicalRoot, "compile-cache")) return undefined;
    const marker = path.join(canonicalRoot, markerName);
    const [stat, markerValue] = await Promise.all([fs.lstat(marker), fs.readFile(marker, "utf8")]);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || markerValue !== capability) return undefined;
    return { capability, compile: canonicalCompile, coverage: canonicalCoverage, root: canonicalRoot };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function inheritedCoverageContext(projectRoot, tempRoot) {
  return validateCoverageContext(
    process.env[coverageRunName],
    process.env[capabilityName],
    process.env.NODE_V8_COVERAGE,
    process.env.NODE_COMPILE_CACHE,
    projectRoot,
    tempRoot,
  );
}

async function removeOwnedCoverageContext(context, projectRoot, tempRoot) {
  const validated = await validateCoverageContext(context.root, context.capability, context.coverage, context.compile, projectRoot, tempRoot);
  if (!validated || validated.root !== context.root) throw new Error("Refusing to remove an altered coverage context");
  await fs.rm(validated.root, { recursive: true, force: true });
}

function waitForChild(child) {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ kind: "error", error }));
    child.once("close", (code, signal) => resolve({ kind: "close", code, signal }));
  });
}

const separator = process.argv.indexOf("--");
const command = separator >= 0 ? process.argv[separator + 1] : process.argv[2];
const args = separator >= 0 ? process.argv.slice(separator + 2) : process.argv.slice(3);
if (!command) {
  console.error("Usage: node scripts/with-safe-node-temp.mjs -- <command> [...args]");
  process.exit(2);
}

const projectRoot = await fs.realpath(process.cwd());
const tempRoot = await safeTempRoot(projectRoot);
const explicitlyRequestsCoverage = args.includes("--experimental-test-coverage");
const callerCoverageIsExternal = await isExternalPath(process.env.NODE_V8_COVERAGE, projectRoot);
const coverageRequested = explicitlyRequestsCoverage || Boolean(process.env.NODE_V8_COVERAGE) && !callerCoverageIsExternal;
let ownedContext;
try {
  const inheritedContext = coverageRequested ? await inheritedCoverageContext(projectRoot, tempRoot) : undefined;
  ownedContext = coverageRequested && !inheritedContext ? await createCoverageContext(tempRoot) : undefined;
  const context = inheritedContext ?? ownedContext;
  const callerCompileIsExternal = await isExternalPath(process.env.NODE_COMPILE_CACHE, projectRoot);
  const sharedCompile = path.join(tempRoot, "node-compile-cache");
  if (!context && !callerCompileIsExternal) await fs.mkdir(sharedCompile, { recursive: true });
  const env = {
    ...process.env,
    TMPDIR: context?.root ?? tempRoot,
    TMP: context?.root ?? tempRoot,
    TEMP: context?.root ?? tempRoot,
    NODE_COMPILE_CACHE: context?.compile ?? (callerCompileIsExternal ? process.env.NODE_COMPILE_CACHE : sharedCompile),
    NODE_V8_COVERAGE: context?.coverage ?? (callerCoverageIsExternal ? process.env.NODE_V8_COVERAGE : ""),
    [coverageRunName]: context?.root ?? "",
    [capabilityName]: context?.capability ?? "",
  };
  const child = spawn(command, args, { env, stdio: "inherit" });
  const listeners = new Map();
  let forwardedSignal;
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
  const contextToClean = ownedContext;
  ownedContext = undefined;
  if (contextToClean) await removeOwnedCoverageContext(contextToClean, projectRoot, tempRoot);
  if (forwardedSignal) process.kill(process.pid, forwardedSignal);
  if (outcome.kind === "error") throw outcome.error;
  process.exitCode = outcome.signal ? 1 : (outcome.code ?? 1);
} catch (error) {
  const contextToClean = ownedContext;
  ownedContext = undefined;
  if (contextToClean) await removeOwnedCoverageContext(contextToClean, projectRoot, tempRoot);
  throw error;
}
