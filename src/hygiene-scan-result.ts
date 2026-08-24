import type { HygieneCategory, HygieneSeverity } from "./hygiene-classification.ts";
import type { ReviewableCandidate } from "./hygiene-reviewable.ts";

export type FilesystemOnlyEmptyDirectory = {
  readonly classification: "known-cleanable" | "reviewable";
  readonly path: string;
  readonly reason: string;
  readonly source: "filesystem empty-directory scan";
};

export type HygieneSummary = {
  readonly candidateCount: number;
  readonly exclusionCount: number;
  readonly findingCount: number;
  readonly filesystemOnlyEmptyDirectoryCount: number;
  readonly filesystemOnlyEmptyDirectoryMaxDepth: number;
  readonly filesystemOnlyEmptyDirectoryMaxEntries: number;
  readonly filesystemOnlyEmptyDirectoryScanComplete: boolean;
  readonly filesystemOnlyEmptyDirectoryScannedEntryCount: number;
  readonly reviewableCandidateCount: number;
  readonly reviewableOmittedCount: number;
  readonly reviewableShownCount: number;
  readonly reviewableTotalFileCount: number;
  readonly reviewableTotalBytes: number;
  readonly reviewableBytesTruncated: boolean;
  readonly reviewableTruncated: boolean;
  readonly scanFailed?: boolean;
  readonly byCategory: Record<HygieneCategory, number>;
  readonly bySeverity: Record<HygieneSeverity, number>;
};

export type HygieneScanResult = {
  readonly ok: boolean;
  readonly repoRoot?: string;
  readonly reason?: string;
  readonly failureReason?: string;
  readonly status?: "failed";
  readonly scannedAt: string;
  readonly summary: HygieneSummary;
  readonly findings: readonly Record<string, unknown>[];
  readonly exclusions: readonly Record<string, unknown>[];
  readonly filesystemOnlyEmptyDirectories: readonly FilesystemOnlyEmptyDirectory[];
  readonly operationalScope: Record<string, string>;
  readonly reviewableCandidates: ReviewableCandidate[];
  readonly suggestedCommands: readonly string[];
};
