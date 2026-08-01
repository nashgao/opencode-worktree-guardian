import path from "node:path";
import { expandWorktreeRoot, loadConfig } from "./config.ts";
import { buildSafetyRef, createOrReuseSafetyRef, createSafetyRef, deleteBranchAtHead, getDirtyFiles, getHeadCommit, getIgnoredFiles, getRepoRoot, listStashes, listWorktrees, removeWorktree } from "./git.ts";
import { applyRedundantDirtyCleanup, dirtyResultFields, sessionSafetyRefs, validateRedundantDirtyPreflight } from "./delete-worktree-dirty-runtime.ts";
import { isSameOrInside, samePath } from "./filesystem-boundaries.ts";
import { getGuardianPaths, readState, recordSession } from "./state.ts";
import { blocked, createConfirmToken, errorMessage, withDeleteReport } from "./delete-worktree-report.ts";
import { collectIgnoredFileFingerprint, recordAncestryPreflight } from "./delete-worktree-preflight.ts";
import { preflightBranchOnlyDeletion, rejectSymbolicBranchRef } from "./delete-worktree-branch-only.ts";
import { findTarget } from "./delete-worktree-targets.ts";
import { hasBlockingStashInventory } from "./stash-policy.ts";
import type { GuardianSession, WorktreeEntry } from "./types.ts";
import { resolveRemoteAuthority } from "./git-authority.ts";

export type DeleteWorktreeRuntime = {
  readonly afterSafetyRefCreated?: () => Promise<void>;
  readonly beforeWorktreeRemoval?: () => Promise<void>;
};

function emptyDeletePreflight(repoRoot: string, mode: unknown, deleteRequestedBranch: boolean, abandonUnmerged: boolean, allowIgnoredFiles: boolean, allowRedundantDirtyPaths: boolean): Record<string, unknown> {
  return {
    repoRoot: path.resolve(repoRoot),
    mode,
    targetKind: null,
    targetPath: null,
    worktreeListed: null,
    branch: null,
    head: null,
    detached: false,
    sessionId: null,
    sessionStatus: "unrecorded",
    sessionRecorded: false,
    deleteBranch: deleteRequestedBranch,
    abandonUnmerged,
    ancestryRef: null,
    ancestryProven: null,
    unmergedCommits: [],
    unmergedCommitCount: 0,
    allowIgnoredFiles,
    allowRedundantDirtyPaths,
    baseRef: null,
    baseRefOid: null,
    dirtyFiles: [],
    dirtyFileCount: 0,
    redundantDirtyProofs: [],
    redundantDirtyFileCount: 0,
    dirtySnapshotCommit: null,
    dirtySnapshotRef: null,
    dirtySnapshotFileCount: 0,
    dirtySnapshotFiles: [],
    cleanedDirtyFiles: [],
    cleanedDirtyFileCount: 0,
    ignoredFiles: [],
    ignoredFileCount: 0,
    stashCount: 0,
    safetyRef: null,
    blockers: [],
  };
}

async function rejectInvalidDeleteRequest(input: Record<string, unknown>, config: Record<string, unknown>, preflight: Record<string, unknown>) {
  const mode = input.mode;
  if (mode !== "plan" && mode !== "apply") return blocked("mode must be plan or apply", { mode }, preflight);
  if (input.abandonUnmerged === true && input.deleteBranch !== true) return blocked("abandonUnmerged requires deleteBranch=true", {}, preflight);
  if (typeof input.branch === "string" && (config.protectedBranches as string[]).includes(input.branch)) {
    preflight.branch = input.branch;
    return blocked("protected branches cannot be deleted by guardian_delete_worktree", { branch: input.branch }, preflight);
  }
  return null;
}

async function loadDeleteContext(input: Record<string, unknown>, repoRoot: string, config: Record<string, unknown>) {
  const guardianPaths = await getGuardianPaths(repoRoot);
  const state = input.state && typeof input.state === "object" ? input.state as { sessions?: Record<string, GuardianSession> } : await readState(guardianPaths, { repoRoot, config });
  const sessions = Object.values(state.sessions ?? {});
  const worktrees = await listWorktrees(repoRoot) as WorktreeEntry[];
  return { sessions, worktrees };
}

function ancestryBaseRef(input: Record<string, unknown>, config: Record<string, unknown>, session: GuardianSession | undefined): string {
  return typeof input.ancestryBaseRef === "string" ? input.ancestryBaseRef : session?.base_ref ?? `${String(config.remote)}/${String(config.baseBranch)}`;
}

function deleteBranchWasSpecified(input: Record<string, unknown>): boolean {
  return Object.hasOwn(input, "deleteBranch");
}

async function preflightWorktreeDeletion(input: Record<string, unknown>, config: Record<string, unknown>, preflight: Record<string, unknown>, entry: WorktreeEntry, session: GuardianSession | undefined, cwd: string, runtime: DeleteWorktreeRuntime) {
  const repoRoot = String(preflight.repoRoot);
  const deleteRequestedBranch = input.deleteBranch === true;
  const abandonUnmerged = input.abandonUnmerged === true;
  const allowIgnoredFiles = input.allowIgnoredFiles === true;
  preflight.targetPath = path.resolve(entry.path);
  preflight.worktreeListed = true;
  preflight.branch = entry.branch ?? null;
  preflight.head = entry.head ?? null;
  preflight.detached = entry.detached === true || !entry.branch;
  if (samePath(entry.path, repoRoot)) return blocked("refusing to delete the primary repo worktree", { targetPath: entry.path }, preflight);
  const currentWorktree = await getRepoRoot(cwd);
  preflight.currentWorktree = currentWorktree;
  if (samePath(entry.path, currentWorktree)) return blocked("refusing to delete the current execution worktree", { targetPath: entry.path, currentWorktree }, preflight);
  if (entry.detached || !entry.branch) return blocked("detached HEAD worktrees cannot be deleted by guardian_delete_worktree", { targetPath: entry.path }, preflight);
  if ((config.protectedBranches as string[]).includes(entry.branch)) return blocked("protected branches cannot be deleted by guardian_delete_worktree", { branch: entry.branch }, preflight);
  const symbolicBranch = await rejectSymbolicBranchRef(repoRoot, entry.branch, preflight);
  if (symbolicBranch) return symbolicBranch;
  const guardianRoot = path.resolve(repoRoot, expandWorktreeRoot(String(config.worktreeRoot), repoRoot));
  if (!session && !isSameOrInside(path.resolve(entry.path), guardianRoot)) return blocked("unrecorded worktrees outside the Guardian worktree root cannot be deleted", { targetPath: entry.path, guardianRoot }, preflight);
  const dirtyFiles = await getDirtyFiles(entry.path);
  preflight.dirtyFiles = dirtyFiles;
  preflight.dirtyFileCount = dirtyFiles.length;
  const dirtyBlocker = await validateRedundantDirtyPreflight({ input, config, preflight, entry }, session, dirtyFiles);
  if (dirtyBlocker) return dirtyBlocker;
  const ignoredFiles = await getIgnoredFiles(entry.path);
  preflight.ignoredFiles = ignoredFiles;
  preflight.ignoredFileFingerprint = await collectIgnoredFileFingerprint(entry.path, ignoredFiles);
  preflight.ignoredFileCount = ignoredFiles.length;
  if (ignoredFiles.length > 0 && !allowIgnoredFiles) return blocked("worktree has ignored files", { ignoredFiles, targetPath: entry.path }, preflight);
  const stashes = await listStashes(repoRoot);
  preflight.stashCount = stashes.length;
  preflight.stashes = stashes;
  if (hasBlockingStashInventory(config, stashes)) return blocked("stash inventory is non-empty", { stashes }, preflight);
  const head = entry.head ?? await getHeadCommit(entry.path);
  preflight.head = head;
  preflight.safetyTimestamp = input.timestamp ?? session?.created_at ?? session?.session_id ?? "unrecorded-worktree";
  preflight.safetyRef = buildSafetyRef(session?.session_id ?? "unrecorded-worktree", entry.branch, preflight.safetyTimestamp);
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
  const implicitRetainWouldStrandBranch = !deleteRequestedBranch && !deleteBranchWasSpecified(input) && !proven;
  if (deleteRequestedBranch) {
    if (!proven && abandonUnmerged && preflight.unmergedCommitError) return blocked("unmerged commits could not be listed", { branch: entry.branch, head, baseRef, error: preflight.unmergedCommitError }, preflight);
    if (!proven && !abandonUnmerged) return blocked("branch head is not proven reachable from base ref", { branch: entry.branch, head, baseRef }, preflight);
  }
  const confirmToken = createConfirmToken(preflight);
  if (implicitRetainWouldStrandBranch && input.mode === "plan") return blocked("deleteBranch was not specified and the branch head is not proven reachable from base ref; pass deleteBranch=false to keep the branch, or deleteBranch=true with abandonUnmerged=true to abandon it", { branch: entry.branch, head, baseRef }, preflight);
  if (input.mode === "plan") return withDeleteReport({ ok: true, status: "planned", confirmToken }, preflight, { action: "planned" });
  if (input.confirmToken !== confirmToken) return blocked("confirm token mismatch; re-run mode=plan and use the returned confirmToken", { tokenMatched: false }, preflight);
  if (implicitRetainWouldStrandBranch) return blocked("deleteBranch was not specified and the branch head is not proven reachable from base ref; pass deleteBranch=false to keep the branch, or deleteBranch=true with abandonUnmerged=true to abandon it", { branch: entry.branch, head, baseRef }, preflight);
  return applyWorktreeDeletion({ ...input, timestamp: preflight.safetyTimestamp }, config, preflight, entry, session, runtime);
}

async function applyWorktreeDeletion(input: Record<string, unknown>, config: Record<string, unknown>, preflight: Record<string, unknown>, entry: WorktreeEntry, session: GuardianSession | undefined, runtime: DeleteWorktreeRuntime) {
  const repoRoot = String(preflight.repoRoot);
  const deleteRequestedBranch = input.deleteBranch === true;
  const abandonUnmerged = input.abandonUnmerged === true;
  const branch = entry.branch;
  if (!branch) return blocked("detached HEAD worktrees cannot be deleted by guardian_delete_worktree", { targetPath: entry.path }, preflight);
  const safetySessionId = session?.session_id ?? "unrecorded-worktree";
  const head = String(preflight.head ?? await getHeadCommit(entry.path));
  const safetyRef = String(preflight.safetyRef);
  try {
    const safetyRefOptions = { sessionId: safetySessionId, branch, commit: head, ref: safetyRef };
    if (session?.head_commit === head && session.safety_refs?.includes(safetyRef)) await createOrReuseSafetyRef(repoRoot, safetyRefOptions);
    else await createSafetyRef(repoRoot, safetyRefOptions);
  } catch (error) {
    if (error instanceof Error) return blocked("safety ref could not be created", { safetyRef, error: errorMessage(error) }, preflight);
    throw error;
  }
  preflight.safetyRef = safetyRef;
  if (session?.session_id) {
    await recordSession(repoRoot, config, { ...session, session_id: session.session_id, head_commit: head, safety_refs: sessionSafetyRefs(session, safetyRef, preflight) }, { event: { type: "guardian_delete_worktree_safety_ref", session_id: session.session_id, ref: safetyRef } });
  }
  await runtime.afterSafetyRefCreated?.();
  const cleanupBlocker = await applyRedundantDirtyCleanup({ input, preflight, entry }, { safetySessionId, branch, head });
  if (cleanupBlocker) return cleanupBlocker;
  await runtime.beforeWorktreeRemoval?.();
  const ignoredFiles = await getIgnoredFiles(entry.path);
  const ignoredFileFingerprint = await collectIgnoredFileFingerprint(entry.path, ignoredFiles);
  preflight.finalIgnoredFiles = ignoredFiles;
  preflight.finalIgnoredFileFingerprint = ignoredFileFingerprint;
  if (JSON.stringify(ignoredFiles) !== JSON.stringify(preflight.ignoredFiles) || JSON.stringify(ignoredFileFingerprint) !== JSON.stringify(preflight.ignoredFileFingerprint)) {
    return blocked("ignored-file consent changed at deletion boundary; re-run plan and review the updated ignored inventory", {
      safetyRef,
      requiresFreshPlan: true,
      expectedIgnoredFiles: preflight.ignoredFiles,
      expectedIgnoredFileFingerprint: preflight.ignoredFileFingerprint,
      ignoredFiles,
      ignoredFileFingerprint,
    }, preflight);
  }
  try {
    await removeWorktree(repoRoot, entry.path);
  } catch (error) {
    if (error instanceof Error) return recordWorktreeRemovalFailure(repoRoot, config, preflight, entry, session, head, safetyRef, error);
    throw error;
  }
  let branchDeleted = false;
  if (deleteRequestedBranch) {
    try {
      await deleteBranchAtHead(repoRoot, branch, head);
      branchDeleted = true;
    } catch (error) {
      if (error instanceof Error) return recordPartialWorktreeDeletion(repoRoot, config, preflight, entry, session, head, safetyRef, abandonUnmerged, error);
      throw error;
    }
  }
  if (session?.session_id) {
    const abandoned = preflight.ancestryProven === false && abandonUnmerged;
    await recordSession(repoRoot, config, { ...session, session_id: session.session_id, status: abandoned ? "abandoned" : "deleted", head_commit: head, safety_refs: sessionSafetyRefs(session, safetyRef, preflight), deleted_worktree_path: entry.path, deleted_branch: branchDeleted ? branch : null, abandon_unmerged: abandoned, abandoned_branch: abandoned ? branch : undefined, unmerged_commits: abandoned ? preflight.unmergedCommits : undefined }, { event: { type: "guardian_delete_worktree", session_id: session.session_id, ref: safetyRef } });
  }
  const abandoned = preflight.ancestryProven === false && abandonUnmerged;
  return withDeleteReport({ ok: true, status: abandoned ? "abandoned" : "deleted", targetPath: entry.path, branch, head, safetyRef, branchDeleted, worktreeRemoved: true, abandonUnmerged: abandoned, ...dirtyResultFields(preflight) }, preflight, { action: abandoned ? "worktree-and-branch-abandoned" : branchDeleted ? "worktree-and-branch-deleted" : "worktree-deleted", worktreeRemoved: true });
}

async function recordWorktreeRemovalFailure(repoRoot: string, config: Record<string, unknown>, preflight: Record<string, unknown>, entry: WorktreeEntry, session: GuardianSession | undefined, head: string, safetyRef: string, error: unknown) {
  const worktreeRemoveError = errorMessage(error);
  const ignoredFiles = await getIgnoredFiles(entry.path);
  const ignoredFileFingerprint = await collectIgnoredFileFingerprint(entry.path, ignoredFiles);
  preflight.finalIgnoredFiles = ignoredFiles;
  preflight.finalIgnoredFileFingerprint = ignoredFileFingerprint;
  if (session?.session_id) {
    await recordSession(repoRoot, config, { ...session, session_id: session.session_id, head_commit: head, safety_refs: sessionSafetyRefs(session, safetyRef, preflight), worktree_delete_failed: true, worktree_delete_error: worktreeRemoveError }, { event: { type: "guardian_delete_worktree_remove_failed", session_id: session.session_id, ref: safetyRef } });
  }
  return withDeleteReport({ ok: false, status: "blocked", reason: "worktree removal failed at deletion boundary; re-run plan and review current ignored-file consent", targetPath: entry.path, branch: entry.branch, head, safetyRef, branchDeleted: false, worktreeRemoved: false, error: worktreeRemoveError, requiresFreshPlan: true, ignoredFiles, ignoredFileFingerprint, ...dirtyResultFields(preflight) }, preflight, { action: "worktree-remove-failed", worktreeRemoved: false, worktreeRemoveError, requiresFreshPlan: true });
}

async function recordPartialWorktreeDeletion(repoRoot: string, config: Record<string, unknown>, preflight: Record<string, unknown>, entry: WorktreeEntry, session: GuardianSession | undefined, head: string, safetyRef: string, abandonUnmerged: boolean, error: unknown) {
  const branchDeleteError = errorMessage(error);
  if (session?.session_id) {
    await recordSession(repoRoot, config, { ...session, session_id: session.session_id, status: "deleted", head_commit: head, safety_refs: sessionSafetyRefs(session, safetyRef, preflight), deleted_worktree_path: entry.path, deleted_branch: null, branch_delete_failed: true, branch_delete_error: branchDeleteError, abandon_unmerged: preflight.ancestryProven === false && abandonUnmerged, unmerged_commits: preflight.ancestryProven === false && abandonUnmerged ? preflight.unmergedCommits : undefined }, { event: { type: "guardian_delete_worktree_partial", session_id: session.session_id, ref: safetyRef } });
  }
  return withDeleteReport({ ok: false, status: "partial", reason: "worktree deleted but branch deletion failed", targetPath: entry.path, branch: entry.branch, head, safetyRef, branchDeleted: false, worktreeRemoved: true, error: branchDeleteError, ...dirtyResultFields(preflight) }, preflight, { action: "worktree-deleted-branch-delete-failed", worktreeRemoved: true, branchDeleteError });
}

export async function guardianDeleteWorktree(input: Record<string, unknown> = {}, runtime: DeleteWorktreeRuntime = {}): Promise<Record<string, unknown>> {
  const { timestamp, ...withoutTimestamp } = input;
  const normalizedTimestamp = typeof timestamp === "string" && timestamp.trim().length > 0 ? timestamp.trim() : undefined;
  input = normalizedTimestamp === undefined ? withoutTimestamp : { ...withoutTimestamp, timestamp: normalizedTimestamp };
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const { config } = input.config && typeof input.config === "object" ? { config: input.config as Record<string, unknown> } : await loadConfig(repoRoot);
  const preflight = emptyDeletePreflight(repoRoot, input.mode, input.deleteBranch === true, input.abandonUnmerged === true, input.allowIgnoredFiles === true, input.allowRedundantDirtyPaths === true);
  const invalid = await rejectInvalidDeleteRequest(input, config, preflight);
  if (invalid) return invalid;
  if (typeof input.branch === "string") {
    const symbolicBranch = await rejectSymbolicBranchRef(repoRoot, input.branch, preflight);
    if (symbolicBranch) return symbolicBranch;
  }
  const { sessions, worktrees } = await loadDeleteContext(input, repoRoot, config);
  const target = await findTarget({ ...input, repoRoot }, worktrees, sessions);
  const { entry, session, targetKind, branch: resolvedBranch, head: resolvedHead, ownershipProof, unresolvedReason } = target;
  if (!entry && targetKind !== "orphan-branch" && targetKind !== "stale-branch" && targetKind !== "merged-branch") return blocked(unresolvedReason, {}, preflight);
  preflight.targetKind = targetKind ?? "worktree";
  preflight.worktreeListed = Boolean(entry);
  preflight.sessionId = session?.session_id ?? null;
  preflight.sessionStatus = session?.status ?? "unrecorded";
  preflight.sessionRecorded = Boolean(session);
  if (targetKind === "orphan-branch" || targetKind === "stale-branch" || targetKind === "merged-branch") {
    return preflightBranchOnlyDeletion(input, config, preflight, worktrees, targetKind, session, resolvedBranch, resolvedHead, ownershipProof, unresolvedReason);
  }
  if (!entry) return blocked(unresolvedReason, {}, preflight);
  return preflightWorktreeDeletion(input, config, preflight, entry, session, cwd, runtime);
}
