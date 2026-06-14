import path from "node:path";
import { loadConfig, normalizeConfig } from "./config.ts";
import { classifyDirtyFiles, splitPrimaryDirtyFiles } from "./finish-dirty-files.ts";
import { blocked, errorMessage, isFinishStateInput, withFinishReport } from "./finish-report.ts";
import type { FinishPreflight, GuardianFinishResult, LooseRecord } from "./finish-report.ts";
import { createSafetyRef, fetchRemote, getCurrentBranch, getDirtyFiles, getHeadCommit, getRepoRoot, isAncestor, listStashes, listWorktrees, pushBranch, runGit, snapshotWorktreeDirtCommit, tryGit } from "./git.ts";
import { isActiveSession, isTerminalSession } from "./lifecycle.ts";
import { getGuardianPaths, readState, recordSession } from "./state.ts";
import { isRecordLike } from "./types.ts";
import { recoverableGuardianWorktreeBlocker, recoverySessionId } from "./worktree-recovery.ts";

function samePath(a: string, b: string) {
  return path.resolve(a) === path.resolve(b);
}

export type { GuardianFinishResult } from "./finish-report.ts";

export async function guardianFinish(input: LooseRecord = {}): Promise<GuardianFinishResult> {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const { config } = isRecordLike(input.config) ? { config: normalizeConfig(input.config) } : await loadConfig(repoRoot);
  const mode = typeof input.finishMode === "string" ? input.finishMode : config.finishMode;
  let sessionId = typeof input.sessionId === "string" ? input.sessionId : null;
  const preflight: FinishPreflight = {
    sessionId: sessionId ?? null,
    sessionRecorded: false,
    sessionOwnedWorktree: false,
    currentWorktree: null,
    sessionWorktree: null,
    currentBranch: null,
    sessionBranch: null,
    branchProtected: null,
    protectedBranches: config.protectedBranches,
    allowDirtyPaths: config.allowDirtyPaths,
    dirtyFiles: [],
    dirtyFileCount: 0,
    allowedDirtyFiles: [],
    allowedDirtyFileCount: 0,
    blockingDirtyFiles: [],
    blockingDirtyFileCount: 0,
    stashCount: 0,
    baseWorktree: null,
    baseWorktreeBranch: null,
    baseWorktreeDirtyFiles: [],
    baseWorktreeDirtyFileCount: 0,
    baseWorktreeIgnoredDirtyFiles: [],
    baseWorktreeIgnoredDirtyFileCount: 0,
    baseWorktreeRepositionRequired: false,
    baseWorktreeRepositioned: false,
    baseWorktreePreserveReset: false,
    baseWorktreePreservedDirtRef: null,
    baseWorktreeSafetyRefs: [],
    safetyRef: null,
    remote: config.remote,
    baseBranch: config.baseBranch,
    mode,
    blockers: [],
  };
  const paths = await getGuardianPaths(repoRoot);
  const state = isFinishStateInput(input.state) ? input.state : await readState(paths, { repoRoot, config });
  const currentWorktree = await getRepoRoot(cwd);
  preflight.currentWorktree = currentWorktree;
  if (!sessionId) {
    const activeEntry = Object.entries(state.sessions ?? {}).find(([, candidate]) => isActiveSession(candidate) && typeof candidate.worktree_path === "string" && samePath(candidate.worktree_path, currentWorktree));
    sessionId = activeEntry?.[0] ?? null;
  }
  let session = sessionId ? state.sessions?.[sessionId] : undefined;
  const terminalSession = session && isTerminalSession(session) ? session : null;
  if (!session || terminalSession) {
    const currentBranch = await getCurrentBranch(currentWorktree);
    const blocker = recoverableGuardianWorktreeBlocker(repoRoot, currentWorktree, currentBranch, config);
    if (blocker) {
      if (terminalSession) return blocked(`session ${sessionId} is terminal (${String(terminalSession.status)}); start a new session instead of finishing a deleted or closed worktree`, { sessionId, sessionStatus: terminalSession.status }, preflight);
      return blocked(sessionId ? `session ${sessionId} is not active and ${blocker}` : blocker, { sessionId }, preflight);
    }
    if (!currentBranch) return blocked("detached HEAD cannot be finished safely", { worktree: currentWorktree }, preflight);
    const headCommit = await getHeadCommit(currentWorktree);
    sessionId = recoverySessionId(currentBranch, headCommit);
    const recoveredState = await recordSession(repoRoot, config, {
      session_id: sessionId,
      status: "active",
      branch: currentBranch,
      worktree_path: currentWorktree,
      base_ref: `${config.remote}/${config.baseBranch}`,
      head_commit: headCommit,
      safety_refs: [],
    }, { event: { type: "guardian_finish_recover", session_id: sessionId } });
    session = recoveredState.sessions[sessionId];
    preflight.sessionRecovered = true;
  }
  preflight.sessionRecorded = Boolean(session);
  if (!sessionId) return blocked("sessionId is required", {}, preflight);
  preflight.sessionId = sessionId;
  if (!session) return blocked("current session is not recorded in guardian state", { sessionId }, preflight);
  if (typeof session.worktree_path !== "string" || session.worktree_path.length === 0) {
    return blocked("recorded session is missing a worktree path", { sessionId }, preflight);
  }
  preflight.sessionWorktree = session.worktree_path;
  preflight.sessionBranch = session.branch;
  if (isTerminalSession(session)) {
    return blocked(`session ${sessionId} is terminal (${session.status}); start a new session instead of finishing a deleted or closed worktree`, { sessionId, sessionStatus: session.status }, preflight);
  }

  preflight.sessionOwnedWorktree = samePath(session.worktree_path, currentWorktree);
  if (!preflight.sessionOwnedWorktree) {
    return blocked("current session does not own this worktree", { sessionWorktree: session.worktree_path, currentWorktree }, preflight);
  }

  const branch = await getCurrentBranch(currentWorktree);
  preflight.currentBranch = branch;
  if (!branch) return blocked("detached HEAD cannot be finished safely", { worktree: currentWorktree }, preflight);
  preflight.branchProtected = config.protectedBranches.includes(branch);
  if (branch !== session.branch) return blocked("current branch does not match recorded session branch", { branch, sessionBranch: session.branch }, preflight);
  if (preflight.branchProtected) return blocked("protected branches cannot be finished by guardian", { branch }, preflight);

  const dirtyFiles = await getDirtyFiles(currentWorktree);
  const { allowedDirtyFiles, blockingDirtyFiles } = classifyDirtyFiles(dirtyFiles, config.allowDirtyPaths);
  preflight.dirtyFiles = dirtyFiles;
  preflight.dirtyFileCount = dirtyFiles.length;
  preflight.allowedDirtyFiles = allowedDirtyFiles;
  preflight.allowedDirtyFileCount = allowedDirtyFiles.length;
  preflight.blockingDirtyFiles = blockingDirtyFiles;
  preflight.blockingDirtyFileCount = blockingDirtyFiles.length;
  if (blockingDirtyFiles.length) return blocked("worktree has uncommitted changes", { dirtyFiles: blockingDirtyFiles, allowedDirtyFiles, worktree: currentWorktree }, preflight);

  const stashes = await listStashes(currentWorktree);
  preflight.stashCount = stashes.length;
  if (stashes.length && !config.allowStashIfUnrelated) {
    return blocked("stash inventory is non-empty", {
      stashes,
      suggestedCommands: ["git stash list", "git stash show -p stash@{0}"],
    }, preflight, { action: "inspect-stashes", suggestedCommands: ["git stash list", "git stash show -p stash@{0}"] });
  }

  const commit = await getHeadCommit(currentWorktree);
  preflight.commit = commit;
  const existingSafetyRefs = Array.isArray(session.safety_refs) ? session.safety_refs.filter((ref: unknown) => typeof ref === "string") : [];
  const existingSafetyRef = existingSafetyRefs[existingSafetyRefs.length - 1];
  if (mode === "preserve-only" && session.status === "preserved" && existingSafetyRef) {
    preflight.safetyRef = existingSafetyRef;
    return withFinishReport({ ok: true, status: "preserved", mode, branch, worktree: currentWorktree, commit, safetyRef: existingSafetyRef, idempotent: true }, preflight, { action: "already-preserved" });
  }
  const safetyRef = await createSafetyRef(currentWorktree, { sessionId, branch, commit, timestamp: input.timestamp });
  preflight.safetyRef = safetyRef;
  await recordSession(repoRoot, config, {
    ...session,
    session_id: sessionId,
    status: mode === "preserve-only" ? "preserved" : session.status,
    head_commit: commit,
    safety_refs: [...(session.safety_refs ?? []), safetyRef],
  }, { event: { type: "safety_ref_created", session_id: sessionId, ref: safetyRef } });

  if (mode === "preserve-only") {
    return withFinishReport({ ok: true, status: "preserved", mode, branch, worktree: currentWorktree, commit, safetyRef }, preflight, { action: "preserved" });
  }

  if (mode === "push-branch" || mode === "create-pr") {
    try {
      await pushBranch(currentWorktree, config.remote, branch);
    } catch (error) {
      return blocked("push failed", { safetyRef, branch, error: errorMessage(error) }, preflight);
    }
    await recordSession(repoRoot, config, {
      ...session,
      session_id: sessionId,
      status: "preserved",
      head_commit: commit,
      safety_refs: [...(session.safety_refs ?? []), safetyRef],
    }, { event: { type: "guardian_finish", session_id: sessionId, ref: safetyRef } });
    const result: LooseRecord = { ok: true, status: mode === "push-branch" ? "pushed" : "pr-suggested", mode, branch, safetyRef };
    if (mode === "create-pr") {
      result.suggestedCommand = `gh pr create --base ${config.baseBranch} --head ${branch}`;
      result.note = "No native GitHub integration is wired; branch was pushed and a PR command is suggested.";
    }
    return withFinishReport(result, preflight, { action: mode === "push-branch" ? "pushed" : "pushed-and-suggested-pr" });
  }

  if (mode === "merge-to-base") {
    if (input.allowMergeToBase !== true) {
      return blocked("merge-to-base requires explicit allowMergeToBase=true", { safetyRef, branch }, preflight, { action: "requires-explicit-merge-approval" });
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
      await runGit(repoRoot, ["merge", "--ff-only", branch]);
    } catch (error) {
      return blocked("merge-to-base fast-forward merge failed", { safetyRef, branch, baseBranch: config.baseBranch, baseBranchHeadSafetyRef, error: errorMessage(error) }, preflight);
    }
    try {
      await runGit(repoRoot, ["push", config.remote, config.baseBranch]);
    } catch (error) {
      return blocked("merge-to-base push failed after the local fast-forward merge", { safetyRef, branch, baseBranch: config.baseBranch, baseBranchHeadSafetyRef, error: errorMessage(error) }, preflight);
    }
    await fetchRemote(repoRoot, config.remote);
    const proven = await isAncestor(repoRoot, commit, `${config.remote}/${config.baseBranch}`);
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
    await runGit(repoRoot, ["branch", "-d", branch]);
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

  return blocked(`unsupported finish mode: ${mode}`, { safetyRef }, preflight);
}
