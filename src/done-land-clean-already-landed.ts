import { guardianDeleteWorktree } from "./delete-worktree.ts";
import { createSessionLandCleanConfirmToken } from "./done-land-clean-consent.ts";
import type { SuccessfulLandCleanPreflight } from "./done-land-clean-consent.ts";
import { cleanupLandedSession, postFinishMaintenance, withMaintenanceOutcome } from "./done-land-clean-maintenance.ts";
import type { LandCleanContext } from "./done-land-clean.ts";
import { buildSafetyRef } from "./git.ts";

function blocked(reason: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: false, status: "blocked", reason, ...extra };
}

function stashInventory(preflight: SuccessfulLandCleanPreflight): Pick<SuccessfulLandCleanPreflight, "stashCount" | "stashes"> {
  return { stashCount: preflight.stashCount, stashes: preflight.stashes };
}

export async function planAlreadyLandedCleanup(context: LandCleanContext, preflight: SuccessfulLandCleanPreflight, baseRef: string): Promise<Record<string, unknown>> {
  const squashEquivalent = preflight.pullRequestMergeMethod === "squash" && !preflight.headIsAncestorOfBase && preflight.baseTreeMatchesCandidate && preflight.baseParentMatchesSessionStart;
  const ancestryBaseRef = squashEquivalent ? `${preflight.remote}/${preflight.branch}` : baseRef;
  const cleanup = await guardianDeleteWorktree({
    repoRoot: context.repoRoot,
    cwd: context.repoRoot,
    mode: "plan",
    sessionId: context.sessionId,
    deleteBranch: true,
    allowIgnoredFiles: context.input.allowIgnoredFiles === true,
    allowRedundantDirtyPaths: true,
    ancestryBaseRef,
    timestamp: context.input.timestamp,
    config: context.config,
  });
  if (cleanup.ok !== true || typeof cleanup.confirmToken !== "string") {
    const childCleanupReason = typeof cleanup.reason === "string" ? cleanup.reason : undefined;
    const reason = preflight.dirtyFiles.length > 0
      ? "already-landed dirty session work could not be proven redundant; commitMessage is required to preserve it"
      : childCleanupReason ?? "already-landed session cleanup could not be planned";
    return blocked(reason, {
      branch: preflight.branch,
      worktreePath: preflight.worktreePath,
      dirtyFiles: preflight.dirtyFiles,
      ...stashInventory(preflight),
      baseRef,
      cleanup,
      ...(childCleanupReason ? { childCleanupReason } : {}),
    });
  }
  const confirmToken = createSessionLandCleanConfirmToken({ action: "already-landed-clean", context, preflight, commitMessage: "" });
  return { ...preflight, status: "planned", action: "already-landed-clean", baseRef, cleanup, confirmToken, nextAction: "guardian_done mode=apply confirm=true" };
}

export async function applyAlreadyLandedCleanup(context: LandCleanContext, preflight: SuccessfulLandCleanPreflight, baseRef: string): Promise<Record<string, unknown>> {
  const squashEquivalent = preflight.pullRequestMergeMethod === "squash" && !preflight.headIsAncestorOfBase && preflight.baseTreeMatchesCandidate && preflight.baseParentMatchesSessionStart;
  const ancestryBaseRef = squashEquivalent ? `${preflight.remote}/${preflight.branch}` : baseRef;
  const remoteBranchCleanup = squashEquivalent ? { remote: preflight.remote, remoteBranch: preflight.branch, head: preflight.head, safetyRef: buildSafetyRef("remote-branch-cleanup", `${preflight.remote}/${preflight.branch}`, preflight.baseRefOid) } : undefined;
  const cleanup = await cleanupLandedSession(context, "approved session content is already present on the remote base branch", { allowRedundantDirtyPaths: true, ancestryBaseRef, ignoredFiles: preflight.ignoredFiles, ignoredFileFingerprint: preflight.ignoredFileFingerprint, remoteBranchCleanup });
  if (cleanup.ok !== true) return { ...cleanup, ...stashInventory(preflight) };
  const landedCommit = squashEquivalent ? preflight.baseRefOid : preflight.head;
  const maintenance = await postFinishMaintenance(context, [{ commit: landedCommit, source: preflight.branch, reason: "verified landed session content must remain present on the final base" }]);
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
    pullRequestMergeMethod: preflight.pullRequestMergeMethod,
    cleanup,
    worktreeRemoved: cleanup.worktreeRemoved === true,
    branchDeleted: cleanup.branchDeleted === true,
  }, maintenance);
}
