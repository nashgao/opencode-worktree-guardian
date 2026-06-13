import type { GuardianSession, MutableRecord } from "./types.ts";
import { isRecordLike } from "./types.ts";

export type LooseRecord = MutableRecord;

export type FinishPreflight = MutableRecord & {
  blockers: string[];
  allowedDirtyFileCount: number;
};

export type FinishStateInput = {
  readonly sessions?: Record<string, GuardianSession>;
};

export type GuardianFinishResult = MutableRecord & {
  reason?: string;
  safetyRef?: string;
  suggestedCommand?: string;
  commit?: string;
  dirtyFiles?: readonly string[];
  cleanupSkippedReason?: string;
  preflight: MutableRecord;
  report: MutableRecord;
};

export function snapshotPreflight(preflight: FinishPreflight): MutableRecord {
  return { ...preflight, blockers: [...preflight.blockers] };
}

export function withFinishReport(result: LooseRecord, preflight: FinishPreflight, reportDetails: LooseRecord = {}): GuardianFinishResult {
  const preflightSnapshot = snapshotPreflight(preflight);
  return {
    ...result,
    preflight: preflightSnapshot,
    report: {
      action: typeof reportDetails.action === "string" ? reportDetails.action : result.status,
      sessionId: preflightSnapshot.sessionId,
      sessionRecorded: preflightSnapshot.sessionRecorded,
      sessionOwnedWorktree: preflightSnapshot.sessionOwnedWorktree,
      currentWorktree: preflightSnapshot.currentWorktree,
      sessionWorktree: preflightSnapshot.sessionWorktree,
      currentBranch: preflightSnapshot.currentBranch,
      sessionBranch: preflightSnapshot.sessionBranch,
      branchProtected: preflightSnapshot.branchProtected,
      dirtyFileCount: preflightSnapshot.dirtyFileCount,
      allowedDirtyFileCount: preflightSnapshot.allowedDirtyFileCount,
      blockingDirtyFileCount: preflightSnapshot.blockingDirtyFileCount,
      stashCount: preflightSnapshot.stashCount,
      baseWorktree: preflightSnapshot.baseWorktree,
      baseWorktreeBranch: preflightSnapshot.baseWorktreeBranch,
      baseWorktreeDirtyFileCount: preflightSnapshot.baseWorktreeDirtyFileCount,
      baseWorktreeIgnoredDirtyFileCount: preflightSnapshot.baseWorktreeIgnoredDirtyFileCount,
      safetyRef: preflightSnapshot.safetyRef ?? result.safetyRef ?? null,
      remote: preflightSnapshot.remote,
      baseBranch: preflightSnapshot.baseBranch,
      mode: preflightSnapshot.mode,
      blockers: preflightSnapshot.blockers,
      suggestedCommand: result.suggestedCommand,
      ...reportDetails,
    },
  };
}

export function blocked(reason: string, details: LooseRecord = {}, preflight: FinishPreflight, reportDetails: LooseRecord = {}): GuardianFinishResult {
  const result = { ok: false, status: "blocked", reason, ...details };
  preflight.blockers = [...preflight.blockers, reason];
  return withFinishReport(result, preflight, { action: "blocked", ...reportDetails });
}

export function errorMessage(error: unknown): string {
  if (isRecordLike(error)) {
    if (typeof error.gitStderr === "string" && error.gitStderr.length > 0) return error.gitStderr;
    if (typeof error.message === "string" && error.message.length > 0) return error.message;
  }
  return String(error);
}

export function isFinishStateInput(value: unknown): value is FinishStateInput {
  return isRecordLike(value) && (value.sessions === undefined || isRecordLike(value.sessions));
}
