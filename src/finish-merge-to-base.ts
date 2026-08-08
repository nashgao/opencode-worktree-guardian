import path from "node:path";
import type { GuardianConfig, GuardianSession } from "./types.ts";
import { splitPrimaryDirtyFiles } from "./finish-dirty-files.ts";
import { observeFreshFinishBaseLineage, recordFinishBaseLineage } from "./finish-base-lineage.ts";
import { blocked, errorMessage, withFinishReport } from "./finish-report.ts";
import type { FinishPreflight, GuardianFinishResult, LooseRecord } from "./finish-report.ts";
import { createSafetyRef, deleteBranchAtHead, fetchRemote, getCurrentBranch, getDirtyFiles, getHeadCommit, getRepoRoot, isAncestor, listWorktrees, runGit, snapshotWorktreeDirtCommit, tryGit, validateConfiguredRemote, validateGitRef } from "./git.ts";
import { configuredRemoteAuthority } from "./git-authority.ts";
import { recordSession } from "./state.ts";

type FinishMergeToBaseContext = {
  input: LooseRecord;
  repoRoot: string;
  config: GuardianConfig;
  session: GuardianSession;
  sessionId: string;
  branch: string;
  commit: string;
  currentWorktree: string;
  safetyRef: string;
  preflight: FinishPreflight;
  mode: "merge-to-base";
};

function samePath(a: string, b: string) {
  return path.resolve(a) === path.resolve(b);
}

export async function finishMergeToBase({ input, repoRoot, config, session, sessionId, branch, commit, currentWorktree, safetyRef, preflight, mode }: FinishMergeToBaseContext): Promise<GuardianFinishResult> {
  if (input.allowMergeToBase !== true) {
    return blocked("merge-to-base requires explicit allowMergeToBase=true", { safetyRef, branch }, preflight, { action: "requires-explicit-merge-approval" });
  }
  await validateConfiguredRemote(repoRoot, config.remote);
  validateGitRef(config.baseBranch);
  const baseAuthorityRef = configuredRemoteAuthority(config).authorityRef;
  try {
    const baseLineage = await observeFreshFinishBaseLineage(repoRoot, config, commit);
    recordFinishBaseLineage(preflight, baseLineage);
    if (!baseLineage.baseIsAncestorOfHead) {
      return blocked("fresh remote base is not an ancestor of the session commit", { safetyRef, commit, baseRefOid: baseLineage.baseRefOid, baseAuthorityRef: baseLineage.baseAuthorityRef }, preflight);
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return blocked("remote base ref could not be fetched or resolved", { safetyRef, commit, error: errorMessage(error) }, preflight);
  }
  const baseWorktree = await getRepoRoot(repoRoot);
  const baseWorktreeBranch = await getCurrentBranch(baseWorktree);
  const baseWorktreeOriginalHead = await getHeadCommit(baseWorktree);
  const baseWorktreeAllDirtyFiles = await getDirtyFiles(baseWorktree);
  const { ignoredDirtyFiles: baseWorktreeIgnoredDirtyFiles, blockingDirtyFiles: baseWorktreeDirtyFiles } = splitPrimaryDirtyFiles(baseWorktreeAllDirtyFiles, repoRoot, config);
  preflight.baseWorktree = baseWorktree;
  preflight.baseWorktreeBranch = baseWorktreeBranch;
  preflight.baseWorktreeDirtyFiles = baseWorktreeDirtyFiles;
  preflight.baseWorktreeDirtyFileCount = baseWorktreeDirtyFiles.length;
  preflight.baseWorktreeIgnoredDirtyFiles = baseWorktreeIgnoredDirtyFiles;
  preflight.baseWorktreeIgnoredDirtyFileCount = baseWorktreeIgnoredDirtyFiles.length;
  preflight.baseWorktreeRepositionRequired = baseWorktreeBranch !== config.baseBranch;

  const baseWorktreeSafetyRefs: string[] = [];

  if (baseWorktreeDirtyFiles.length > 0) {
    const allowPreserveReset = config.allowBaseWorktreePreserveReset === true || input.allowBaseWorktreePreserveReset === true;
    if (!allowPreserveReset) {
      return blocked("merge-to-base requires the primary repo worktree to be clean; Guardian will not self-heal uncommitted base-worktree changes unless allowBaseWorktreePreserveReset=true, so commit or preserve them first", { safetyRef, branch, baseWorktree, baseWorktreeBranch, dirtyFiles: baseWorktreeDirtyFiles }, preflight);
    }
    let preservedDirtCommit: string;
    try {
      preservedDirtCommit = await snapshotWorktreeDirtCommit(baseWorktree, {
        parentCommit: baseWorktreeOriginalHead,
        paths: baseWorktreeDirtyFiles,
        message: `guardian: preserved dirty primary worktree before merge-to-base (session ${sessionId})`,
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return blocked("merge-to-base could not snapshot the dirty primary worktree before preserve-reset", { safetyRef, branch, baseWorktree, baseWorktreeBranch, dirtyFiles: baseWorktreeDirtyFiles, error: errorMessage(error) }, preflight);
    }
    const baseWorktreePreservedDirtRef = await createSafetyRef(baseWorktree, {
      sessionId: `${sessionId}/base-worktree-preserved-dirt`,
      branch: baseWorktreeBranch ?? `detached-${baseWorktreeOriginalHead.slice(0, 12)}`,
      commit: preservedDirtCommit,
      timestamp: input.timestamp,
    });
    baseWorktreeSafetyRefs.push(baseWorktreePreservedDirtRef);
    preflight.baseWorktreePreserveReset = true;
    preflight.baseWorktreePreservedDirtRef = baseWorktreePreservedDirtRef;
    preflight.baseWorktreeSafetyRefs = [...baseWorktreeSafetyRefs];

    // Scope the clean to the recomputed blocking paths only: reset --hard touches just tracked files,
    // then a path-scoped clean removes the remaining untracked dirt. A blanket clean would delete the
    // Guardian session worktrees that live under the worktree root.
    try {
      await runGit(baseWorktree, ["reset", "--hard", baseWorktreeOriginalHead]);
      const remainingUntracked = splitPrimaryDirtyFiles(await getDirtyFiles(baseWorktree), repoRoot, config).blockingDirtyFiles;
      if (remainingUntracked.length > 0) {
        await runGit(baseWorktree, ["clean", "-f", "-d", "--", ...remainingUntracked]);
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return blocked("merge-to-base could not reset the primary worktree clean after preserving its dirt", { safetyRef, branch, baseWorktree, baseWorktreePreservedDirtRef, error: errorMessage(error) }, preflight);
    }

    const stillDirty = splitPrimaryDirtyFiles(await getDirtyFiles(baseWorktree), repoRoot, config).blockingDirtyFiles;
    preflight.baseWorktreeDirtyFiles = stillDirty;
    preflight.baseWorktreeDirtyFileCount = stillDirty.length;
    if (stillDirty.length > 0) {
      return blocked("merge-to-base could not fully clean the primary worktree after preserving its dirt", { safetyRef, branch, baseWorktree, baseWorktreePreservedDirtRef, dirtyFiles: stillDirty }, preflight);
    }
  }

  if (baseWorktreeBranch !== config.baseBranch) {
    const baseBranchExists = await tryGit(baseWorktree, ["rev-parse", "--verify", `refs/heads/${config.baseBranch}^{commit}`]);
    if (!baseBranchExists.ok) {
      return blocked("merge-to-base requires the configured base branch to exist locally; refusing to auto-create a tracking branch", { safetyRef, branch, baseWorktree, baseBranch: config.baseBranch, baseWorktreeBranch }, preflight);
    }
    const conflictingWorktree = (await listWorktrees(repoRoot)).find((entry) => entry.branch === config.baseBranch && !samePath(entry.path, baseWorktree));
    if (conflictingWorktree) {
      return blocked("merge-to-base cannot check out the base branch because it is checked out in another worktree", { safetyRef, branch, baseWorktree, baseBranch: config.baseBranch, conflictingWorktree: conflictingWorktree.path }, preflight);
    }
    const baseOriginalHeadSafetyRef = await createSafetyRef(baseWorktree, {
      sessionId: `${sessionId}/base-worktree-original-head`,
      branch: baseWorktreeBranch ?? `detached-${baseWorktreeOriginalHead.slice(0, 12)}`,
      commit: baseWorktreeOriginalHead,
      timestamp: input.timestamp,
    });
    baseWorktreeSafetyRefs.push(baseOriginalHeadSafetyRef);
    preflight.baseWorktreeSafetyRefs = [...baseWorktreeSafetyRefs];
    // --no-overwrite-ignore keeps git's refuse-to-overwrite behavior as a safety net for ignored files.
    const repositioned = await tryGit(baseWorktree, ["checkout", "--no-overwrite-ignore", config.baseBranch]);
    if (!repositioned.ok) {
      return blocked("merge-to-base could not check out the base branch in the primary repo worktree", { safetyRef, branch, baseWorktree, baseBranch: config.baseBranch, baseWorktreeOriginalBranch: baseWorktreeBranch, baseWorktreeOriginalHeadSafetyRef: baseOriginalHeadSafetyRef, error: errorMessage(repositioned.error) }, preflight);
    }
    preflight.baseWorktreeRepositioned = true;
    const repositionedBranch = await getCurrentBranch(baseWorktree);
    const repositionedDirtyFiles = splitPrimaryDirtyFiles(await getDirtyFiles(baseWorktree), repoRoot, config).blockingDirtyFiles;
    preflight.baseWorktreeBranch = repositionedBranch;
    if (repositionedBranch !== config.baseBranch || repositionedDirtyFiles.length > 0) {
      return blocked("merge-to-base could not bring the primary repo worktree to a clean base-branch state", { safetyRef, branch, baseWorktree, baseBranch: config.baseBranch, baseWorktreeBranch: repositionedBranch, dirtyFiles: repositionedDirtyFiles, baseWorktreeOriginalHeadSafetyRef: baseOriginalHeadSafetyRef }, preflight);
    }
  }

  // Safety-ref the local base branch head before the fast-forward merge so it stays recoverable.
  const baseBranchLocalHead = await getHeadCommit(baseWorktree);
  const baseBranchHeadSafetyRef = await createSafetyRef(baseWorktree, {
    sessionId: `${sessionId}/base-branch-head`,
    branch: config.baseBranch,
    commit: baseBranchLocalHead,
    timestamp: input.timestamp,
  });
  baseWorktreeSafetyRefs.push(baseBranchHeadSafetyRef);
  preflight.baseWorktreeSafetyRefs = [...baseWorktreeSafetyRefs];

  try {
    const baseLineage = await observeFreshFinishBaseLineage(repoRoot, config, commit);
    recordFinishBaseLineage(preflight, baseLineage);
    if (!baseLineage.baseIsAncestorOfHead) {
      return blocked("fresh remote base is not an ancestor of the session commit", { safetyRef, commit, baseRefOid: baseLineage.baseRefOid, baseAuthorityRef: baseLineage.baseAuthorityRef }, preflight);
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return blocked("remote base ref could not be fetched or resolved", { safetyRef, commit, error: errorMessage(error) }, preflight);
  }

  try {
    validateGitRef(branch);
    await runGit(repoRoot, ["merge", "--ff-only", branch]);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return blocked("merge-to-base fast-forward merge failed", { safetyRef, branch, baseBranch: config.baseBranch, baseBranchHeadSafetyRef, error: errorMessage(error) }, preflight);
  }
  try {
    validateGitRef(config.baseBranch);
    await runGit(repoRoot, ["push", config.remote, config.baseBranch]);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return blocked("merge-to-base push failed after the local fast-forward merge", { safetyRef, branch, baseBranch: config.baseBranch, baseBranchHeadSafetyRef, error: errorMessage(error) }, preflight);
  }
  await fetchRemote(repoRoot, config.remote);
  const proven = await isAncestor(repoRoot, commit, baseAuthorityRef);
  if (!proven) return blocked("merged commit is not proven reachable from remote base", { safetyRef, commit }, preflight);

  const shouldCleanup = config.autoCleanup === true || input.allowCleanup === true;
  if (!shouldCleanup) {
    await recordSession(repoRoot, config, {
      ...session,
      session_id: sessionId,
      status: "finished",
      head_commit: commit,
      safety_refs: [...(session.safety_refs ?? []), safetyRef, ...baseWorktreeSafetyRefs],
    }, { event: { type: "guardian_finish", session_id: sessionId, ref: safetyRef } });
    return withFinishReport({ ok: true, status: "merged", mode, branch, commit, safetyRef, baseWorktreeSafetyRefs, cleaned: false }, preflight, { action: "merged-without-cleanup" });
  }
  if (preflight.allowedDirtyFileCount > 0) {
    await recordSession(repoRoot, config, {
      ...session,
      session_id: sessionId,
      status: "finished",
      head_commit: commit,
      safety_refs: [...(session.safety_refs ?? []), safetyRef, ...baseWorktreeSafetyRefs],
    }, { event: { type: "guardian_finish", session_id: sessionId, ref: safetyRef } });
    return withFinishReport({ ok: true, status: "merged", mode, branch, commit, safetyRef, baseWorktreeSafetyRefs, cleaned: false, cleanupSkippedReason: "allowed dirty files are present" }, preflight, { action: "merged-without-cleanup", cleanupSkippedReason: "allowed dirty files are present" });
  }
  if (samePath(currentWorktree, repoRoot)) {
    return blocked("refusing to remove the primary/current repo worktree", { safetyRef, commit, branch }, preflight);
  }

  await runGit(repoRoot, ["worktree", "remove", currentWorktree]);
  try {
    await deleteBranchAtHead(repoRoot, branch, commit);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const branchDeleteError = errorMessage(error);
    await recordSession(repoRoot, config, {
      ...session,
      session_id: sessionId,
      status: "finished",
      head_commit: commit,
      safety_refs: [...(session.safety_refs ?? []), safetyRef, ...baseWorktreeSafetyRefs],
      deleted_worktree_path: currentWorktree,
      deleted_branch: null,
      branch_delete_failed: true,
      branch_delete_error: branchDeleteError,
    }, { event: { type: "guardian_finish_cleanup_partial", session_id: sessionId, ref: safetyRef } });
    return withFinishReport({ ok: false, status: "partial", reason: "worktree deleted but branch deletion failed", mode, branch, commit, safetyRef, baseWorktreeSafetyRefs, cleaned: false, worktreeRemoved: true, branchDeleted: false, error: branchDeleteError }, preflight, { action: "worktree-deleted-branch-delete-failed", worktreeRemoved: true, branchDeleteError });
  }
  await recordSession(repoRoot, config, {
    ...session,
    session_id: sessionId,
    status: "finished",
    head_commit: commit,
    safety_refs: [...(session.safety_refs ?? []), safetyRef, ...baseWorktreeSafetyRefs],
    deleted_worktree_path: currentWorktree,
    deleted_branch: branch,
  }, { event: { type: "guardian_finish", session_id: sessionId, ref: safetyRef } });
  return withFinishReport({ ok: true, status: "finished", mode, branch, commit, safetyRef, baseWorktreeSafetyRefs, cleaned: true }, preflight, { action: "merged-and-cleaned" });
}
