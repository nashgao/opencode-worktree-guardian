import type { ActiveSessionBaseDistance, CachedBaseAuthority } from "./status-base-distance.ts";
import type { GitBranchEntry, GitRecoveryCandidates, GitRefEntry, GitStashEntry } from "./git.ts";
import type { TerminalSessionStatus } from "./lifecycle.ts";
import type { OperationalScope } from "./operational-scope.ts";
import type { CleanCompletionProofEvidence, GuardianConfig, GuardianSession, GuardianToolResult, WorktreeEntry } from "./types.ts";
import type { ProtectedInventoryEntry } from "./hygiene-protected-inventory.ts";
import type { QuarantineItemState, QuarantineMoveOperationPhase, QuarantinePurgeOperationPhase } from "./quarantine-types.ts";

export type WorktreeAnnotationMetadata = {
  readonly guardianRoot: string;
  readonly commonGitDir?: string;
  readonly commonGitDirError?: string;
};

export type AnnotatedWorktreeEntry = WorktreeEntry & {
  readonly category?: "external-temp-worktree" | "external-worktree";
  readonly severity?: "fail";
  readonly reason?: string;
  readonly metadata?: WorktreeAnnotationMetadata;
};

export type PoisonedSession = GuardianSession & {
  readonly severity: "fail";
  readonly reason: string;
  readonly suggestedCommand: string;
};

export type QuarantineRecoveryItem = {
  readonly quarantineId: string;
  readonly sessionId: string;
  readonly originalRelativePath: string;
  readonly artifactPath: string;
  readonly state: QuarantineItemState;
};

export type IncompleteQuarantineOperation = {
  readonly operationId: string;
  readonly quarantineId: string;
  readonly action: "quarantine" | "restore" | "purge";
  readonly phase: QuarantineMoveOperationPhase | QuarantinePurgeOperationPhase;
  readonly originalRelativePath: string;
};

export type TerminalRecoveryAction = {
  readonly kind: "reattach" | "cleanup";
  readonly sessionId: string;
  readonly status: TerminalSessionStatus;
  readonly branch: string;
  readonly head: string;
  readonly worktreePath?: string;
  readonly command: string;
};

type HygieneSummary = Record<string, unknown> & {
  readonly findingCount: number;
  readonly protectedInventoryCount: number;
  readonly protectedInventoryFileCount: number;
  readonly protectedInventoryDirectoryCount: number;
  readonly protectedInventoryTotalBytes: number;
  readonly protectedInventoryBytesTruncated: boolean;
  readonly reviewableCandidateCount: number;
  readonly reviewableShownCount: number;
  readonly reviewableOmittedCount: number;
  readonly reviewableTotalFileCount: number;
  readonly reviewableTruncated: boolean;
};

type HygieneReviewableCandidate = {
  readonly path: string;
  readonly status: "ignored" | "untracked";
  readonly fileCount: number;
  readonly reason: string;
  readonly source: string;
  readonly suggestedDeletePathCommand: string;
};

type HygieneStatus = Record<string, unknown> & {
  readonly ok?: unknown;
  readonly summary: HygieneSummary;
  readonly findings: readonly (Record<string, unknown> & { readonly path?: unknown })[];
  readonly exclusions: readonly ProtectedInventoryEntry[];
  readonly reviewableCandidates: readonly HygieneReviewableCandidate[];
};

export type GuardianStatusResult = Omit<GuardianToolResult, "activeSessions" | "terminalSessions" | "worktrees" | "safetyRefs" | "sessions"> & {
  readonly repoRoot: string;
  readonly config: GuardianConfig;
  readonly configPath: string | null;
  readonly configLoaded: boolean;
  readonly configSource: "defaults" | "file" | "input";
  readonly stateVersion: number | undefined;
  readonly cleanCompletionProof?: CleanCompletionProofEvidence;
  readonly sessions: readonly GuardianSession[];
  readonly activeSessions: readonly GuardianSession[];
  readonly baseAuthority: CachedBaseAuthority;
  readonly operationalScope: OperationalScope;
  readonly activeSessionBaseDistances: readonly ActiveSessionBaseDistance[];
  readonly terminalSessions: readonly GuardianSession[];
  readonly terminalRecoveryActions: readonly TerminalRecoveryAction[];
  readonly terminalRecoveryActionCount: number;
  readonly terminalRecoveryActionOmittedCount: number;
  readonly orphanedSessions: readonly GuardianSession[];
  readonly poisonedSessions: readonly PoisonedSession[];
  readonly worktrees: readonly WorktreeEntry[];
  readonly branchesWithoutWorktrees: readonly GitBranchEntry[];
  readonly worktreesWithoutState: readonly AnnotatedWorktreeEntry[];
  readonly stateBranchesWithoutWorktrees: readonly string[];
  readonly safetyRefs: readonly GitRefEntry[];
  readonly preservedRefs: readonly GitRefEntry[];
  readonly stashes: readonly GitStashEntry[];
  readonly dirtyFiles: readonly string[];
  readonly hygiene: HygieneStatus;
  readonly quarantineItems: readonly QuarantineRecoveryItem[];
  readonly incompleteQuarantineOperations: readonly IncompleteQuarantineOperation[];
  readonly quarantineRecoveryActions: readonly string[];
  readonly suggestedCommands: readonly string[];
};

export type GuardianRecoverResult = GuardianStatusResult & {
  readonly recoveryCandidates: GitRecoveryCandidates;
};
