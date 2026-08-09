import fs from "node:fs/promises";
import path from "node:path";
import { tryGit } from "./git.ts";
import { isEnoent } from "./filesystem-boundaries.ts";
import type { HygieneCandidateStatus, ReviewableCandidateInput } from "./hygiene-candidates.ts";

export type ReviewableCandidate = {
  readonly path: string;
  readonly status: HygieneCandidateStatus;
  readonly fileCount: number;
  readonly reason: "not matched by Guardian hygiene cleanup rules";
  readonly source: "git ls-files --others/--ignored";
  readonly suggestedDeletePathCommand: string;
};

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
    .sort((left, right) => right.fileCount - left.fileCount || left.path.localeCompare(right.path));
  const visible = visibleLimit === null ? collapsed : collapsed.slice(0, visibleLimit);
  const reviewableCandidates: ReviewableCandidate[] = [];
  for (const candidate of visible) {
    const kind = await pathKind(path.resolve(repoRoot, candidate.path));
    const recursiveFlag = kind === "directory" ? " allowRecursive=true" : "";
    reviewableCandidates.push({
      path: candidate.path,
      status: candidate.status,
      fileCount: candidate.fileCount,
      reason: "not matched by Guardian hygiene cleanup rules",
      source: "git ls-files --others/--ignored",
      suggestedDeletePathCommand: `guardian_delete_paths mode=plan paths=${JSON.stringify([candidate.path])}${recursiveFlag}`,
    });
  }
  const reviewableCandidateCount = collapsed.length;
  const reviewableShownCount = reviewableCandidates.length;
  const reviewableTotalFileCount = collapsed.reduce((total, candidate) => total + candidate.fileCount, 0);
  return { reviewableCandidates, reviewableCandidateCount, reviewableShownCount, reviewableTotalFileCount, reviewableOmittedCount: reviewableCandidateCount - reviewableShownCount, reviewableTruncated: reviewableCandidateCount > reviewableShownCount };
}
