import fs from "node:fs/promises";
import path from "node:path";
import { expandWorktreeRoot, loadConfig } from "./config.ts";
import { getRepoRoot, listWorktrees, runGitNullSeparated, tryGit } from "./git.ts";
import { isEnoent, isSameOrInside, normalizeRelativePath, relativePath } from "./filesystem-boundaries.ts";

export type HygieneSeverity = "warn" | "fail";
export type HygieneCategory = "known-cleanable" | "nested-git" | "suspicious";
type HygieneCandidateStatus = "ignored" | "untracked";
type ReviewableCandidateInput = { readonly path: string; readonly status: HygieneCandidateStatus };

type ReviewableCandidate = {
  readonly path: string;
  readonly status: HygieneCandidateStatus;
  readonly reason: "not matched by Guardian hygiene cleanup rules";
  readonly source: "git ls-files --others/--ignored";
  readonly suggestedDeletePathCommand: string;
};

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
const LOCAL_AGENT_STATE_DIRS = new Set([".omo", ".omc", ".omx", ".sisyphus", ".milestones"]);

function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }

async function listCandidatePaths(repoRoot: string) {
  const untracked = await runGitNullSeparated(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const ignored = await runGitNullSeparated(repoRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]);
  const candidatesByPath = new Map<string, HygieneCandidateStatus>();
  for (const entry of untracked) {
    candidatesByPath.set(normalizeRelativePath(entry), "untracked");
  }
  for (const entry of ignored) {
    candidatesByPath.set(normalizeRelativePath(entry), "ignored");
  }
  return [...candidatesByPath.entries()]
    .map(([candidatePath, status]) => ({ path: candidatePath, status }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function protectedDirReason(relative: string) {
  const parts = relative.split("/").filter(Boolean);
  if (relative === ".git" || relative.startsWith(".git/")) {
    return relative === ".git/worktrees" || relative.startsWith(".git/worktrees/") ? "git worktree metadata" : "git metadata";
  }
  const protectedPart = parts.find((part) => PROTECTED_DIR_NAMES.has(part));
  return protectedPart ? `protected ${protectedPart} directory` : null;
}

function protectedDirExclusionPath(relative: string) {
  const parts = relative.split("/").filter(Boolean);
  return parts.slice(0, parts.findIndex((part) => PROTECTED_DIR_NAMES.has(part)) + 1).join("/") || parts[0] || relative;
}

function knownCleanableMatch(relative: string) {
  const parts = relative.split("/").filter(Boolean);
  if (LOCAL_AGENT_STATE_DIRS.has(parts[0] ?? "")) return { path: parts[0], reason: "local agent state directory" };
  if (parts.length === 1 && /^[^/]+\.tsv$/i.test(parts[0] ?? "")) return { path: parts[0], reason: "generated TSV artifact" };
  if (parts[0] === "data" && /^test-wal-[^/]+$/.test(parts[1] ?? "")) return { path: `data/${parts[1]}`, reason: "known test WAL scratch artifact" };
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

export function residueRoot(relative: string) {
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

function reviewablePath(relative: string, blockedRoots: Set<string>) {
  const parts = relative.split("/").filter(Boolean);
  if (parts.length <= 1) return relative;
  for (let index = 1; index <= parts.length; index += 1) {
    const candidate = parts.slice(0, index).join("/");
    const overlapsBlockedRoot = [...blockedRoots].some((blockedRoot) => candidate === blockedRoot || candidate.startsWith(`${blockedRoot}/`) || blockedRoot.startsWith(`${candidate}/`));
    if (!overlapsBlockedRoot) return candidate;
  }
  return null;
}

function mergeReviewableStatus(current: HygieneCandidateStatus | undefined, next: HygieneCandidateStatus) {
  return current === "ignored" || next === "ignored" ? "ignored" : "untracked";
}

async function buildReviewableCandidates(repoRoot: string, candidates: readonly ReviewableCandidateInput[], blockedRoots: Set<string>) {
  const collapsedByPath = new Map<string, HygieneCandidateStatus>();
  for (const candidate of candidates) {
    const collapsedPath = reviewablePath(candidate.path, blockedRoots);
    if (collapsedPath === null) continue;
    collapsedByPath.set(collapsedPath, mergeReviewableStatus(collapsedByPath.get(collapsedPath), candidate.status));
  }
  const collapsed = [...collapsedByPath.entries()]
    .map(([candidatePath, status]) => ({ path: candidatePath, status }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const visible = collapsed.slice(0, 12);
  const reviewableCandidates: ReviewableCandidate[] = [];
  for (const candidate of visible) {
    const kind = await pathKind(path.resolve(repoRoot, candidate.path));
    const recursiveFlag = kind === "directory" ? " allowRecursive=true" : "";
    reviewableCandidates.push({
      path: candidate.path,
      status: candidate.status,
      reason: "not matched by Guardian hygiene cleanup rules",
      source: "git ls-files --others/--ignored",
      suggestedDeletePathCommand: `guardian_delete_paths mode=plan paths=${JSON.stringify([candidate.path])}${recursiveFlag}`,
    });
  }
  const reviewableCandidateCount = collapsed.length;
  const reviewableShownCount = reviewableCandidates.length;
  return { reviewableCandidates, reviewableCandidateCount, reviewableShownCount, reviewableOmittedCount: reviewableCandidateCount - reviewableShownCount, reviewableTruncated: reviewableCandidateCount > reviewableShownCount };
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

export async function scanWorkspaceHygiene(input: Record<string, unknown> = {}) {
  const scannedAt = input.scannedAt instanceof Date ? input.scannedAt.toISOString() : new Date().toISOString();
  try {
    const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
    const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
    const loadedConfig = input.config && typeof input.config === "object" ? { config: input.config as Record<string, string> } : await loadConfig(repoRoot);
    const config = loadedConfig.config;
    const worktrees = await listWorktrees(repoRoot);
    const configuredWorktreeRoot = path.resolve(repoRoot, expandWorktreeRoot(String(config.worktreeRoot), repoRoot));
    const protectedRoots = worktrees.map((entry) => path.resolve(String(entry.path))).filter((entry) => entry !== path.resolve(repoRoot));
    protectedRoots.push(configuredWorktreeRoot);
    const findings: Array<Record<string, unknown>> = [];
    const exclusionsByPath = new Map<string, Record<string, unknown>>();
    const reviewableCandidateInputs: ReviewableCandidateInput[] = [];
    const seenFindings = new Set<string>();
    const candidates = await listCandidatePaths(repoRoot);
    for (const candidate of candidates) {
      const absolutePath = path.resolve(repoRoot, candidate.path);
      const relative = relativePath(repoRoot, absolutePath);
      const protectedReason = protectedDirReason(relative);
      const protectedRoot = protectedRoots.find((root) => isSameOrInside(absolutePath, root));
      if (protectedReason || protectedRoot) {
        const exclusionPath = protectedRoot ? relativePath(repoRoot, protectedRoot) : protectedDirExclusionPath(relative);
        exclusionsByPath.set(exclusionPath, { path: exclusionPath, reason: protectedReason ?? "configured or registered Git worktree path" });
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
      const baseName = path.basename(relative);
      if (SUSPICIOUS_NAME_PATTERN.test(relative) || SUSPICIOUS_NAME_PATTERN.test(baseName)) {
        const findingPath = suspiciousPath(relative);
        const key = `suspicious:${findingPath}`;
        if (!seenFindings.has(key)) {
          findings.push({ path: findingPath, category: "suspicious" satisfies HygieneCategory, severity: "warn" satisfies HygieneSeverity, reason: "untracked path resembles a clone, research dump, or scratch workspace", source: "git ls-files --others/--ignored" });
          seenFindings.add(key);
        }
        continue;
      }
      reviewableCandidateInputs.push({ path: relative, status: candidate.status });
    }
    findings.sort((left, right) => String(left.path).localeCompare(String(right.path)) || String(left.category).localeCompare(String(right.category)));
    const exclusions = [...exclusionsByPath.values()].sort((left, right) => String(left.path).localeCompare(String(right.path)));
    const blockedReviewableRoots = new Set([...findings.map((finding) => String(finding.path)), ...exclusions.map((exclusion) => String(exclusion.path))]);
    const reviewableSummary = await buildReviewableCandidates(repoRoot, reviewableCandidateInputs, blockedReviewableRoots);
    const summary = { candidateCount: candidates.length, findingCount: findings.length, exclusionCount: exclusions.length, reviewableCandidateCount: reviewableSummary.reviewableCandidateCount, reviewableShownCount: reviewableSummary.reviewableShownCount, reviewableOmittedCount: reviewableSummary.reviewableOmittedCount, reviewableTruncated: reviewableSummary.reviewableTruncated, bySeverity: { warn: 0, fail: 0 } as Record<string, number>, byCategory: { "known-cleanable": 0, "nested-git": 0, suspicious: 0 } as Record<string, number> };
    for (const finding of findings) {
      const severity = String(finding.severity);
      const category = String(finding.category);
      summary.bySeverity[severity] = (summary.bySeverity[severity] ?? 0) + 1;
      summary.byCategory[category] = (summary.byCategory[category] ?? 0) + 1;
    }
    const nestedCommands = findings.filter((finding) => finding.category === "nested-git").map((finding) => `git -C ${shellQuote(String(finding.path))} status --short`);
    return { ok: true, repoRoot, summary, findings, exclusions, reviewableCandidates: reviewableSummary.reviewableCandidates, scannedAt, suggestedCommands: ["guardian_hygiene", "guardian_status", "git status --short --ignored", ...nestedCommands] };
  } catch (error) {
    return { ok: false, status: "failed", reason: errorMessage(error), failureReason: errorMessage(error), summary: { scanFailed: true, candidateCount: 0, findingCount: 0, exclusionCount: 0, reviewableCandidateCount: 0, reviewableShownCount: 0, reviewableOmittedCount: 0, reviewableTruncated: false, bySeverity: { warn: 0, fail: 0 }, byCategory: { "known-cleanable": 0, "nested-git": 0, suspicious: 0 } }, findings: [], exclusions: [], reviewableCandidates: [], scannedAt, suggestedCommands: ["guardian_hygiene", "guardian_status"] };
  }
}
