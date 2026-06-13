import path from "node:path";
import { loadConfig, normalizeConfig } from "./config.ts";
import { classifyDirtyFiles, splitPrimaryDirtyFiles } from "./finish-dirty-files.ts";
import { blocked, errorMessage, isFinishStateInput, withFinishReport } from "./finish-report.ts";
import type { FinishPreflight, GuardianFinishResult, LooseRecord } from "./finish-report.ts";
import { createSafetyRef, fetchRemote, getCurrentBranch, getDirtyFiles, getHeadCommit, getRepoRoot, isAncestor, listStashes, pushBranch, runGit } from "./git.ts";
import { isTerminalSession } from "./lifecycle.ts";
import { getGuardianPaths, readState, recordSession } from "./state.ts";
import { isRecordLike } from "./types.ts";

function samePath(a: string, b: string) {
  return path.resolve(a) === path.resolve(b);
}

export type { GuardianFinishResult } from "./finish-report.ts";

export async function guardianFinish(input: LooseRecord = {}): Promise<GuardianFinishResult> {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const { config } = isRecordLike(input.config) ? { config: normalizeConfig(input.config) } : await loadConfig(repoRoot);
  const mode = typeof input.finishMode === "string" ? input.finishMode : config.finishMode;
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : null;
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
    safetyRef: null,
    remote: config.remote,
    baseBranch: config.baseBranch,
    mode,
    blockers: [],
  };
  if (!sessionId) return blocked("sessionId is required", {}, preflight);

  const paths = await getGuardianPaths(repoRoot);
  const state = isFinishStateInput(input.state) ? input.state : await readState(paths, { repoRoot, config });
  const session = state.sessions?.[sessionId];
  preflight.sessionRecorded = Boolean(session);
  if (!session) return blocked("current session is not recorded in guardian state", { sessionId }, preflight);
  if (typeof session.worktree_path !== "string" || session.worktree_path.length === 0) {
    return blocked("recorded session is missing a worktree path", { sessionId }, preflight);
  }
  preflight.sessionWorktree = session.worktree_path;
  preflight.sessionBranch = session.branch;
  if (isTerminalSession(session)) {
    return blocked(`session ${sessionId} is terminal (${session.status}); start a new session instead of finishing a deleted or closed worktree`, { sessionId, sessionStatus: session.status }, preflight);
  }

  const currentWorktree = await getRepoRoot(cwd);
  preflight.currentWorktree = currentWorktree;
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
    const baseWorktreeAllDirtyFiles = await getDirtyFiles(baseWorktree);
    const { ignoredDirtyFiles: baseWorktreeIgnoredDirtyFiles, blockingDirtyFiles: baseWorktreeDirtyFiles } = splitPrimaryDirtyFiles(baseWorktreeAllDirtyFiles, repoRoot, config);
    preflight.baseWorktree = baseWorktree;
    preflight.baseWorktreeBranch = baseWorktreeBranch;
    preflight.baseWorktreeDirtyFiles = baseWorktreeDirtyFiles;
    preflight.baseWorktreeDirtyFileCount = baseWorktreeDirtyFiles.length;
    preflight.baseWorktreeIgnoredDirtyFiles = baseWorktreeIgnoredDirtyFiles;
    preflight.baseWorktreeIgnoredDirtyFileCount = baseWorktreeIgnoredDirtyFiles.length;
    if (baseWorktreeBranch !== config.baseBranch) {
      return blocked("merge-to-base requires primary repo worktree to already be on the base branch", { safetyRef, branch, baseWorktree, baseWorktreeBranch, baseBranch: config.baseBranch }, preflight);
    }
    if (baseWorktreeDirtyFiles.length > 0) {
      return blocked("merge-to-base requires primary repo worktree to be clean", { safetyRef, branch, baseWorktree, dirtyFiles: baseWorktreeDirtyFiles }, preflight);
    }
    await runGit(repoRoot, ["checkout", config.baseBranch]);
    await runGit(repoRoot, ["merge", "--ff-only", branch]);
    await runGit(repoRoot, ["push", config.remote, config.baseBranch]);
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
        safety_refs: [...(session.safety_refs ?? []), safetyRef],
      }, { event: { type: "guardian_finish", session_id: sessionId, ref: safetyRef } });
      return withFinishReport({ ok: true, status: "merged", mode, branch, commit, safetyRef, cleaned: false }, preflight, { action: "merged-without-cleanup" });
    }
    if (preflight.allowedDirtyFileCount > 0) {
      await recordSession(repoRoot, config, {
        ...session,
        session_id: sessionId,
        status: "finished",
        head_commit: commit,
        safety_refs: [...(session.safety_refs ?? []), safetyRef],
      }, { event: { type: "guardian_finish", session_id: sessionId, ref: safetyRef } });
      return withFinishReport({ ok: true, status: "merged", mode, branch, commit, safetyRef, cleaned: false, cleanupSkippedReason: "allowed dirty files are present" }, preflight, { action: "merged-without-cleanup", cleanupSkippedReason: "allowed dirty files are present" });
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
      safety_refs: [...(session.safety_refs ?? []), safetyRef],
      deleted_worktree_path: currentWorktree,
      deleted_branch: branch,
    }, { event: { type: "guardian_finish", session_id: sessionId, ref: safetyRef } });
    return withFinishReport({ ok: true, status: "finished", mode, branch, commit, safetyRef, cleaned: true }, preflight, { action: "merged-and-cleaned" });
  }

  return blocked(`unsupported finish mode: ${mode}`, { safetyRef }, preflight);
}
