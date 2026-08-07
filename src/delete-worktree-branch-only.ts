import path from "node:path";
import { buildSafetyRef, createOrReuseSafetyRef, createSafetyRef, deleteBranchAtHead, getBranchCommit, getSymbolicRefTarget, listStashes } from "./git.ts";
import { recordSession } from "./state.ts";
import { blocked, createConfirmToken, errorMessage, withDeleteReport } from "./delete-worktree-report.ts";
import { recordAncestryPreflight } from "./delete-worktree-preflight.ts";
import type { GuardianSession, WorktreeEntry } from "./types.ts";
import { hasBlockingStashInventory } from "./stash-policy.ts";
import { resolveRemoteAuthority } from "./git-authority.ts";

type BranchOnlyTargetKind = "orphan-branch" | "stale-branch" | "merged-branch";

function sessionSafetyRefs(session: GuardianSession, safetyRef: string) {
  return [...new Set([...(session.safety_refs ?? []), safetyRef])];
}

function ancestryBaseRef(input: Record<string, unknown>, config: Record<string, unknown>, session: GuardianSession | undefined): string {
  return typeof input.ancestryBaseRef === "string" ? input.ancestryBaseRef : session?.base_ref ?? `${String(config.remote)}/${String(config.baseBranch)}`;
}

export async function rejectSymbolicBranchRef(repoRoot: string, branch: string, preflight: Record<string, unknown>) {
  const symbolicTarget = await getSymbolicRefTarget(repoRoot, `refs/heads/${branch}`);
  return symbolicTarget ? blocked("symbolic branch refs cannot be deleted by guardian_delete_worktree", { branch, symbolicTarget }, preflight) : null;
}

export async function preflightBranchOnlyDeletion(
  input: Record<string, unknown>,
  config: Record<string, unknown>,
  preflight: Record<string, unknown>,
  worktrees: WorktreeEntry[],
  targetKind: BranchOnlyTargetKind,
  session: GuardianSession | undefined,
  resolvedBranch: string | undefined,
  resolvedHead: string | undefined,
  ownershipProof: string | undefined,
  unresolvedReason: string,
) {
  const repoRoot = String(preflight.repoRoot);
  const deleteRequestedBranch = input.deleteBranch === true;
  const abandonUnmerged = input.abandonUnmerged === true;
  const branch = String(resolvedBranch ?? session?.branch ?? "");
  preflight.targetPath = session?.worktree_path ? path.resolve(String(session.worktree_path)) : null;
  preflight.branch = branch;
  preflight.detached = false;
  preflight.ownershipProof = ownershipProof ?? (targetKind === "orphan-branch" ? "active-session" : targetKind === "merged-branch" ? "ancestry-proof" : null);
  if (targetKind === "stale-branch" && !ownershipProof) return blocked(unresolvedReason, { branch }, preflight);
  if (!deleteRequestedBranch) return blocked(`${targetKind} cleanup requires deleteBranch=true`, { branch }, preflight);
  if ((config.protectedBranches as string[]).includes(branch)) return blocked("protected branches cannot be deleted by guardian_delete_worktree", { branch }, preflight);
  const symbolicBranch = await rejectSymbolicBranchRef(repoRoot, branch, preflight);
  if (symbolicBranch) return symbolicBranch;
  const checkedOut = worktrees.find((worktree) => worktree.branch === branch);
  preflight.branchCheckedOut = Boolean(checkedOut);
  if (checkedOut) return blocked("branch is checked out in a git worktree", { branch, targetPath: checkedOut.path }, preflight);
  let head = resolvedHead;
  try {
    head = head ?? await getBranchCommit(repoRoot, branch);
  } catch {
    return blocked("branch does not exist", { branch }, preflight);
  }
  preflight.head = head;
  const stashes = await listStashes(repoRoot);
  preflight.stashCount = stashes.length;
  preflight.stashes = stashes;
  if (hasBlockingStashInventory(config, stashes)) return blocked("stash inventory is non-empty", { stashes }, preflight);
  const baseRef = ancestryBaseRef(input, config, session);
  let baseAuthorityRef: string;
  try {
    const authority = resolveRemoteAuthority(baseRef, config);
    baseAuthorityRef = authority.authorityRef;
    preflight.ancestryRef = authority.displayRef;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return blocked("ancestry base ref is malformed or untrusted", { baseRef, error: errorMessage(error) }, preflight);
  }
  const proven = await recordAncestryPreflight(repoRoot, head, baseAuthorityRef, preflight);
  if (!proven && abandonUnmerged && preflight.unmergedCommitError) return blocked("unmerged commits could not be listed", { branch, head, baseRef, error: preflight.unmergedCommitError }, preflight);
  if (!proven && !abandonUnmerged) return blocked("branch head is not proven reachable from base ref", { branch, head, baseRef }, preflight);
  const safetySessionId = session?.session_id ?? (targetKind === "merged-branch" ? "merged-local-branch" : "orphan-guardian-branch");
  preflight.safetyRef = buildSafetyRef(safetySessionId, branch, input.timestamp ?? session?.created_at ?? session?.session_id ?? head);
  const confirmToken = createConfirmToken(preflight);
  if (input.mode === "plan") return withDeleteReport({ ok: true, status: "planned", confirmToken }, preflight, { action: "planned" });
  if (input.confirmToken !== confirmToken) return blocked("confirm token mismatch; re-run mode=plan and use the returned confirmToken", { tokenMatched: false }, preflight);
  return applyBranchOnlyDeletion(config, preflight, session, targetKind, branch, head, proven, abandonUnmerged);
}

async function applyBranchOnlyDeletion(config: Record<string, unknown>, preflight: Record<string, unknown>, session: GuardianSession | undefined, targetKind: BranchOnlyTargetKind, branch: string, head: string, proven: boolean, abandonUnmerged: boolean) {
  const repoRoot = String(preflight.repoRoot);
  const safetyRef = String(preflight.safetyRef);
  try {
    const safetyRefOptions = { sessionId: session?.session_id ?? (targetKind === "merged-branch" ? "merged-local-branch" : "orphan-guardian-branch"), branch, commit: head, ref: safetyRef };
    if (session?.head_commit === head && session.safety_refs?.includes(safetyRef)) await createOrReuseSafetyRef(repoRoot, safetyRefOptions);
    else await createSafetyRef(repoRoot, safetyRefOptions);
  } catch (error) {
    if (error instanceof Error) return blocked("safety ref could not be created", { safetyRef, error: errorMessage(error) }, preflight);
    throw error;
  }
  preflight.safetyRef = safetyRef;
  try {
    await deleteBranchAtHead(repoRoot, branch, head);
  } catch (error) {
    if (error instanceof Error) return recordBranchOnlyDeletionFailure(repoRoot, config, preflight, session, targetKind, branch, head, safetyRef, abandonUnmerged, error);
    throw error;
  }
  if (session?.session_id) {
    await recordSession(repoRoot, config, {
      ...session,
      session_id: session.session_id,
      status: !proven && abandonUnmerged ? "abandoned" : "deleted",
      head_commit: head,
      safety_refs: sessionSafetyRefs(session, safetyRef),
      deleted_worktree_path: session.worktree_path,
      deleted_branch: branch,
      branch_only_delete: true,
      branch_delete_failed: undefined,
      branch_delete_error: undefined,
      worktree_delete_failed: undefined,
      worktree_delete_error: undefined,
      abandon_unmerged: !proven && abandonUnmerged,
      abandoned_branch: !proven && abandonUnmerged ? branch : undefined,
      unmerged_commits: !proven && abandonUnmerged ? preflight.unmergedCommits : undefined,
    }, { event: { type: targetKind === "stale-branch" ? "guardian_delete_stale_branch" : "guardian_delete_orphan_branch", session_id: session.session_id, ref: safetyRef } });
  }
  const actionPrefix = targetKind === "stale-branch" ? "stale-branch" : targetKind === "merged-branch" ? "merged-branch" : "orphan-branch";
  return withDeleteReport({ ok: true, status: !proven && abandonUnmerged ? "abandoned" : "deleted", targetPath: session?.worktree_path ?? null, branch, head, safetyRef, branchDeleted: true, worktreeRemoved: false, abandonUnmerged: !proven && abandonUnmerged }, preflight, { action: !proven && abandonUnmerged ? `${actionPrefix}-abandoned` : `${actionPrefix}-deleted`, worktreeRemoved: false });
}

async function recordBranchOnlyDeletionFailure(repoRoot: string, config: Record<string, unknown>, preflight: Record<string, unknown>, session: GuardianSession | undefined, targetKind: BranchOnlyTargetKind, branch: string, head: string, safetyRef: string, abandonUnmerged: boolean, error: unknown) {
  const branchDeleteError = errorMessage(error);
  if (session?.session_id) {
    try {
      await recordSession(repoRoot, config, { ...session, session_id: session.session_id, head_commit: head, safety_refs: sessionSafetyRefs(session, safetyRef), branch_delete_failed: true, branch_delete_error: branchDeleteError, abandon_unmerged: preflight.ancestryProven === false && abandonUnmerged, unmerged_commits: preflight.ancestryProven === false && abandonUnmerged ? preflight.unmergedCommits : undefined }, { event: { type: "guardian_delete_branch_only_failed", session_id: session.session_id, ref: safetyRef } });
    } catch (recordError) {
      // The branch deletion itself already failed for the caller-visible reason returned below;
      // failing to persist that as session audit state must not mask it behind an uncaught crash.
      if (!(recordError instanceof Error)) throw recordError;
    }
  }
  const actionPrefix = targetKind === "stale-branch" ? "stale-branch" : targetKind === "merged-branch" ? "merged-branch" : "orphan-branch";
  return withDeleteReport({ ok: false, status: "blocked", reason: "branch deletion failed", targetPath: session?.worktree_path ?? null, branch, head, safetyRef, branchDeleted: false, worktreeRemoved: false, error: branchDeleteError }, preflight, { action: `${actionPrefix}-delete-failed`, worktreeRemoved: false, branchDeleteError });
}
