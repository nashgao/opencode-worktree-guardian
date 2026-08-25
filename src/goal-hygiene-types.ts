import type { ProtectedInventorySummary } from "./hygiene-protected-inventory.ts";
import type { GuardianGoalHygieneCompletion } from "./types.ts";

export type GoalResidualFinding = {
  readonly category: string;
  readonly path: string;
  readonly reason: string;
  readonly severity: string;
};

export type GoalReviewableCandidate = {
  readonly path: string;
  readonly status: string;
  readonly fileCount: number;
  readonly bytes: number;
  readonly bytesTruncated: boolean;
  readonly reason: string;
  readonly suggestedDeletePathCommand: string;
};

export type GoalProtectedInventory = ProtectedInventorySummary & {
  readonly rootsShown: readonly string[];
  readonly rootsOmittedCount: number | null;
};

export type GoalHygienePostcondition = {
  readonly mode: GuardianGoalHygieneCompletion;
  readonly phase: "not-required" | "plan" | "apply";
  readonly status: "not-required" | "pending" | "satisfied" | "residual-unprotected" | "scan-incomplete" | "scan-failed";
  readonly residualCount: number;
  readonly residualByCategory: Readonly<Record<"known-cleanable" | "nested-git" | "suspicious", number>>;
  readonly residualFindingCount: number;
  readonly residualDigest: string;
  readonly residualFindingsShown: readonly GoalResidualFinding[];
  readonly residualFindingsOmittedCount: number;
  readonly residualFindingsTruncated: boolean;
  readonly protectedExclusionCount: number;
  readonly protectedInventory: GoalProtectedInventory;
  readonly reviewableCandidateCount: number;
  readonly reviewableDigest: string;
  readonly reviewableCandidatesShown: readonly GoalReviewableCandidate[];
  readonly reviewableCandidatesOmittedCount: number;
  readonly reviewableCandidatesTruncated: boolean;
  readonly reviewableInventoryComplete: boolean;
};
