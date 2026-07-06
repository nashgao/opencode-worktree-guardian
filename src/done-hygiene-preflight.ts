import path from "node:path";
import { guardianDeletePaths } from "./delete-paths-apply.ts";
import { runGitNullSeparated } from "./git.ts";
import { guardianHygiene, scanWorkspaceHygiene } from "./hygiene.ts";
import type { GuardianConfig } from "./types.ts";
import { isRecordLike } from "./types.ts";

type DoneHygieneContext = {
  readonly cwd: string;
  readonly config: GuardianConfig;
};

function recordArrayField(record: Record<string, unknown>, key: string): readonly Record<string, unknown>[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isRecordLike);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pathCoversDirtyFile(root: string, dirtyFile: string): boolean {
  return dirtyFile === root || dirtyFile.startsWith(`${root}/`);
}

function rootsCoveringDirtyFiles(records: readonly Record<string, unknown>[], dirtyFiles: readonly string[]): readonly string[] {
  const roots = new Set<string>();
  for (const record of records) {
    const candidate = stringField(record, "path");
    if (candidate !== null && dirtyFiles.some((dirtyFile) => pathCoversDirtyFile(candidate, dirtyFile))) roots.add(candidate);
  }
  return [...roots].sort((left, right) => left.localeCompare(right));
}

function generatedReviewableArtifact(relativePath: string): boolean {
  const firstPart = relativePath.split("/").find((part) => part.length > 0) ?? relativePath;
  if (firstPart.startsWith(".")) return true;
  const extension = path.extname(relativePath).toLowerCase();
  if ([".csv", ".tsv", ".log", ".jsonl"].includes(extension)) return true;
  const baseName = path.basename(relativePath).toLowerCase();
  return extension === ".md" && /(manifest|report|summary|values|rating|review|people-counter)/.test(baseName);
}

function filterKnownCleanable(records: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
  return records.filter((record) => stringField(record, "category") === "known-cleanable");
}

function filterManualReviewFindings(records: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
  return records.filter((record) => stringField(record, "category") !== "known-cleanable");
}

function filterGeneratedReviewables(records: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
  return records.filter((record) => {
    const candidate = stringField(record, "path");
    return candidate !== null && generatedReviewableArtifact(candidate);
  });
}

function coveredByAnyRoot(dirtyFile: string, roots: readonly string[]): boolean {
  return roots.some((root) => pathCoversDirtyFile(root, dirtyFile));
}

async function untrackedOrIgnoredDirtyFiles(cwd: string): Promise<ReadonlySet<string>> {
  const untracked = await runGitNullSeparated(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const ignored = await runGitNullSeparated(cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]);
  return new Set([...untracked, ...ignored]);
}

function nextActions(input: {
  readonly knownCleanablePaths: readonly string[];
  readonly reviewablePaths: readonly string[];
  readonly ignoreCandidates: readonly string[];
  readonly manualReviewCandidates: readonly string[];
}): readonly string[] {
  const actions: string[] = [];
  if (input.knownCleanablePaths.length > 0) actions.push("plan/apply guardian_hygiene for known-cleanable paths");
  if (input.reviewablePaths.length > 0) actions.push("plan/apply guardian_delete_paths for generated reviewable artifacts");
  if (input.ignoreCandidates.length > 0) actions.push("add ignore rules or explicitly review protected local-state paths");
  if (input.manualReviewCandidates.length > 0) actions.push("manually review nested-git or suspicious paths before deleting");
  actions.push("rerun guardian_done after cleanup or ignore rules are in place");
  return actions;
}

export async function planDoneHygienePreflight(context: DoneHygieneContext, dirtyFiles: readonly string[]): Promise<Record<string, unknown> | null> {
  if (dirtyFiles.length === 0) return null;
  const hygieneDirtyFiles = await untrackedOrIgnoredDirtyFiles(context.cwd);
  if (dirtyFiles.some((dirtyFile) => !hygieneDirtyFiles.has(dirtyFile))) return null;
  const scan = await scanWorkspaceHygiene({ repoRoot: context.cwd, cwd: context.cwd, config: context.config, includeAllReviewableCandidates: true });
  if (scan.ok !== true) return null;
  const findings = recordArrayField(scan, "findings");
  const exclusions = recordArrayField(scan, "exclusions");
  const reviewables = recordArrayField(scan, "reviewableCandidates");
  const knownCleanablePaths = rootsCoveringDirtyFiles(filterKnownCleanable(findings), dirtyFiles);
  const manualReviewCandidates = rootsCoveringDirtyFiles(filterManualReviewFindings(findings), dirtyFiles);
  const ignoreCandidates = rootsCoveringDirtyFiles(exclusions, dirtyFiles);
  const reviewablePaths = rootsCoveringDirtyFiles(filterGeneratedReviewables(reviewables), dirtyFiles);
  const coveredRoots = [...knownCleanablePaths, ...manualReviewCandidates, ...ignoreCandidates, ...reviewablePaths];
  const unclassifiedDirtyFiles = dirtyFiles.filter((dirtyFile) => !coveredByAnyRoot(dirtyFile, coveredRoots));
  if (unclassifiedDirtyFiles.length > 0 || coveredRoots.length === 0) return null;
  const hygienePlan = knownCleanablePaths.length > 0
    ? await guardianHygiene({ repoRoot: context.cwd, cwd: context.cwd, mode: "plan", cleanupPaths: knownCleanablePaths, allowCategories: ["known-cleanable"], config: context.config })
    : null;
  const deletePathsPlan = reviewablePaths.length > 0
    ? await guardianDeletePaths({ repoRoot: context.cwd, cwd: context.cwd, mode: "plan", paths: reviewablePaths, allowRecursive: true, config: context.config })
    : null;
  return {
    ok: false,
    status: "blocked-workspace-hygiene-required",
    reason: "dirty session work is limited to hygiene or generated local artifacts; clean, delete, or ignore them before guardian_done",
    commitMessageRequired: false,
    dirtyFiles,
    knownCleanablePaths,
    reviewablePaths,
    ignoreCandidates,
    manualReviewCandidates,
    hygienePlan,
    deletePathsPlan,
    hygiene: scan,
    nextActions: nextActions({ knownCleanablePaths, reviewablePaths, ignoreCandidates, manualReviewCandidates }),
  };
}
