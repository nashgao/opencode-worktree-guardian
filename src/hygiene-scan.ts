import fs from "node:fs/promises";
import path from "node:path";
import { compareCodeUnits } from "./code-unit-order.ts";
import { expandWorktreeRoot, loadConfig } from "./config.ts";
import { knownCleanableMatch } from "./hygiene-classification.ts";
import type { HygieneCategory, HygieneSeverity } from "./hygiene-classification.ts";
import { getRepoRoot, listWorktrees, runGitNullSeparated, tryGit } from "./git.ts";
import { isEnoent, isSameOrInside, relativePath } from "./filesystem-boundaries.ts";
import { listCandidatePaths } from "./hygiene-candidates.ts";
import type { NullSeparatedRunner, ReviewableCandidateInput } from "./hygiene-candidates.ts";
import { buildProtectedInventory, PROTECTED_INVENTORY_MAX_ROOTS } from "./hygiene-protected-inventory.ts";
import type { ProtectedInventorySeed } from "./hygiene-protected-inventory.ts";
import { createProtectedRootCollector, createProtectedSeedCollector } from "./hygiene-protected-roots.ts";
import { buildReviewableCandidates } from "./hygiene-reviewable.ts";
import type { ReviewableCandidate } from "./hygiene-reviewable.ts";
import type { FilesystemOnlyEmptyDirectory, HygieneScanResult, HygieneSummary } from "./hygiene-scan-result.ts";
import { DEFAULT_EMPTY_DIRECTORY_MAX_DEPTH, DEFAULT_EMPTY_DIRECTORY_MAX_ENTRIES, scanEmptyDirectories } from "./hygiene-empty-directories.ts";
import { HYGIENE_OPERATIONAL_SCOPE } from "./operational-scope.ts";
import { protectedPathMatch, protectedPathsFromConfig } from "./protected-paths.ts";

export type { HygieneCategory, HygieneSeverity } from "./hygiene-classification.ts";
export type { FilesystemOnlyEmptyDirectory, HygieneScanResult, HygieneSummary } from "./hygiene-scan-result.ts";

const PROTECTED_DIR_NAMES = new Set([
  "node_modules", "vendor", "target", "dist", "build", "coverage",
  ".cache", ".next", ".turbo", ".vite", ".parcel-cache", ".pnpm-store",
  "out", "tmp", "temp",
]);

const SUSPICIOUS_NAME_PATTERN = /(^|[-_.])(clone|clones|research|dump|dumps|scratch|sandbox|experiment|prototype|poc|checkout|repo)([-_.]|$)/i;
const RESIDUE_ROOT_PATTERN = /^(guardian-[^/]+|guardian-origin-[^/]+|opencode-temp-[^/]+|omo-research-[^/]+|opencode-research-[^/]+|git-docs-research)$/;


export function protectedDirReason(relative: string, protectedPaths: readonly string[] = []) {
  const parts = relative.split("/").filter(Boolean);
  if (parts[0] === ".git") {
    return relative === ".git/worktrees" || relative.startsWith(".git/worktrees/") ? "git worktree metadata" : "git metadata";
  }
  if (parts.includes(".git")) return "nested Git metadata";
  const protectedPath = protectedPathMatch(relative, protectedPaths);
  if (protectedPath) return protectedPath.reason;
  const protectedPart = parts.find((part) => PROTECTED_DIR_NAMES.has(part));
  return protectedPart ? `protected ${protectedPart} directory` : null;
}

function protectedDirExclusionPath(relative: string, protectedPaths: readonly string[]) {
  const protectedPath = protectedPathMatch(relative, protectedPaths);
  if (protectedPath) return protectedPath.path;
  const parts = relative.split("/").filter(Boolean);
  return parts.slice(0, parts.findIndex((part) => PROTECTED_DIR_NAMES.has(part)) + 1).join("/") || parts[0] || relative;
}


function suspiciousPath(relative: string) {
  const parts = relative.split("/").filter(Boolean); if (RESIDUE_ROOT_PATTERN.test(parts[0] ?? "")) return parts[0];
  const index = parts.slice(0, -1).findIndex((part) => SUSPICIOUS_NAME_PATTERN.test(part));
  return index >= 0 ? parts.slice(0, index + 1).join("/") : relative;
}

export function residueRoot(relative: string) {
  const parts = relative.split("/").filter(Boolean);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (RESIDUE_ROOT_PATTERN.test(parts[index] ?? "")) return parts.slice(0, index + 1).join("/");
  }
  return null;
}

function shellQuote(value: string) {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

async function pathKind(candidate: string): Promise<"directory" | "file" | "missing"> {
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
  return { dirty, manualReview: true, hardDeny: dirty, statusAvailable: status.ok };
}

function emptyDirectoryLimit(input: Record<string, unknown>, key: "emptyDirectoryMaxDepth" | "emptyDirectoryMaxEntries", fallback: number): number {
  const value = input[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function emptyDirectoryFinding(directory: string): FilesystemOnlyEmptyDirectory {
  const known = knownCleanableMatch(directory);
  return known
    ? { path: directory, classification: "known-cleanable", reason: known.reason, source: "filesystem empty-directory scan" }
    : { path: directory, classification: "reviewable", reason: "filesystem-only empty directory requires review", source: "filesystem empty-directory scan" };
}

function emptyDirectorySummary(scan: Awaited<ReturnType<typeof scanEmptyDirectories>>) {
  return {
    filesystemOnlyEmptyDirectoryCount: scan.directories.length,
    filesystemOnlyEmptyDirectoryMaxDepth: scan.maximumDepth,
    filesystemOnlyEmptyDirectoryMaxEntries: scan.maximumEntries,
    filesystemOnlyEmptyDirectoryScanComplete: scan.complete,
    filesystemOnlyEmptyDirectoryScannedEntryCount: scan.scannedEntryCount,
  };
}

export async function scanWorkspaceHygiene(input: Record<string, unknown> = {}): Promise<HygieneScanResult> {
  const scannedAt = input.scannedAt instanceof Date ? input.scannedAt.toISOString() : new Date().toISOString();
  try {
    const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
    const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
    const loadedConfig = input.config && typeof input.config === "object" ? { config: input.config as Record<string, string> } : await loadConfig(repoRoot);
    const config = loadedConfig.config;
    const protectedPaths = protectedPathsFromConfig(config);
    const worktrees = await listWorktrees(repoRoot);
    const configuredWorktreeRoot = path.resolve(repoRoot, expandWorktreeRoot(String(config.worktreeRoot), repoRoot));
    const protectedRoots = [configuredWorktreeRoot, ...worktrees.map((entry) => path.resolve(String(entry.path))).filter((entry) => entry !== path.resolve(repoRoot) && isSameOrInside(entry, path.resolve(repoRoot)))].sort(compareCodeUnits);
    const findings: Array<Record<string, unknown>> = [];
    const protectedRootCollector = createProtectedRootCollector(repoRoot, PROTECTED_INVENTORY_MAX_ROOTS);
    const recordProtectedExclusion = (seed: ProtectedInventorySeed) => protectedRootCollector.add(seed);
    const protectedSeedCollector = createProtectedSeedCollector();
    const reviewableCandidateInputs: ReviewableCandidateInput[] = [];
    const seenFindings = new Set<string>();
    for (const protectedPath of protectedPaths) {
      if (await pathKind(path.resolve(repoRoot, protectedPath)) !== "missing") {
        protectedSeedCollector.add({ path: protectedPath, reason: `configured protected path ${protectedPath}` });
      }
    }
    for (const protectedRoot of protectedRoots) {
      if (isSameOrInside(protectedRoot, path.resolve(repoRoot)) && await pathKind(protectedRoot) !== "missing") {
        const protectedRelative = relativePath(repoRoot, protectedRoot);
        protectedSeedCollector.add({ path: protectedRelative, reason: "configured or registered Git worktree path" });
      }
    }
    const candidates = await listCandidatePaths(
      repoRoot,
      typeof input.runGitNullSeparated === "function" ? input.runGitNullSeparated as NullSeparatedRunner : runGitNullSeparated,
    );
    const emptyDirectoryScan = await scanEmptyDirectories({
      repoRoot,
      maximumDepth: emptyDirectoryLimit(input, "emptyDirectoryMaxDepth", DEFAULT_EMPTY_DIRECTORY_MAX_DEPTH),
      maximumEntries: emptyDirectoryLimit(input, "emptyDirectoryMaxEntries", DEFAULT_EMPTY_DIRECTORY_MAX_ENTRIES),
      exclude: (relative) => {
        const protectedReason = protectedDirReason(relative, protectedPaths);
        if (protectedReason) return protectedReason;
        const absolutePath = path.resolve(repoRoot, relative);
        return protectedRoots.some((root) => isSameOrInside(absolutePath, root)) ? "configured or registered Git worktree path" : null;
      },
    });
    for (const exclusion of emptyDirectoryScan.excluded) {
      if (exclusion.reason !== "git metadata" && exclusion.reason !== "git worktree metadata" && exclusion.reason !== "nested Git metadata") protectedSeedCollector.add({ path: exclusion.path, reason: exclusion.reason });
    }
    for (const candidate of candidates) {
      const absolutePath = path.resolve(repoRoot, candidate.path);
      const relative = relativePath(repoRoot, absolutePath);
      const protectedReason = protectedDirReason(relative, protectedPaths);
      const protectedRoot = protectedRoots.find((root) => isSameOrInside(absolutePath, root));
      if (protectedReason || protectedRoot) {
        const exclusionPath = protectedReason
          ? protectedDirExclusionPath(relative, protectedPaths)
          : protectedRoot ? relativePath(repoRoot, protectedRoot) : relative;
        protectedSeedCollector.add({ path: exclusionPath, reason: protectedReason ?? "configured or registered Git worktree path" });
        continue;
      }
      const nestedRoot = await findNestedGitRoot(repoRoot, absolutePath);
      if (nestedRoot) {
        const nestedRelative = residueRoot(relative) ?? relativePath(repoRoot, nestedRoot);
        const key = `nested-git:${nestedRelative}`;
        if (!seenFindings.has(key)) {
          const metadata = await nestedGitMetadata(nestedRoot);
          findings.push({ path: nestedRelative, category: "nested-git" satisfies HygieneCategory, severity: metadata.dirty ? "fail" satisfies HygieneSeverity : "warn" satisfies HygieneSeverity, reason: metadata.dirty ? "nested Git repository has uncommitted changes" : "nested Git repository requires manual review", source: "git ls-files --others/--ignored", metadata });
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
      const findingPath = suspiciousPath(relative);
      if (findingPath !== relative) {
        const key = `suspicious:${findingPath}`;
        if (!seenFindings.has(key)) {
          findings.push({ path: findingPath, category: "suspicious" satisfies HygieneCategory, severity: "warn" satisfies HygieneSeverity, reason: "untracked path resembles a clone, research dump, or scratch workspace", source: "git ls-files --others/--ignored" });
          seenFindings.add(key);
        }
        continue;
      }
      reviewableCandidateInputs.push({ path: relative, status: candidate.status });
    }
    protectedSeedCollector.entries().forEach(recordProtectedExclusion);
    const filesystemOnlyEmptyDirectories = emptyDirectoryScan.directories.map(emptyDirectoryFinding);
    for (const directory of filesystemOnlyEmptyDirectories) {
      const key = `filesystem-only-empty-directory:${directory.path}`;
      if (!seenFindings.has(key)) {
        findings.push({ path: directory.path, category: "filesystem-only-empty-directory" satisfies HygieneCategory, classification: directory.classification, severity: "warn" satisfies HygieneSeverity, reason: directory.reason, source: directory.source });
        seenFindings.add(key);
      }
    }
    findings.sort((left, right) => String(left.path).localeCompare(String(right.path)) || String(left.category).localeCompare(String(right.category)));
    const protectedInventory = await buildProtectedInventory(repoRoot, protectedRootCollector.entries(), {
      rootsTruncated: protectedRootCollector.rootsTruncated(),
      coverageIncomplete: !emptyDirectoryScan.complete,
    });
    const exclusions = protectedInventory.entries;
    const blockedReviewableRoots = new Set([...findings.map((finding) => String(finding.path)), ...exclusions.map((exclusion) => String(exclusion.path))]);
    const reviewableSummary = await buildReviewableCandidates(repoRoot, reviewableCandidateInputs, blockedReviewableRoots, null);
    const summary: HygieneSummary = { candidateCount: candidates.length, findingCount: findings.length, exclusionCount: exclusions.length, protectedInventoryCount: protectedInventory.summary.rootCount, protectedInventoryRootsTruncated: protectedInventory.summary.rootsTruncated, protectedInventoryFileCount: protectedInventory.summary.fileCount, protectedInventoryDirectoryCount: protectedInventory.summary.directoryCount, protectedInventoryTotalBytes: protectedInventory.summary.totalBytes, protectedInventoryBytesTruncated: protectedInventory.summary.bytesTruncated, ...emptyDirectorySummary(emptyDirectoryScan), reviewableCandidateCount: reviewableSummary.reviewableCandidateCount, reviewableShownCount: reviewableSummary.reviewableShownCount, reviewableOmittedCount: reviewableSummary.reviewableOmittedCount, reviewableTotalFileCount: reviewableSummary.reviewableTotalFileCount, reviewableTotalBytes: reviewableSummary.reviewableTotalBytes, reviewableBytesTruncated: reviewableSummary.reviewableBytesTruncated, reviewableTruncated: reviewableSummary.reviewableTruncated, bySeverity: { warn: 0, fail: 0 }, byCategory: { "known-cleanable": 0, "nested-git": 0, suspicious: 0, "filesystem-only-empty-directory": 0 } };
    for (const finding of findings) {
      const severity = String(finding.severity);
      const category = String(finding.category);
      if (severity === "warn" || severity === "fail") summary.bySeverity[severity] += 1;
      if (category === "known-cleanable" || category === "nested-git" || category === "suspicious" || category === "filesystem-only-empty-directory") summary.byCategory[category] += 1;
    }
    const nestedCommands = findings.filter((finding) => finding.category === "nested-git").map((finding) => `git -C ${shellQuote(String(finding.path))} status --short`);
    return { ok: true, repoRoot, summary, findings, exclusions, filesystemOnlyEmptyDirectories, reviewableCandidates: [...reviewableSummary.reviewableCandidates], operationalScope: { ...HYGIENE_OPERATIONAL_SCOPE, emptyDirectories: emptyDirectoryScan.complete ? "bounded-filesystem-empty-directory-scan" : "bounded-filesystem-empty-directory-scan-incomplete" }, scannedAt, suggestedCommands: ["guardian_hygiene", "guardian_status", "git status --short --ignored", ...nestedCommands] };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { ok: false, status: "failed", reason: error.message, failureReason: error.message, summary: { scanFailed: true, candidateCount: 0, findingCount: 0, exclusionCount: 0, protectedInventoryCount: 0, protectedInventoryRootsTruncated: false, protectedInventoryFileCount: 0, protectedInventoryDirectoryCount: 0, protectedInventoryTotalBytes: 0, protectedInventoryBytesTruncated: false, filesystemOnlyEmptyDirectoryCount: 0, filesystemOnlyEmptyDirectoryMaxDepth: 0, filesystemOnlyEmptyDirectoryMaxEntries: 0, filesystemOnlyEmptyDirectoryScanComplete: false, filesystemOnlyEmptyDirectoryScannedEntryCount: 0, reviewableCandidateCount: 0, reviewableShownCount: 0, reviewableOmittedCount: 0, reviewableTotalFileCount: 0, reviewableTotalBytes: 0, reviewableBytesTruncated: false, reviewableTruncated: false, bySeverity: { warn: 0, fail: 0 }, byCategory: { "known-cleanable": 0, "nested-git": 0, suspicious: 0, "filesystem-only-empty-directory": 0 } }, findings: [], exclusions: [], filesystemOnlyEmptyDirectories: [], reviewableCandidates: [], operationalScope: HYGIENE_OPERATIONAL_SCOPE, scannedAt, suggestedCommands: ["guardian_hygiene", "guardian_status"] };
  }
}
