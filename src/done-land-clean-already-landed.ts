import { guardianDeleteWorktree } from "./delete-worktree.ts";
import { createSessionLandCleanConfirmToken } from "./done-land-clean-consent.ts";
import type { SuccessfulLandCleanPreflight } from "./done-land-clean-consent.ts";
import { cleanupLandedSession, postFinishMaintenance, withMaintenanceOutcome } from "./done-land-clean-maintenance.ts";
import type { LandCleanContext } from "./done-land-clean.ts";

function blocked(reason: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: false, status: "blocked", reason, ...extra };
}

function stashInventory(preflight: SuccessfulLandCleanPreflight): Pick<SuccessfulLandCleanPreflight, "stashCount" | "stashes"> {
  return { stashCount: preflight.stashCount, stashes: preflight.stashes };
}

export async function planAlreadyLandedCleanup(context: LandCleanContext, preflight: SuccessfulLandCleanPreflight, baseRef: string): Promise<Record<string, unknown>> {
  const cleanup = await guardianDeleteWorktree({
    repoRoot: context.repoRoot,
    cwd: context.repoRoot,
    mode: "plan",
    sessionId: context.sessionId,
    deleteBranch: true,
    allowIgnoredFiles: context.input.allowIgnoredFiles === true,
    allowRedundantDirtyPaths: true,
    ancestryBaseRef: baseRef,
    timestamp: context.input.timestamp,
    config: context.config,
  });
  if (cleanup.ok !== true || typeof cleanup.confirmToken !== "string") {
    return blocked("already-landed dirty session work could not be proven redundant; commitMessage is required to preserve it", {
      branch: preflight.branch,
      worktreePath: preflight.worktreePath,
      dirtyFiles: preflight.dirtyFiles,
      ...stashInventory(preflight),
      baseRef,
      cleanup,
    });
  }
  const confirmToken = createSessionLandCleanConfirmToken({ action: "already-landed-clean", context, preflight, commitMessage: "" });
  return { ...preflight, status: "planned", action: "already-landed-clean", baseRef, cleanup, confirmToken, nextAction: "guardian_done mode=apply confirm=true" };
}

export async function applyAlreadyLandedCleanup(context: LandCleanContext, preflight: SuccessfulLandCleanPreflight, baseRef: string): Promise<Record<string, unknown>> {
  const cleanup = await cleanupLandedSession(context, "session commit is already reachable from the remote base branch", { allowRedundantDirtyPaths: true, ancestryBaseRef: baseRef, ignoredFiles: preflight.ignoredFiles, ignoredFileFingerprint: preflight.ignoredFileFingerprint });
  if (cleanup.ok !== true) return { ...cleanup, ...stashInventory(preflight) };
  const maintenance = await postFinishMaintenance(context, [{ commit: preflight.head, source: preflight.branch, reason: "landed session commit must be present on final base" }]);
  return withMaintenanceOutcome({
    ok: true,
    status: "already-landed-and-cleaned",
    action: "already-landed-clean",
    branch: preflight.branch,
    head: preflight.head,
    dirtyFiles: preflight.dirtyFiles,
    stashCount: preflight.stashCount,
    stashes: preflight.stashes,
    baseRef,
    cleanup,
    worktreeRemoved: cleanup.worktreeRemoved === true,
    branchDeleted: cleanup.branchDeleted === true,
  }, maintenance);
}
