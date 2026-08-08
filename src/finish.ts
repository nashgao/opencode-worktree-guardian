import path from "node:path";
import { loadConfig, normalizeConfig } from "./config.ts";
import { classifyDirtyFiles } from "./finish-dirty-files.ts";
import { finishMergeToBase } from "./finish-merge-to-base.ts";
import { observeFreshFinishBaseLineage, recordFinishBaseLineage } from "./finish-base-lineage.ts";
import { blocked, errorMessage, isFinishStateInput, withFinishReport } from "./finish-report.ts";
import type { FinishPreflight, GuardianFinishResult, LooseRecord } from "./finish-report.ts";
import { buildSafetyRef, createOrReuseSafetyRef, createSafetyRef, getCurrentBranch, getDirtyFiles, getHeadCommit, getRepoRoot, listStashes, pushBranchNormally } from "./git.ts";
import { configuredRemoteAuthority, isTrustedRemoteNamespaceOverlapError } from "./git-authority.ts";
import { isActiveSession, isTerminalSession } from "./lifecycle.ts";
import { hasBlockingStashInventory } from "./stash-policy.ts";
import { getGuardianPaths, readState, recordSession } from "./state.ts";
import { ineligibleSessionProvenance } from "./session-provenance.ts";
import type { GuardianSession } from "./types.ts";
import { isRecordLike } from "./types.ts";
import { recoverableGuardianWorktreeBlocker, recoverySessionId } from "./worktree-recovery.ts";
import { samePathOnDisk } from "./done-shared.ts";

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
    baseAuthorityRef: null,
    baseRefOid: null,
    baseIsAncestorOfHead: null,
    headIsAncestorOfBase: null,
    mode,
    blockers: [],
  };
  if (mode === "merge-to-base") {
    try {
      configuredRemoteAuthority(config);
    } catch (error) {
      if (!isTrustedRemoteNamespaceOverlapError(error)) throw error;
      return blocked("configured remote authority is invalid", { error: errorMessage(error) }, preflight);
    }
  }
  if (mode === "merge-to-base" && input.allowMergeToBase !== true) {
    return blocked("merge-to-base requires explicit allowMergeToBase=true", input.mode === "plan" ? {} : { safetyRef: null }, preflight, { action: "requires-explicit-merge-approval" });
  }
  const paths = await getGuardianPaths(repoRoot);
  const state = isFinishStateInput(input.state) ? input.state : await readState(paths, { repoRoot, config });
  const currentWorktree = await getRepoRoot(cwd);
  preflight.currentWorktree = currentWorktree;
  const planMode = input.mode === "plan";
  let plannedRecoveredSession = false;
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
    sessionId = terminalSession ? recoverySessionId(currentBranch, headCommit) : sessionId ?? recoverySessionId(currentBranch, headCommit);
    const recoveredSession: GuardianSession = {
      session_id: sessionId,
      status: "active",
      branch: currentBranch,
      worktree_path: currentWorktree,
      base_ref: `${config.remote}/${config.baseBranch}`,
      head_commit: headCommit,
      safety_refs: [],
      ...ineligibleSessionProvenance(config),
    };
    if (planMode) {
      session = recoveredSession;
      plannedRecoveredSession = true;
    } else {
      const recoveredState = await recordSession(repoRoot, config, recoveredSession, { event: { type: "guardian_finish_recover", session_id: sessionId } });
      session = recoveredState.sessions[sessionId];
    }
    preflight.sessionRecovered = true;
  }
  preflight.sessionRecorded = Boolean(session) && !plannedRecoveredSession;
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

  preflight.sessionOwnedWorktree = await samePathOnDisk(session.worktree_path, currentWorktree);
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
  preflight.stashes = stashes;
  if (hasBlockingStashInventory(config, stashes)) {
    return blocked("stash inventory is non-empty", {
      stashes,
      suggestedCommands: ["git stash list", "git stash show -p stash@{0}"],
    }, preflight, { action: "inspect-stashes", suggestedCommands: ["git stash list", "git stash show -p stash@{0}"] });
  }

  const commit = await getHeadCommit(currentWorktree);
  preflight.commit = commit;
  const requiresBaseFreshness = mode === "push-branch" || mode === "create-pr" || mode === "merge-to-base";
  if (requiresBaseFreshness) {
    try {
      const baseLineage = await observeFreshFinishBaseLineage(repoRoot, config, commit);
      recordFinishBaseLineage(preflight, baseLineage);
      if (!baseLineage.baseIsAncestorOfHead) {
        return blocked("fresh remote base is not an ancestor of the session commit", { commit, baseRefOid: baseLineage.baseRefOid, baseAuthorityRef: baseLineage.baseAuthorityRef }, preflight);
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return blocked("remote base ref could not be fetched or resolved", { commit, error: errorMessage(error) }, preflight);
    }
  }
  const existingSafetyRefs = Array.isArray(session.safety_refs) ? session.safety_refs.filter((ref: unknown) => typeof ref === "string") : [];
  const existingSafetyRef = existingSafetyRefs[existingSafetyRefs.length - 1];
  const plannedSafetyRef = buildSafetyRef(sessionId, branch, input.timestamp);
  if (planMode) {
    if (mode === "merge-to-base" && input.allowMergeToBase !== true) {
      return blocked("merge-to-base requires explicit allowMergeToBase=true", { branch }, preflight, { action: "requires-explicit-merge-approval" });
    }
    return withFinishReport({ ok: true, status: "planned", mode, branch, worktree: currentWorktree, commit, nextAction: `guardian_done mode=apply confirm=true finishMode=${mode}` }, preflight, { action: "planned" });
  }
  if (mode === "preserve-only" && session.status === "preserved" && existingSafetyRef) {
    preflight.safetyRef = existingSafetyRef;
    return withFinishReport({ ok: true, status: "preserved", mode, branch, worktree: currentWorktree, commit, safetyRef: existingSafetyRef, idempotent: true }, preflight, { action: "already-preserved" });
  }
  let safetyRef: string;
  try {
    const createSafetyRefAtCommit = mode !== "preserve-only" && session.head_commit === commit && existingSafetyRefs.includes(plannedSafetyRef)
      ? createOrReuseSafetyRef
      : createSafetyRef;
    safetyRef = await createSafetyRefAtCommit(currentWorktree, { sessionId, branch, commit, ref: plannedSafetyRef });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return blocked("safety ref creation failed", { branch, error: errorMessage(error) }, preflight);
  }
  preflight.safetyRef = safetyRef;
  await recordSession(repoRoot, config, {
    ...session,
    session_id: sessionId,
    status: mode === "preserve-only" ? "preserved" : session.status,
    head_commit: commit,
    safety_refs: [...new Set([...(session.safety_refs ?? []), safetyRef])],
  }, { event: { type: "safety_ref_created", session_id: sessionId, ref: safetyRef } });

  if (mode === "preserve-only") {
    return withFinishReport({ ok: true, status: "preserved", mode, branch, worktree: currentWorktree, commit, safetyRef }, preflight, { action: "preserved" });
  }

  if (mode === "push-branch" || mode === "create-pr") {
    try {
      const baseLineage = await observeFreshFinishBaseLineage(repoRoot, config, commit);
      recordFinishBaseLineage(preflight, baseLineage);
      if (!baseLineage.baseIsAncestorOfHead) {
        return blocked("fresh remote base is not an ancestor of the session commit", { safetyRef, commit, baseRefOid: baseLineage.baseRefOid, baseAuthorityRef: baseLineage.baseAuthorityRef }, preflight);
      }
      await pushBranchNormally(currentWorktree, config.remote, branch, commit);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return blocked("push failed", { safetyRef, branch, error: errorMessage(error) }, preflight);
    }
    await recordSession(repoRoot, config, {
      ...session,
      session_id: sessionId,
      status: "preserved",
      head_commit: commit,
      safety_refs: [...new Set([...(session.safety_refs ?? []), safetyRef])],
    }, { event: { type: "guardian_finish", session_id: sessionId, ref: safetyRef } });
    const result: LooseRecord = { ok: true, status: mode === "push-branch" ? "pushed" : "pr-suggested", mode, branch, safetyRef };
    if (mode === "create-pr") {
      result.suggestedCommand = `gh pr create --base ${config.baseBranch} --head ${branch}`;
      result.note = "No native GitHub integration is wired; branch was pushed and a PR command is suggested.";
    }
    return withFinishReport(result, preflight, { action: mode === "push-branch" ? "pushed" : "pushed-and-suggested-pr" });
  }

  if (mode === "merge-to-base") {
    return finishMergeToBase({ input, repoRoot, config, session, sessionId, branch, commit, currentWorktree, safetyRef, preflight, mode });
  }

  return blocked(`unsupported finish mode: ${mode}`, { safetyRef }, preflight);
}
