import path from "node:path";
import { expandWorktreeRoot, loadConfig } from "./config.ts";
import { collectDeleteFingerprint } from "./deletion-fingerprint.ts";
import { getRepoRoot, listWorktrees, runGit, tryGit } from "./git.ts";
import { isEnoent, isSameOrInside, lstatOrMissing, normalizeRelativePath, parseNullSeparated, recordValue, relativePath, stringArray, uniqueSorted } from "./filesystem-boundaries.ts";
import { getGuardianPaths, readState } from "./state.ts";

export type DeletePathKind = "directory" | "file" | "symlink" | "other" | "missing";
export type DeletePathStatus = "tracked" | "ignored" | "untracked" | "missing";
export type DeletePathBlocker = { path?: string; reason: string; fatal: boolean };
export type DeletePathTarget = {
  path: string;
  absolutePath: string;
  kind: DeletePathKind;
  status: DeletePathStatus;
  trackedContents: string[];
  ignored: boolean;
  fingerprint: Array<Record<string, string | number>>;
};

const PROTECTED_PATH_ROOTS = new Set([".opencode", "node_modules", "vendor", ".pnpm-store"]);

function pathKind(stat: Awaited<ReturnType<typeof lstatOrMissing>>): DeletePathKind {
  if (!stat) return "missing";
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return "other";
}

function resolveDeletePath(repoRoot: string, deletePath: string) {
  const absolutePath = path.isAbsolute(deletePath) ? path.resolve(deletePath) : path.resolve(repoRoot, deletePath);
  const relative = relativePath(repoRoot, absolutePath);
  return { absolutePath, relative };
}

async function listTrackedContents(repoRoot: string, relative: string) {
  const result = await runGit(repoRoot, ["ls-files", "-z", "--", relative]);
  return parseNullSeparated(result.stdout).map((entry) => normalizeRelativePath(entry)).sort((left, right) => left.localeCompare(right));
}

async function isIgnoredPath(repoRoot: string, relative: string) {
  const result = await tryGit(repoRoot, ["check-ignore", "--quiet", "--", relative]);
  return result.ok;
}

function protectedPathReason(relative: string) {
  if (relative === ".git" || relative.startsWith(".git/")) return "git metadata";
  const firstPart = relative.split("/").filter(Boolean)[0] ?? "";
  return PROTECTED_PATH_ROOTS.has(firstPart) ? `protected ${firstPart} path` : null;
}

async function collectDeleteProtectedRoots(repoRoot: string, cwd: string, config: Record<string, unknown>) {
  const roots = new Map<string, { reason: string; blockInside: boolean }>();
  const configuredWorktreeRoot = path.resolve(repoRoot, expandWorktreeRoot(String(config.worktreeRoot), repoRoot));
  roots.set(configuredWorktreeRoot, { reason: "configured Guardian worktree root", blockInside: true });
  try {
    const currentRoot = await getRepoRoot(cwd);
    roots.set(path.resolve(currentRoot), { reason: "current worktree root", blockInside: false });
  } catch {}
  for (const entry of await listWorktrees(repoRoot)) {
    const worktreePath = path.resolve(String(entry.path));
    if (worktreePath !== path.resolve(repoRoot)) roots.set(worktreePath, { reason: "registered Git worktree path", blockInside: true });
  }
  try {
    const state = await readState(await getGuardianPaths(repoRoot), { repoRoot, config });
    for (const session of Object.values(recordValue(state.sessions))) {
      const sessionRecord = recordValue(session);
      if (typeof sessionRecord.worktree_path === "string" && path.resolve(sessionRecord.worktree_path) !== path.resolve(repoRoot)) {
        roots.set(path.resolve(sessionRecord.worktree_path), { reason: "registered Guardian session worktree path", blockInside: true });
      }
    }
  } catch {}
  return [...roots.entries()].map(([root, metadata]) => ({ root, ...metadata })).sort((left, right) => left.root.localeCompare(right.root));
}

function protectedRootBlocker(absolutePath: string, protectedRoots: Array<{ root: string; reason: string; blockInside: boolean }>) {
  return protectedRoots.find((entry) => {
    const resolved = path.resolve(absolutePath);
    return resolved === entry.root || isSameOrInside(entry.root, resolved) || entry.blockInside && isSameOrInside(resolved, entry.root);
  });
}

export function deleteSummary(targets: DeletePathTarget[], blockers: DeletePathBlocker[], removedTargets: DeletePathTarget[] = []) {
  return {
    approvedTargetCount: targets.length,
    blockedTargetCount: blockers.length,
    fatalBlockerCount: blockers.filter((blocker) => blocker.fatal).length,
    removedTargetCount: removedTargets.length,
    trackedTargetCount: targets.filter((target) => target.trackedContents.length > 0).length,
    directoryTargetCount: targets.filter((target) => target.kind === "directory").length,
  };
}

export async function buildDeletePathsPreflight(input: Record<string, unknown>) {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = path.resolve(typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd));
  const loadedConfig = input.config && typeof input.config === "object" ? { config: input.config as Record<string, unknown> } : await loadConfig(repoRoot);
  const config = loadedConfig.config;
  const allowTracked = input.allowTracked === true;
  const allowRecursive = input.allowRecursive === true;
  const paths = uniqueSorted(stringArray(input.paths));
  const blockers: DeletePathBlocker[] = [];
  if (paths.length === 0) blockers.push({ reason: "paths must include at least one path", fatal: true });
  const protectedRoots = await collectDeleteProtectedRoots(repoRoot, cwd, config);
  const targets: DeletePathTarget[] = [];
  const seenTargets = new Set<string>();
  for (const requestedPath of paths) {
    const { absolutePath, relative } = resolveDeletePath(repoRoot, requestedPath);
    const pathBlockers: DeletePathBlocker[] = [];
    if (!isSameOrInside(absolutePath, repoRoot)) pathBlockers.push({ path: requestedPath, reason: "delete path is outside the repository root", fatal: true });
    if (relative === ".") pathBlockers.push({ path: relative, reason: "repository root cannot be deleted by guardian_delete_paths", fatal: true });
    const protectedReason = protectedPathReason(relative);
    if (protectedReason) pathBlockers.push({ path: relative, reason: protectedReason, fatal: true });
    const protectedRoot = protectedRootBlocker(absolutePath, protectedRoots);
    if (protectedRoot) pathBlockers.push({ path: relative, reason: protectedRoot.reason, fatal: true });
    const stat = pathBlockers.length > 0 ? null : await lstatOrMissing(absolutePath);
    const kind = pathKind(stat);
    if (pathBlockers.length === 0 && stat == null) pathBlockers.push({ path: relative, reason: "delete path is missing", fatal: true });
    if (kind === "symlink") pathBlockers.push({ path: relative, reason: "symlink delete roots are not allowed", fatal: true });
    if (kind === "directory" && !allowRecursive) pathBlockers.push({ path: relative, reason: "directory deletion requires allowRecursive=true", fatal: true });
    const trackedContents = pathBlockers.some((blocker) => blocker.fatal) ? [] : await listTrackedContents(repoRoot, relative);
    const ignored = pathBlockers.some((blocker) => blocker.fatal) ? false : await isIgnoredPath(repoRoot, relative);
    const status: DeletePathStatus = stat == null ? "missing" : trackedContents.length > 0 ? "tracked" : ignored ? "ignored" : "untracked";
    if (trackedContents.length > 0 && !allowTracked) pathBlockers.push({ path: relative, reason: "tracked source deletion requires allowTracked=true", fatal: true });
    if (pathBlockers.length > 0) {
      blockers.push(...pathBlockers);
      continue;
    }
    if (!stat || seenTargets.has(relative)) continue;
    try {
      targets.push({ path: relative, absolutePath, kind, status, trackedContents, ignored, fingerprint: await collectDeleteFingerprint(repoRoot, absolutePath) });
      seenTargets.add(relative);
    } catch (error) {
      if (!isEnoent(error)) throw error;
      blockers.push({ path: relative, reason: "delete path disappeared during preflight", fatal: true });
    }
  }
  for (const target of targets) {
    const overlap = targets.find((candidate) => candidate.path !== target.path && isSameOrInside(path.resolve(repoRoot, candidate.path), path.resolve(repoRoot, target.path)));
    if (overlap) blockers.push({ path: target.path, reason: `delete paths overlap with ${overlap.path}`, fatal: true });
  }
  const preflight: Record<string, unknown> = { repoRoot, mode: input.mode, paths, allowTracked, allowRecursive, targets, blockers };
  preflight.summary = deleteSummary(targets, blockers);
  return preflight;
}
