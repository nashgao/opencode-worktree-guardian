import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expandWorktreeRoot, loadConfig } from "./config.ts";
import { getRepoRoot, listWorktrees, runGit, runGitNullSeparated, tryGit } from "./git.ts";
import { getGuardianPaths, readState } from "./state.ts";

export type HygieneSeverity = "warn" | "fail";
export type HygieneCategory = "known-cleanable" | "nested-git" | "suspicious";

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

const PROTECTED_DIR_NAMES = new Set([
  "node_modules",
  "vendor",
  "target",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".next",
  ".turbo",
  ".vite",
  ".parcel-cache",
  ".pnpm-store",
  "out",
  "tmp",
  "temp",
]);

const SUSPICIOUS_NAME_PATTERN = /(^|[-_.])(clone|clones|research|dump|dumps|scratch|sandbox|experiment|prototype|poc|checkout|repo)([-_.]|$)/i;
const RESIDUE_ROOT_PATTERN = /^(guardian-[^/]+|guardian-origin-[^/]+|opencode-temp-[^/]+|omo-research-[^/]+|opencode-research-[^/]+|git-docs-research)$/;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isEnoent(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function normalizeRelativePath(value: string) {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

function relativePath(repoRoot: string, absolutePath: string) {
  return normalizeRelativePath(path.relative(repoRoot, absolutePath)) || ".";
}

function isSameOrInside(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function parseNullSeparated(stdout: string) {
  return stdout.split("\0").map((entry) => entry.trim()).filter(Boolean);
}

async function listCandidatePaths(repoRoot: string) {
  const untracked = await runGitNullSeparated(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const ignored = await runGitNullSeparated(repoRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]);
  return [...new Set([...untracked, ...ignored])]
    .map((entry) => normalizeRelativePath(entry))
    .sort((left, right) => left.localeCompare(right));
}

function protectedDirReason(relative: string) {
  const parts = relative.split("/").filter(Boolean);
  if (relative === ".git" || relative.startsWith(".git/")) {
    return relative === ".git/worktrees" || relative.startsWith(".git/worktrees/") ? "git worktree metadata" : "git metadata";
  }
  const protectedPart = parts.find((part) => PROTECTED_DIR_NAMES.has(part));
  return protectedPart ? `protected ${protectedPart} directory` : null;
}

function knownCleanableMatch(relative: string) {
  const parts = relative.split("/").filter(Boolean);
  if (parts[0] === "data" && /^test-wal-[^/]+$/.test(parts[1] ?? "")) {
    return { path: `data/${parts[1]}`, reason: "known test WAL scratch artifact" };
  }
  for (const [index, part] of parts.entries()) {
    const artifactPath = parts.slice(0, index + 1).join("/");
    if (part === "node-compile-cache") return { path: artifactPath, reason: "generated Node compile cache" };
    if (/^node-coverage-[^/]+$/.test(part)) return { path: artifactPath, reason: "generated Node coverage cache" };
    if (/^tsx-\d+$/.test(part)) return { path: artifactPath, reason: "generated tsx runtime cache" };
    if (/^librarian-[^/]+$/.test(part)) return { path: artifactPath, reason: "known librarian scratch artifact" };
    if (/^[^/]+-librarian$/.test(part)) return { path: artifactPath, reason: "known librarian scratch artifact" };
    if (/^hyperf-[^/]+$/.test(part)) return { path: artifactPath, reason: "known Hyperf scratch artifact" };
    if (part === "test-phpkafka") return { path: artifactPath, reason: "known phpkafka test scratch artifact" };
    if (part === "test-hyperf-kafka") return { path: artifactPath, reason: "known Hyperf Kafka test scratch artifact" };
  }
  return null;
}

function suspiciousPath(relative: string) {
  const parts = relative.split("/").filter(Boolean);
  if (RESIDUE_ROOT_PATTERN.test(parts[0] ?? "")) return parts[0];
  const index = parts.findIndex((part) => SUSPICIOUS_NAME_PATTERN.test(part));
  return index >= 0 ? parts.slice(0, index + 1).join("/") : relative;
}

function residueRoot(relative: string) {
  const root = relative.split("/").filter(Boolean)[0] ?? "";
  return RESIDUE_ROOT_PATTERN.test(root) ? root : null;
}

function shellQuote(value: string) {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

async function pathKind(candidate: string) {
  try {
    const stat = await fs.lstat(candidate);
    return stat.isDirectory() ? "directory" : "file";
  } catch (error) {
    if (isEnoent(error)) return "missing";
    throw error;
  }
}

async function findNestedGitRoot(repoRoot: string, candidatePath: string) {
  let current = await pathKind(candidatePath) === "directory" ? candidatePath : path.dirname(candidatePath);
  const root = path.resolve(repoRoot);
  while (isSameOrInside(current, root) && path.resolve(current) !== root) {
    const marker = path.join(current, ".git");
    try {
      await fs.lstat(marker);
      return current;
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

async function nestedGitMetadata(gitRoot: string) {
  const status = await tryGit(gitRoot, ["status", "--porcelain"]);
  const dirty = status.ok && status.stdout.length > 0;
  return {
    dirty,
    manualReview: true,
    hardDeny: dirty,
    statusAvailable: status.ok,
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown) {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return typeof value === "string" && value.trim().length > 0 ? [value] : [];
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function cleanupPathKindFromStat(stat: { isDirectory(): boolean; isFile(): boolean }): CleanupPathKind {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return "other";
}

async function lstatOrMissing(candidate: string) {
  try {
    return await fs.lstat(candidate);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
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

async function collectCleanupFingerprint(repoRoot: string, absolutePath: string) {
  const entries: Array<Record<string, string | number>> = [];
  async function visit(currentAbsolute: string) {
    const stat = await fs.lstat(currentAbsolute);
    const currentRelative = relativePath(repoRoot, currentAbsolute);
    if (stat.isSymbolicLink()) {
      entries.push({ path: currentRelative, kind: "symlink", target: await fs.readlink(currentAbsolute) });
      return;
    }
    if (stat.isDirectory()) {
      entries.push({ path: currentRelative, kind: "directory" });
      const children = await fs.readdir(currentAbsolute);
      for (const child of children.sort((left, right) => left.localeCompare(right))) await visit(path.join(currentAbsolute, child));
      return;
    }
    if (stat.isFile()) {
      const content = await fs.readFile(currentAbsolute);
      entries.push({ path: currentRelative, kind: "file", size: stat.size, sha256: crypto.createHash("sha256").update(content).digest("hex") });
      return;
    }
    entries.push({ path: currentRelative, kind: "other", size: stat.size });
  }
  await visit(absolutePath);
  return entries;
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
    tool: "guardian_hygiene_cleanup",
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
  const mode = input.mode;
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

    if (!stat || !finding) continue;
    if (targetPaths.has(relative)) continue;
    try {
      targets.push({
        path: relative,
        absolutePath,
        category: category as HygieneCategory,
        severity: String(finding.severity) as HygieneSeverity,
        reason: String(finding.reason),
        kind: cleanupPathKindFromStat(stat),
        fingerprint: await collectCleanupFingerprint(repoRoot, absolutePath),
      });
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

  const preflight: Record<string, unknown> = {
    repoRoot: path.resolve(repoRoot),
    mode,
    cleanupPaths: selectedPaths,
    allowCategories,
    allowDirtyNestedGit,
    targets,
    blockers,
    scannedAt: scan.scannedAt,
    scanSummary: scan.summary,
  };
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

export async function guardianHygieneCleanup(input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
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
  if (mode === "plan") {
    return cleanupReport({ ok: true, status: "planned", confirmToken, summary, targets, blockers, suggestedCommands: ["guardian_hygiene", "guardian_hygiene_cleanup"] }, preflight);
  }

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

export async function guardianHygiene(input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  if (input.mode === "plan" || input.mode === "apply") return guardianHygieneCleanup(input);
  return scanWorkspaceHygiene(input);
}

export async function scanWorkspaceHygiene(input: Record<string, unknown> = {}) {
  const scannedAt = input.scannedAt instanceof Date ? input.scannedAt.toISOString() : new Date().toISOString();
  try {
    const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
    const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
    const loadedConfig = input.config && typeof input.config === "object" ? { config: input.config as Record<string, string> } : await loadConfig(repoRoot);
    const config = loadedConfig.config;
    const worktrees = await listWorktrees(repoRoot);
    const configuredWorktreeRoot = path.resolve(repoRoot, expandWorktreeRoot(String(config.worktreeRoot), repoRoot));
    const protectedRoots = worktrees
      .map((entry) => path.resolve(String(entry.path)))
      .filter((entry) => entry !== path.resolve(repoRoot));
    protectedRoots.push(configuredWorktreeRoot);

    const findings: Array<Record<string, unknown>> = [];
    const exclusionsByPath = new Map<string, Record<string, unknown>>();
    const seenFindings = new Set<string>();
    const candidates = await listCandidatePaths(repoRoot);

    for (const candidate of candidates) {
      const absolutePath = path.resolve(repoRoot, candidate);
      const relative = relativePath(repoRoot, absolutePath);
      const protectedReason = protectedDirReason(relative);
      const protectedRoot = protectedRoots.find((root) => isSameOrInside(absolutePath, root));
      if (protectedReason || protectedRoot) {
        const exclusionPath = protectedRoot ? relativePath(repoRoot, protectedRoot) : relative.split("/")[0];
        exclusionsByPath.set(exclusionPath, {
          path: exclusionPath,
          reason: protectedReason ?? "configured or registered Git worktree path",
        });
        continue;
      }

      const nestedRoot = await findNestedGitRoot(repoRoot, absolutePath);
      if (nestedRoot) {
        const nestedRelative = residueRoot(relative) ?? relativePath(repoRoot, nestedRoot);
        const key = `nested-git:${nestedRelative}`;
        if (!seenFindings.has(key)) {
          const metadata = await nestedGitMetadata(nestedRoot);
          findings.push({
            path: nestedRelative,
            category: "nested-git" satisfies HygieneCategory,
            severity: metadata.dirty ? "fail" satisfies HygieneSeverity : "warn" satisfies HygieneSeverity,
            reason: metadata.dirty ? "nested Git repository has uncommitted changes" : "nested Git repository requires manual review",
            source: "git ls-files --others/--ignored",
            metadata,
          });
          seenFindings.add(key);
        }
        continue;
      }

      const knownMatch = knownCleanableMatch(relative);
      if (knownMatch) {
        const key = `known-cleanable:${knownMatch.path}`;
        if (!seenFindings.has(key)) {
          findings.push({ path: knownMatch.path, category: "known-cleanable" satisfies HygieneCategory, severity: "warn" satisfies HygieneSeverity, reason: knownMatch.reason, source: "git ls-files --others/--ignored" });
          seenFindings.add(key);
        }
        continue;
      }

      const residue = residueRoot(relative);
      if (residue) {
        const key = `suspicious:${residue}`;
        if (!seenFindings.has(key)) {
          findings.push({ path: residue, category: "suspicious" satisfies HygieneCategory, severity: "warn" satisfies HygieneSeverity, reason: "untracked path resembles a clone, research dump, or scratch workspace", source: "git ls-files --others/--ignored" });
          seenFindings.add(key);
        }
        continue;
      }

      const baseName = path.basename(relative);
      if (SUSPICIOUS_NAME_PATTERN.test(relative) || SUSPICIOUS_NAME_PATTERN.test(baseName)) {
        const findingPath = suspiciousPath(relative);
        const key = `suspicious:${findingPath}`;
        if (!seenFindings.has(key)) {
          findings.push({ path: findingPath, category: "suspicious" satisfies HygieneCategory, severity: "warn" satisfies HygieneSeverity, reason: "untracked path resembles a clone, research dump, or scratch workspace", source: "git ls-files --others/--ignored" });
          seenFindings.add(key);
        }
      }
    }

    findings.sort((left, right) => String(left.path).localeCompare(String(right.path)) || String(left.category).localeCompare(String(right.category)));
    const exclusions = [...exclusionsByPath.values()].sort((left, right) => String(left.path).localeCompare(String(right.path)));
    const summary: {
      candidateCount: number;
      findingCount: number;
      exclusionCount: number;
      bySeverity: Record<string, number>;
      byCategory: Record<string, number>;
    } = {
      candidateCount: candidates.length,
      findingCount: findings.length,
      exclusionCount: exclusions.length,
      bySeverity: { warn: 0, fail: 0 },
      byCategory: { "known-cleanable": 0, "nested-git": 0, suspicious: 0 },
    };
    for (const finding of findings) {
      const severity = String(finding.severity);
      const category = String(finding.category);
      summary.bySeverity[severity] = (summary.bySeverity[severity] ?? 0) + 1;
      summary.byCategory[category] = (summary.byCategory[category] ?? 0) + 1;
    }

    const nestedCommands = findings
      .filter((finding) => finding.category === "nested-git")
      .map((finding) => `git -C ${shellQuote(String(finding.path))} status --short`);

    return {
      ok: true,
      repoRoot,
      summary,
      findings,
      exclusions,
      scannedAt,
      suggestedCommands: ["guardian_hygiene", "guardian_status", "git status --short --ignored", ...nestedCommands],
    };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      reason: errorMessage(error),
      failureReason: errorMessage(error),
      summary: {
        scanFailed: true,
        candidateCount: 0,
        findingCount: 0,
        exclusionCount: 0,
        bySeverity: { warn: 0, fail: 0 },
        byCategory: { "known-cleanable": 0, "nested-git": 0, suspicious: 0 },
      },
      findings: [],
      exclusions: [],
      scannedAt,
      suggestedCommands: ["guardian_hygiene", "guardian_status"],
    };
  }
}
