import { guardianDeleteWorktree } from "./delete-worktree.ts";
import { finalPostflightCommitsFromCleanupSweep, runCleanupSweep } from "./done-cleanup-sweep.ts";
import { syncLocalBase } from "./done-main-sync.ts";
import { deleteAbsentRemoteBranchAtExpectedAbsence, deleteRemoteBranch } from "./git.ts";
import { completeRemoteBranchCleanupSafetyRefReservation, reserveRemoteBranchCleanupSafetyRef } from "./state-remote-branch-reservation.ts";
import { normalizeAllowedRemoteBranches, runFinalCleanupPostflight, type FinalPostflightCommit } from "./final-postflight.ts";
import type { GuardianConfig } from "./types.ts";
import { isRecordLike } from "./types.ts";

type LandCleanMaintenanceContext = {
  readonly input: Record<string, unknown>;
  readonly repoRoot: string;
  readonly sessionId: string;
  readonly config: GuardianConfig;
};

type CleanupLandedSessionOptions = {
  readonly allowRedundantDirtyPaths?: boolean;
  readonly ancestryBaseRef?: string;
  readonly ignoredFiles: readonly string[];
  readonly ignoredFileFingerprint: readonly unknown[];
  readonly remoteBranchCleanup?: { readonly remote: string; readonly remoteBranch: string; readonly head: string; readonly safetyRef: string };
};

function okField(value: unknown): unknown {
  return isRecordLike(value) ? value.ok : undefined;
}

export async function postFinishMaintenance(context: LandCleanMaintenanceContext, requiredCommits: readonly FinalPostflightCommit[]): Promise<Record<string, unknown>> {
  if (context.input.skipPostFinishMaintenance === true) return {};
  const mainSync = await syncLocalBase(context.repoRoot, context.config);
  const cleanupSweep = await runCleanupSweep(context.repoRoot, context.config, context.input);
  if (cleanupSweep.freshPlanRequired === true) return { mainSync, cleanupSweep, freshPlanRequired: true };
  const finalPostflight = await runFinalCleanupPostflight({ repoRoot: context.repoRoot, config: context.config, requiredCommits: [...requiredCommits, ...finalPostflightCommitsFromCleanupSweep(cleanupSweep)], allowedRemoteBranches: normalizeAllowedRemoteBranches(context.input.allowedRemoteBranches) });
  return { mainSync, cleanupSweep, finalPostflight };
}

export function withMaintenanceOutcome(result: Record<string, unknown>, maintenance: Record<string, unknown>): Record<string, unknown> {
  const mainSyncOk = okField(maintenance.mainSync);
  const sweepOk = okField(maintenance.cleanupSweep);
  const finalPostflightOk = okField(maintenance.finalPostflight);
  if (mainSyncOk === false || sweepOk === false || finalPostflightOk === false) {
    return {
      ...result,
      ...maintenance,
      ok: false,
      status: "partial",
      reason: finalPostflightOk === false ? "session landed and cleaned, but final cleanup postflight failed" : mainSyncOk === false ? "session landed and cleaned, but local base sync was blocked" : "session landed and cleaned, but post-finish cleanup sweep was blocked",
    };
  }
  return { ...result, ...maintenance };
}

export async function cleanupLandedSession(context: LandCleanMaintenanceContext, failurePrefix: string, options: CleanupLandedSessionOptions): Promise<Record<string, unknown>> {
  const cleanupPlan = await guardianDeleteWorktree({
    repoRoot: context.repoRoot,
    cwd: context.repoRoot,
    mode: "plan",
    sessionId: context.sessionId,
    deleteBranch: true,
    allowIgnoredFiles: context.input.allowIgnoredFiles === true,
    allowRedundantDirtyPaths: options.allowRedundantDirtyPaths === true,
    ancestryBaseRef: options.ancestryBaseRef,
    timestamp: context.input.timestamp,
    config: context.config,
  });
  if (cleanupPlan.ok !== true || typeof cleanupPlan.confirmToken !== "string") {
    return { ok: false, status: "cleanup-blocked", reason: `${failurePrefix} but stale worktree cleanup could not be planned`, cleanup: cleanupPlan };
  }
  const cleanupPreflight = isRecordLike(cleanupPlan.preflight) ? cleanupPlan.preflight : {};
  if (JSON.stringify(cleanupPreflight.ignoredFiles) !== JSON.stringify(options.ignoredFiles)
    || JSON.stringify(cleanupPreflight.ignoredFileFingerprint) !== JSON.stringify(options.ignoredFileFingerprint)) {
    return { ok: false, status: "cleanup-blocked", reason: `${failurePrefix} but ignored-file consent changed`, cleanup: cleanupPlan, ignoredFiles: options.ignoredFiles, ignoredFileFingerprint: options.ignoredFileFingerprint };
  }
  const remoteBranchCleanupInput = options.remoteBranchCleanup ? { repoRoot: context.repoRoot, config: context.config, ...options.remoteBranchCleanup } : null;
  if (remoteBranchCleanupInput) {
    try {
      await reserveRemoteBranchCleanupSafetyRef(remoteBranchCleanupInput);
    } catch (error) {
      return { ok: false, status: "cleanup-blocked", reason: `${failurePrefix} but remote branch cleanup safety could not be reserved`, cleanup: cleanupPlan, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const cleanup = await guardianDeleteWorktree({
    repoRoot: context.repoRoot,
    cwd: context.repoRoot,
    mode: "apply",
    sessionId: context.sessionId,
    deleteBranch: true,
    allowIgnoredFiles: context.input.allowIgnoredFiles === true,
    allowRedundantDirtyPaths: options.allowRedundantDirtyPaths === true,
    ancestryBaseRef: options.ancestryBaseRef,
    confirmToken: cleanupPlan.confirmToken,
    timestamp: context.input.timestamp,
    config: context.config,
  });
  if (cleanup.ok !== true) return { ok: false, status: "cleanup-blocked", reason: `${failurePrefix} but stale worktree cleanup failed`, cleanup };
  let remoteBranchDeleted = false;
  let remoteBranchReconciled = false;
  let expectedHeadDeleteError: string | undefined;
  if (remoteBranchCleanupInput) {
    try {
      await deleteRemoteBranch(context.repoRoot, remoteBranchCleanupInput.remote, remoteBranchCleanupInput.remoteBranch, remoteBranchCleanupInput.head);
      remoteBranchDeleted = true;
    } catch (error) {
      expectedHeadDeleteError = error instanceof Error ? error.message : String(error);
      try {
        await deleteAbsentRemoteBranchAtExpectedAbsence(context.repoRoot, remoteBranchCleanupInput.remote, remoteBranchCleanupInput.remoteBranch);
        remoteBranchReconciled = true;
      } catch (absenceError) {
        return { ok: false, status: "cleanup-blocked", reason: `${failurePrefix} but remote branch cleanup failed`, cleanup, remoteBranchCleanup: options.remoteBranchCleanup, expectedHeadDeleteError, error: absenceError instanceof Error ? absenceError.message : String(absenceError) };
      }
    }
    try {
      await completeRemoteBranchCleanupSafetyRefReservation(remoteBranchCleanupInput);
    } catch (error) {
      return { ok: false, status: "cleanup-blocked", reason: `${failurePrefix} but remote branch cleanup failed`, cleanup, remoteBranchCleanup: options.remoteBranchCleanup, ...(expectedHeadDeleteError ? { expectedHeadDeleteError } : {}), error: error instanceof Error ? error.message : String(error) };
    }
  }
  return remoteBranchCleanupInput ? { ...cleanup, remoteBranchDeleted, remoteBranchReconciled, remoteBranch: remoteBranchCleanupInput.remoteBranch } : cleanup;
}
