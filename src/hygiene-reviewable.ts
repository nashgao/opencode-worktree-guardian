import fs from "node:fs/promises";
import path from "node:path";
import { compareCodeUnits } from "./code-unit-order.ts";
import { tryGit } from "./git.ts";
import { isEnoent } from "./filesystem-boundaries.ts";
import type { HygieneCandidateStatus, ReviewableCandidateInput } from "./hygiene-candidates.ts";

export type ReviewableCandidate = {
  readonly path: string;
  readonly status: HygieneCandidateStatus;
  readonly fileCount: number;
  readonly bytes: number;
  readonly bytesTruncated: boolean;
  readonly reason: "not matched by Guardian hygiene cleanup rules";
  readonly source: "git ls-files --others/--ignored";
  readonly suggestedDeletePathCommand: string;
};

const MAX_MEASURED_ENTRIES_PER_CANDIDATE = 10_000;
const MAX_MEASURED_ENTRIES_TOTAL = 100_000;

type ByteMeasurement = { readonly bytes: number; readonly truncated: boolean; readonly visited: number };
type CollapsedReviewableCandidate = { readonly path: string; readonly status: HygieneCandidateStatus; readonly fileCount: number };
type MeasuredReviewableCandidate = CollapsedReviewableCandidate & { readonly bytes: number; readonly bytesTruncated: boolean };

async function measureBytes(candidate: string, maxEntries: number): Promise<ByteMeasurement> {
  let bytes = 0;
  let visited = 0;
  let truncated = false;
  async function visit(current: string): Promise<void> {
    if (visited >= maxEntries) {
      truncated = true;
      return;
    }
    visited += 1;
    const stat = await fs.lstat(current);
    if (!stat.isDirectory()) {
      bytes += stat.size;
      return;
    }
    for (const child of await fs.readdir(current)) await visit(path.join(current, child));
  }
  await visit(candidate);
  return { bytes, truncated, visited };
}

export async function measureReviewableCandidates(
  candidates: readonly CollapsedReviewableCandidate[],
  measure: (candidatePath: string, maxEntries: number) => Promise<ByteMeasurement>,
  limits: { readonly perCandidate: number; readonly total: number },
): Promise<readonly MeasuredReviewableCandidate[]> {
  let remainingEntries = limits.total;
  const measured: MeasuredReviewableCandidate[] = [];
  const ordered = [...candidates].sort((left, right) => compareCodeUnits(left.path, right.path));
  for (const candidate of ordered) {
    const measurement = await measure(candidate.path, Math.min(limits.perCandidate, remainingEntries));
    remainingEntries = Math.max(0, remainingEntries - measurement.visited);
    measured.push({ ...candidate, bytes: measurement.bytes, bytesTruncated: measurement.truncated });
  }
  measured.sort((left, right) =>
    Number(right.bytesTruncated) - Number(left.bytesTruncated)
    || (left.bytesTruncated ? 0 : right.bytes - left.bytes)
    || right.fileCount - left.fileCount
    || compareCodeUnits(left.path, right.path));
  return measured;
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

async function hasTrackedEntriesUnder(repoRoot: string, relative: string): Promise<boolean> {
  const result = await tryGit(repoRoot, ["ls-files", "--", `${relative.replace(/\/$/, "")}/`]);
  return result.ok && result.stdout.trim().length > 0;
}

async function reviewablePath(repoRoot: string, relative: string, blockedRoots: ReadonlySet<string>): Promise<string | null> {
  const parts = relative.split("/").filter(Boolean);
  if (parts.length <= 1) return relative;
  for (let index = 1; index <= parts.length; index += 1) {
    const candidate = parts.slice(0, index).join("/");
    const overlapsBlockedRoot = [...blockedRoots].some((blockedRoot) => candidate === blockedRoot || candidate.startsWith(`${blockedRoot}/`) || blockedRoot.startsWith(`${candidate}/`));
    if (!overlapsBlockedRoot && (index === parts.length || !await hasTrackedEntriesUnder(repoRoot, candidate))) return candidate;
  }
  return null;
}

function mergedStatus(current: HygieneCandidateStatus | undefined, next: HygieneCandidateStatus): HygieneCandidateStatus {
  return current === "ignored" || next === "ignored" ? "ignored" : "untracked";
}

export async function buildReviewableCandidates(repoRoot: string, candidates: readonly ReviewableCandidateInput[], blockedRoots: ReadonlySet<string>, visibleLimit: number | null): Promise<{
  readonly reviewableCandidates: readonly ReviewableCandidate[];
  readonly reviewableCandidateCount: number;
  readonly reviewableShownCount: number;
  readonly reviewableTotalFileCount: number;
  readonly reviewableTotalBytes: number;
  readonly reviewableBytesTruncated: boolean;
  readonly reviewableOmittedCount: number;
  readonly reviewableTruncated: boolean;
}> {
  const collapsedByPath = new Map<string, HygieneCandidateStatus>();
  const fileCountByPath = new Map<string, number>();
  for (const candidate of candidates) {
    const collapsedPath = await reviewablePath(repoRoot, candidate.path, blockedRoots);
    if (collapsedPath === null) continue;
    collapsedByPath.set(collapsedPath, mergedStatus(collapsedByPath.get(collapsedPath), candidate.status));
    fileCountByPath.set(collapsedPath, (fileCountByPath.get(collapsedPath) ?? 0) + 1);
  }
  const collapsed = [...collapsedByPath.entries()]
    .map(([candidatePath, status]) => ({ path: candidatePath, status, fileCount: fileCountByPath.get(candidatePath) ?? 1 }))
    ;
  const measured = await measureReviewableCandidates(
    collapsed,
    (candidatePath, maxEntries) => measureBytes(path.resolve(repoRoot, candidatePath), maxEntries),
    { perCandidate: MAX_MEASURED_ENTRIES_PER_CANDIDATE, total: MAX_MEASURED_ENTRIES_TOTAL },
  );
  const visible = visibleLimit === null ? measured : measured.slice(0, visibleLimit);
  const reviewableCandidates: ReviewableCandidate[] = [];
  for (const candidate of visible) {
    const kind = await pathKind(path.resolve(repoRoot, candidate.path));
    const recursiveFlag = kind === "directory" ? " allowRecursive=true" : "";
    reviewableCandidates.push({
      path: candidate.path,
      status: candidate.status,
      fileCount: candidate.fileCount,
      bytes: candidate.bytes,
      bytesTruncated: candidate.bytesTruncated,
      reason: "not matched by Guardian hygiene cleanup rules",
      source: "git ls-files --others/--ignored",
      suggestedDeletePathCommand: `guardian_delete_paths mode=plan paths=${JSON.stringify([candidate.path])}${recursiveFlag}`,
    });
  }
  const reviewableCandidateCount = collapsed.length;
  const reviewableShownCount = reviewableCandidates.length;
  const reviewableTotalFileCount = collapsed.reduce((total, candidate) => total + candidate.fileCount, 0);
  const reviewableTotalBytes = measured.reduce((total, candidate) => total + candidate.bytes, 0);
  const reviewableBytesTruncated = measured.some((candidate) => candidate.bytesTruncated);
  return { reviewableCandidates, reviewableCandidateCount, reviewableShownCount, reviewableTotalFileCount, reviewableTotalBytes, reviewableBytesTruncated, reviewableOmittedCount: reviewableCandidateCount - reviewableShownCount, reviewableTruncated: reviewableCandidateCount > reviewableShownCount };
}
