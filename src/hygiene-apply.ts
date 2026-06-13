import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expandWorktreeRoot, loadConfig } from "./config.ts";
import { collectCleanupFingerprint } from "./deletion-fingerprint.ts";
import { getRepoRoot, listWorktrees, runGit } from "./git.ts";
import { isEnoent, isSameOrInside, lstatOrMissing, normalizeRelativePath, parseNullSeparated, recordValue, relativePath, stringArray, uniqueSorted } from "./filesystem-boundaries.ts";
import { getGuardianPaths, readState } from "./state.ts";
import { protectedDirReason, scanWorkspaceHygiene } from "./hygiene-scan.ts";
import type { HygieneCategory, HygieneSeverity } from "./hygiene-scan.ts";

type CleanupPathKind = "directory" | "file" | "other";
type CleanupBlocker = { path?: string; category?: string; reason: string; fatal: boolean };
type CleanupTarget = {
  path: string;
  absolutePath: string;
  category: HygieneCategory;
  severity: HygieneSeverity;
  reason: string;
  kind: CleanupPathKind;
  fingerprint: Array<Record<string, string | number>>;
};

const CLEANUP_CATEGORIES = new Set<HygieneCategory>(["known-cleanable", "nested-git", "suspicious"]);

function cleanupPathKindFromStat(stat: { isDirectory(): boolean; isFile(): boolean }): CleanupPathKind {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return "other";
}

function resolveCleanupPath(repoRoot: string, cleanupPath: string) {
  const absolutePath = path.isAbsolute(cleanupPath) ? path.resolve(cleanupPath) : path.resolve(repoRoot, cleanupPath);
  const relative = relativePath(repoRoot, absolutePath);
  return { absolutePath, relative };
}

async function listTrackedContents(repoRoot: string, relative: string) {
  const result = await runGit(repoRoot, ["ls-files", "-z", "--", relative]);
  return parseNullSeparated(result.stdout).map((entry) => normalizeRelativePath(entry)).sort((left, right) => left.localeCompare(right));
}

async function collectCleanupProtectedRoots(repoRoot: string, config: Record<string, unknown>) {
  const roots = new Map<string, string>();
  const configuredWorktreeRoot = path.resolve(repoRoot, expandWorktreeRoot(String(config.worktreeRoot), repoRoot));
  roots.set(configuredWorktreeRoot, "configured Guardian worktree root");
  for (const entry of await listWorktrees(repoRoot)) {
    const worktreePath = path.resolve(String(entry.path));
    if (worktreePath !== path.resolve(repoRoot)) roots.set(worktreePath, "registered Git worktree path");
  }
  try {
    const state = await readState(await getGuardianPaths(repoRoot), { repoRoot, config });
    for (const session of Object.values(recordValue(state.sessions))) {
      const sessionRecord = recordValue(session);
      if (typeof sessionRecord.worktree_path === "string" && path.resolve(sessionRecord.worktree_path) !== path.resolve(repoRoot)) {
        roots.set(path.resolve(sessionRecord.worktree_path), "registered Guardian session worktree path");
      }
    }
  } catch {}
  return [...roots.entries()].map(([root, reason]) => ({ root, reason })).sort((left, right) => left.root.localeCompare(right.root));
}

function protectedRootBlocker(absolutePath: string, protectedRoots: Array<{ root: string; reason: string }>) {
  return protectedRoots.find((entry) => isSameOrInside(absolutePath, entry.root) || isSameOrInside(entry.root, absolutePath));
}

function createCleanupConfirmToken(preflight: Record<string, unknown>) {
  const material = {
    tool: "guardian_hygiene",
    repoRoot: preflight.repoRoot,
    cleanupPaths: preflight.cleanupPaths,
    allowCategories: preflight.allowCategories,
    allowDirtyNestedGit: preflight.allowDirtyNestedGit,
    targets: (preflight.targets as CleanupTarget[] | undefined ?? []).map((target) => ({
      path: target.path,
      category: target.category,
      kind: target.kind,
      fingerprint: target.fingerprint,
    })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

function cleanupSummary(targets: CleanupTarget[], blockers: CleanupBlocker[], findingCount: number, removedTargets: CleanupTarget[] = []) {
  const byCategory: Record<string, number> = { "known-cleanable": 0, "nested-git": 0, suspicious: 0 };
  for (const target of targets) byCategory[target.category] = (byCategory[target.category] ?? 0) + 1;
  return {
    findingCount,
    approvedTargetCount: targets.length,
    blockedTargetCount: blockers.length,
    fatalBlockerCount: blockers.filter((blocker) => blocker.fatal).length,
    removedTargetCount: removedTargets.length,
    byCategory,
  };
}

function cleanupReport(result: Record<string, unknown>, preflight: Record<string, unknown>, removedTargets: CleanupTarget[] = []) {
  return {
    ...result,
    preflight,
    report: {
      action: result.status,
      mode: preflight.mode,
      repoRoot: preflight.repoRoot,
      cleanupPaths: preflight.cleanupPaths,
      approvedTargets: (preflight.targets as CleanupTarget[] | undefined ?? []).map((target) => target.path),
      removedTargets: removedTargets.map((target) => target.path),
      blockers: preflight.blockers,
      summary: result.summary,
    },
  };
}

async function buildHygieneCleanupPreflight(input: Record<string, unknown>) {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const loadedConfig = input.config && typeof input.config === "object" ? { config: input.config as Record<string, unknown> } : await loadConfig(repoRoot);
  const config = loadedConfig.config;
  const rawAllowCategories = stringArray(input.allowCategories);
  const invalidAllowCategories = rawAllowCategories.filter((category) => !CLEANUP_CATEGORIES.has(category as HygieneCategory));
  const allowCategories = rawAllowCategories.length > 0
    ? uniqueSorted(rawAllowCategories.filter((category) => CLEANUP_CATEGORIES.has(category as HygieneCategory)))
    : uniqueSorted([...CLEANUP_CATEGORIES]);
  const allowDirtyNestedGit = input.allowDirtyNestedGit === true;
  const selectedInput = stringArray(input.cleanupPaths);
  const scan = await scanWorkspaceHygiene({ ...input, repoRoot, config });
  const findings = (scan.findings as Array<Record<string, unknown>> | undefined ?? []).filter((finding) => typeof finding.path === "string");
  const findingsByPath = new Map(findings.map((finding) => [String(finding.path), finding]));
  const blockers: CleanupBlocker[] = invalidAllowCategories.map((category) => ({ category, reason: `unsupported allowCategories entry: ${category}`, fatal: true }));
  if (scan.ok === false) blockers.push({ reason: `guardian_hygiene scan failed: ${String(scan.reason ?? "unknown error")}`, fatal: true });
  const protectedRoots = await collectCleanupProtectedRoots(repoRoot, config);
  const selectedPaths = selectedInput.length > 0
    ? uniqueSorted(selectedInput)
    : findings
      .filter((finding) => allowCategories.includes(String(finding.category)))
      .filter((finding) => allowDirtyNestedGit || !(finding.category === "nested-git" && recordValue(finding.metadata).dirty === true))
      .map((finding) => String(finding.path));

  if (selectedInput.length === 0) {
    for (const finding of findings) {
      const category = String(finding.category);
      const metadata = recordValue(finding.metadata);
      if (!allowCategories.includes(category)) blockers.push({ path: String(finding.path), category, reason: `category ${category} is not allowed for hygiene cleanup`, fatal: false });
      else if (category === "nested-git" && metadata.dirty === true && !allowDirtyNestedGit) blockers.push({ path: String(finding.path), category, reason: "dirty nested Git repositories require allowDirtyNestedGit=true", fatal: false });
    }
  }

  const targets: CleanupTarget[] = [];
  const targetPaths = new Set<string>();
  for (const cleanupPath of selectedPaths) {
    const { absolutePath, relative } = resolveCleanupPath(repoRoot, cleanupPath);
    const finding = findingsByPath.get(relative);
    const pathBlockers: CleanupBlocker[] = [];
    if (!isSameOrInside(absolutePath, path.resolve(repoRoot))) pathBlockers.push({ path: cleanupPath, reason: "cleanup path is outside the repository root", fatal: true });
    if (relative === "." || relative === ".git" || relative.startsWith(".git/")) pathBlockers.push({ path: relative, reason: "repository root and .git metadata cannot be cleanup roots", fatal: true });
    const protectedReason = protectedDirReason(relative);
    if (protectedReason) pathBlockers.push({ path: relative, reason: protectedReason, fatal: true });
    const protectedRoot = protectedRootBlocker(absolutePath, protectedRoots);
    if (protectedRoot) pathBlockers.push({ path: relative, reason: protectedRoot.reason, fatal: true });
    const stat = pathBlockers.length > 0 ? null : await lstatOrMissing(absolutePath);
    if (pathBlockers.length === 0 && stat == null) pathBlockers.push({ path: relative, reason: "selected cleanup path is missing", fatal: true });
    if (stat?.isSymbolicLink()) pathBlockers.push({ path: relative, reason: "symlink cleanup roots are not allowed", fatal: true });
    const trackedContents = pathBlockers.some((blocker) => blocker.fatal) ? [] : await listTrackedContents(repoRoot, relative);
    if (trackedContents.length > 0) pathBlockers.push({ path: relative, reason: "selected cleanup root contains tracked files", fatal: true });
    if (!finding) pathBlockers.push({ path: relative, reason: "selected path is not a current guardian_hygiene finding", fatal: true });
    const category = String(finding?.category ?? "");
    const metadata = recordValue(finding?.metadata);
    if (finding && !allowCategories.includes(category)) pathBlockers.push({ path: relative, category, reason: `category ${category} is not allowed for hygiene cleanup`, fatal: selectedInput.length > 0 });
    if (finding && category === "nested-git" && metadata.dirty === true && !allowDirtyNestedGit) pathBlockers.push({ path: relative, category, reason: "dirty nested Git repositories require allowDirtyNestedGit=true", fatal: true });
    if (pathBlockers.length > 0) {
      blockers.push(...pathBlockers);
      continue;
    }
    if (!stat || !finding || targetPaths.has(relative)) continue;
    try {
      targets.push({ path: relative, absolutePath, category: category as HygieneCategory, severity: String(finding.severity) as HygieneSeverity, reason: String(finding.reason), kind: cleanupPathKindFromStat(stat), fingerprint: await collectCleanupFingerprint(repoRoot, absolutePath) });
      targetPaths.add(relative);
    } catch (error) {
      if (!isEnoent(error)) throw error;
      blockers.push({ path: relative, reason: "cleanup path disappeared during preflight", fatal: selectedInput.length > 0 });
    }
  }

  for (const target of targets) {
    const overlap = targets.find((candidate) => candidate.path !== target.path && isSameOrInside(path.resolve(repoRoot, candidate.path), path.resolve(repoRoot, target.path)));
    if (overlap) blockers.push({ path: target.path, reason: `cleanup paths overlap with ${overlap.path}`, fatal: true });
  }
  const preflight: Record<string, unknown> = { repoRoot: path.resolve(repoRoot), mode: input.mode, cleanupPaths: selectedPaths, allowCategories, allowDirtyNestedGit, targets, blockers, scannedAt: scan.scannedAt, scanSummary: scan.summary };
  preflight.summary = cleanupSummary(targets, blockers, findings.length);
  return preflight;
}

async function removeCleanupTarget(target: CleanupTarget) {
  try {
    await fs.rm(target.absolutePath, { recursive: target.kind === "directory", force: false });
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

export async function runGuardianHygieneMode(input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const mode = input.mode;
  const preflight = await buildHygieneCleanupPreflight(input);
  if (mode !== "plan" && mode !== "apply") {
    const blocker = { reason: "mode must be plan or apply", fatal: true };
    const blockers = [blocker];
    const summary = cleanupSummary([], blockers, 0);
    return cleanupReport({ ok: false, status: "blocked", reason: blocker.reason, summary, targets: [], blockers }, { ...preflight, blockers, summary });
  }
  const targets = preflight.targets as CleanupTarget[];
  const blockers = preflight.blockers as CleanupBlocker[];
  const summary = preflight.summary as Record<string, unknown>;
  const fatalBlockers = blockers.filter((blocker) => blocker.fatal);
  if (fatalBlockers.length > 0 || targets.length === 0) {
    const reason = fatalBlockers.length > 0 ? "hygiene cleanup preflight has fatal blockers" : "no approved hygiene cleanup targets";
    return cleanupReport({ ok: false, status: "blocked", reason, summary, targets, blockers }, preflight);
  }
  const confirmToken = createCleanupConfirmToken(preflight);
  if (mode === "plan") return cleanupReport({ ok: true, status: "planned", confirmToken, summary, targets, blockers, suggestedCommands: ["guardian_hygiene"] }, preflight);
  if (input.confirmToken !== confirmToken) {
    return cleanupReport({ ok: false, status: "blocked", reason: "confirm token mismatch; re-run mode=plan and use the returned confirmToken", tokenMatched: false, summary, targets, blockers }, preflight);
  }
  const removedTargets: CleanupTarget[] = [];
  for (const target of targets) {
    await removeCleanupTarget(target);
    removedTargets.push(target);
  }
  const finalSummary = cleanupSummary(targets, blockers, Number((preflight.scanSummary as Record<string, unknown> | undefined)?.findingCount ?? targets.length), removedTargets);
  return cleanupReport({ ok: true, status: "cleaned", summary: finalSummary, targets, removedTargets, blockers, suggestedCommands: ["guardian_hygiene", "guardian_status"] }, { ...preflight, summary: finalSummary }, removedTargets);
}
