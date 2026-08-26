import crypto from "node:crypto";
import { compareCodeUnits } from "./code-unit-order.ts";
import { scanWorkspaceHygiene } from "./hygiene.ts";
import type { NullSeparatedRunner } from "./hygiene-candidates.ts";
import type { GoalHygienePostcondition, GoalProtectedInventory, GoalResidualFinding, GoalReviewableCandidate } from "./goal-hygiene-types.ts";
import type { GuardianGoalHygieneCompletion, RecordLike } from "./types.ts";
import { isRecordLike } from "./types.ts";
import type { NormalizedGuardianConfig } from "./normalized-config.ts";
import { EMPTY_PROTECTED_INVENTORY } from "./hygiene-protected-inventory.ts";
import { inertText } from "./plugin/readable-output-values.ts";

const HYGIENE_CATEGORIES = ["known-cleanable", "nested-git", "suspicious"] as const;
const RESIDUAL_FINDING_LIMIT = 8;
const PROTECTED_ROOT_LIMIT = 12;

type HygieneCategory = (typeof HYGIENE_CATEGORIES)[number];
type UnknownRunner = (repoPath: string, args: readonly string[]) => unknown;

export type { GoalHygienePostcondition } from "./goal-hygiene-types.ts";

type GoalHygienePostconditionOptions = {
  readonly config: NormalizedGuardianConfig;
  readonly repoRoot: string;
  readonly cwd: string;
  readonly phase: "plan" | "apply";
  readonly approvedTargetPaths?: readonly string[];
  readonly input?: RecordLike;
};

function numericValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function records(value: unknown): readonly RecordLike[] {
  return Array.isArray(value) ? value.filter(isRecordLike) : [];
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isUnknownRunner(value: unknown): value is UnknownRunner {
  return typeof value === "function";
}

function scanRunner(input: RecordLike | undefined): NullSeparatedRunner | undefined {
  const runner = input?.runGitNullSeparated;
  if (!isUnknownRunner(runner)) return undefined;
  return async (repoPath, args) => {
    const result: unknown = await runner(repoPath, args);
    if (!Array.isArray(result) || !result.every((entry) => typeof entry === "string")) {
      throw new TypeError("runGitNullSeparated must return a string array");
    }
    return result;
  };
}

export function sanitizeGoalResidualText(value: unknown, fallback = "-"): string {
  const text = inertText(textValue(value) || fallback);
  return text
    .replace(/\r\n|\n|\r/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/(^|\\n|[^A-Za-z0-9_])mode\s*=\s*apply\b/gi, "$1mode=<redacted>")
    .replace(/(^|\\n|[^A-Za-z0-9_])confirmDelete\s*=\s*true\b/gi, "$1confirmDelete=<redacted>")
    .replace(/(^|\\n|[^A-Za-z0-9_])confirmToken\s*[:=]\s*[^\\\s]+/gi, "$1confirmation=<redacted>")
    .replace(/(^|\\n|[^A-Za-z0-9_])confirmToken\b/gi, "$1confirmation")
    .replace(/(^|[^A-Za-z0-9_]|\\n)rm\s+-rf\b/gi, "$1rm <redacted>")
    .replace(/(^|[^A-Za-z0-9_]|\\n)git\s+clean\b/gi, "$1git <redacted>");
}

export { compareCodeUnits } from "./code-unit-order.ts";

function residualDigest(findings: readonly RecordLike[]): string {
  const identities = findings.map((finding) => JSON.stringify({
    category: textValue(finding.category),
    path: textValue(finding.path),
    reason: textValue(finding.reason),
    severity: textValue(finding.severity),
  })).sort(compareCodeUnits);
  return crypto.createHash("sha256").update(JSON.stringify(identities)).digest("hex");
}

function reviewableDigest(candidates: readonly RecordLike[]): string {
  const identities = candidates.map((candidate) => JSON.stringify({
    path: textValue(candidate.path),
    status: textValue(candidate.status),
    fileCount: numericValue(candidate.fileCount),
    bytes: numericValue(candidate.bytes),
    bytesTruncated: candidate.bytesTruncated === true,
    reason: textValue(candidate.reason),
  })).sort(compareCodeUnits);
  return crypto.createHash("sha256").update(JSON.stringify(identities)).digest("hex");
}

function shownResidualFinding(finding: RecordLike): GoalResidualFinding {
  return {
    category: sanitizeGoalResidualText(finding.category),
    path: sanitizeGoalResidualText(finding.path),
    reason: sanitizeGoalResidualText(finding.reason),
    severity: sanitizeGoalResidualText(finding.severity),
  };
}

function shownReviewableCandidate(candidate: RecordLike): GoalReviewableCandidate {
  return {
    path: sanitizeGoalResidualText(candidate.path),
    status: sanitizeGoalResidualText(candidate.status),
    fileCount: numericValue(candidate.fileCount),
    bytes: numericValue(candidate.bytes),
    bytesTruncated: candidate.bytesTruncated === true,
    reason: sanitizeGoalResidualText(candidate.reason),
    suggestedDeletePathCommand: sanitizeGoalResidualText(candidate.suggestedDeletePathCommand),
  };
}

function categoryCounts(findings: readonly RecordLike[]): Record<HygieneCategory, number> {
  const counts: Record<HygieneCategory, number> = { "known-cleanable": 0, "nested-git": 0, suspicious: 0 };
  for (const finding of findings) {
    const category = finding.category;
    if (category === "known-cleanable" || category === "nested-git" || category === "suspicious") counts[category] += 1;
  }
  return counts;
}

function noResiduals(mode: GuardianGoalHygieneCompletion, phase: "not-required" | "plan" | "apply", status: GoalHygienePostcondition["status"], protectedExclusionCount = 0, reviewableCandidateCount = 0, reviewableInventoryComplete = true): GoalHygienePostcondition {
  return {
    mode,
    phase,
    status,
    residualCount: 0,
    residualByCategory: { "known-cleanable": 0, "nested-git": 0, suspicious: 0 },
    residualFindingCount: 0,
    residualDigest: residualDigest([]),
    residualFindingsShown: [],
    residualFindingsOmittedCount: 0,
    residualFindingsTruncated: false,
    protectedExclusionCount,
    protectedInventory: { ...EMPTY_PROTECTED_INVENTORY, rootsShown: [], rootsOmittedCount: 0 },
    reviewableCandidateCount,
    reviewableDigest: reviewableDigest([]),
    reviewableCandidatesShown: [],
    reviewableCandidatesOmittedCount: reviewableCandidateCount,
    reviewableCandidatesTruncated: reviewableCandidateCount > 0,
    reviewableInventoryComplete,
  };
}

export function failedGoalHygienePostcondition(mode: GuardianGoalHygieneCompletion, phase: "plan" | "apply"): GoalHygienePostcondition {
  return noResiduals(mode, phase, "scan-failed", 0, 0, false);
}

function postconditionStatus(input: {
  readonly mode: GuardianGoalHygieneCompletion;
  readonly phase: "plan" | "apply";
  readonly residualCount: number;
  readonly reviewableCandidateCount: number;
  readonly reviewableInventoryComplete: boolean;
  readonly approvedTargetCount: number;
}): GoalHygienePostcondition["status"] {
  if (input.mode === "no-unprotected-residue" && !input.reviewableInventoryComplete) return "scan-incomplete";
  const hasReviewableResidue = input.mode === "no-unprotected-residue" && input.reviewableCandidateCount > 0;
  if (input.residualCount > 0 || hasReviewableResidue) return "residual-unprotected";
  return input.phase === "plan" && input.approvedTargetCount > 0 ? "pending" : "satisfied";
}

export function approvedHygieneTargetPaths(result: unknown): readonly string[] {
  if (!isRecordLike(result)) return [];
  return records(result.targets)
    .map((target) => target.path)
    .filter((path): path is string => typeof path === "string")
    .sort(compareCodeUnits);
}

export async function scanGoalHygienePostcondition(options: GoalHygienePostconditionOptions): Promise<GoalHygienePostcondition> {
  const mode = options.config.goal.hygieneCompletion;
  if (!options.config.goal.cleanupHygiene && mode !== "no-unprotected-residue") return noResiduals(mode, "not-required", "not-required");
  const runner = scanRunner(options.input);
  const scan = await scanWorkspaceHygiene({ repoRoot: options.repoRoot, cwd: options.cwd, config: options.config, ...(runner ? { runGitNullSeparated: runner } : {}), ...(typeof options.input?.trackedBaselineCommit === "string" ? { trackedBaselineCommit: options.input.trackedBaselineCommit } : {}), ...(typeof options.input?.trackedBaselineSource === "string" ? { trackedBaselineSource: options.input.trackedBaselineSource } : {}), ...(Array.isArray(options.input?.trackedIntentionalPaths) ? { trackedIntentionalPaths: options.input.trackedIntentionalPaths } : {}), ...(options.input?.emptyDirectoryMaxDepth !== undefined ? { emptyDirectoryMaxDepth: options.input.emptyDirectoryMaxDepth } : {}), ...(options.input?.emptyDirectoryMaxEntries !== undefined ? { emptyDirectoryMaxEntries: options.input.emptyDirectoryMaxEntries } : {}) });
  const summary: RecordLike = isRecordLike(scan.summary) ? scan.summary : {};
  const protectedExclusionCount = numericValue(summary.exclusionCount);
  const protectedRoots = records(scan.exclusions)
    .map((entry) => sanitizeGoalResidualText(entry.path))
    .sort(compareCodeUnits);
  const protectedRootsShown = protectedRoots.slice(0, PROTECTED_ROOT_LIMIT);
  const protectedInventory: GoalProtectedInventory = {
    rootCount: numericValue(summary.protectedInventoryCount),
    rootsTruncated: summary.protectedInventoryRootsTruncated === true,
    rootsShown: protectedRootsShown,
    rootsOmittedCount: summary.protectedInventoryRootsTruncated === true ? null : Math.max(0, protectedRoots.length - protectedRootsShown.length),
    fileCount: numericValue(summary.protectedInventoryFileCount),
    directoryCount: numericValue(summary.protectedInventoryDirectoryCount),
    totalBytes: numericValue(summary.protectedInventoryTotalBytes),
    bytesTruncated: summary.protectedInventoryBytesTruncated === true,
    assessment: "not-assessed",
    cleanupAuthorized: false,
  };
  const reviewableCandidateCount = numericValue(summary.reviewableCandidateCount);
  if (scan.ok === false || summary.scanFailed === true) {
    return noResiduals(mode, options.phase, "scan-failed", protectedExclusionCount, reviewableCandidateCount, false);
  }
  const approvedTargets = new Set(options.approvedTargetPaths ?? []);
  const residualFindings = records(scan.findings).filter((finding) => typeof finding.path !== "string" || !approvedTargets.has(finding.path));
  const residualFindingsShown = residualFindings.slice(0, RESIDUAL_FINDING_LIMIT).map(shownResidualFinding);
  const reviewableCandidates = records(scan.reviewableCandidates);
  const reviewableCandidatesShown = reviewableCandidates.slice(0, RESIDUAL_FINDING_LIMIT).map(shownReviewableCandidate);
  const reviewableInventoryComplete = summary.filesystemOnlyEmptyDirectoryScanComplete === true && summary.reviewableTruncated !== true && reviewableCandidates.length === reviewableCandidateCount;
  return {
    mode,
    phase: options.phase,
    status: postconditionStatus({ mode, phase: options.phase, residualCount: residualFindings.length, reviewableCandidateCount, reviewableInventoryComplete, approvedTargetCount: approvedTargets.size }),
    residualCount: residualFindings.length,
    residualByCategory: categoryCounts(residualFindings),
    residualFindingCount: residualFindings.length,
    residualDigest: residualDigest(residualFindings),
    residualFindingsShown,
    residualFindingsOmittedCount: residualFindings.length - residualFindingsShown.length,
    residualFindingsTruncated: residualFindings.length > residualFindingsShown.length,
    protectedExclusionCount,
    protectedInventory,
    reviewableCandidateCount,
    reviewableDigest: reviewableDigest(reviewableCandidates),
    reviewableCandidatesShown,
    reviewableCandidatesOmittedCount: Math.max(0, reviewableCandidateCount - reviewableCandidatesShown.length),
    reviewableCandidatesTruncated: reviewableCandidateCount > reviewableCandidatesShown.length,
    reviewableInventoryComplete,
  };
}

export function postconditionBlocksCompletion(postcondition: GoalHygienePostcondition): boolean {
  return postcondition.status === "scan-failed" || postcondition.status === "scan-incomplete" || ((postcondition.mode === "no-unprotected-findings" || postcondition.mode === "no-unprotected-residue") && postcondition.status === "residual-unprotected");
}

export function postconditionIsComplete(postcondition: GoalHygienePostcondition): boolean {
  if (postcondition.status === "pending" || postcondition.status === "scan-failed" || postcondition.status === "scan-incomplete") return false;
  return postcondition.mode === "authorized-cleanup" || postcondition.status !== "residual-unprotected";
}

export function postconditionReason(postcondition: GoalHygienePostcondition): string | undefined {
  if (postcondition.status === "scan-failed") return "guardian_goal hygiene postcondition scan failed";
  if (postcondition.status === "scan-incomplete") return "guardian_goal strict residue completion hygiene inventory is incomplete";
  if (postcondition.mode === "no-unprotected-residue" && postcondition.status === "residual-unprotected") {
    return "guardian_goal strict residue completion has unprotected residue";
  }
  if (postcondition.mode === "no-unprotected-findings" && postcondition.status === "residual-unprotected") {
    return "guardian_goal strict hygiene completion has unprotected residual findings";
  }
  return undefined;
}
