import { loadConfig, normalizeConfig } from "./config.ts";
import { guardianFinish } from "./finish.ts";
import { getCurrentBranch, getHeadCommit, getRepoRoot } from "./git.ts";
import { isActiveSession } from "./lifecycle.ts";
import { getGuardianPaths, readState } from "./state.ts";
import { isRecordLike } from "./types.ts";
import type { GuardianConfig, GuardianSession } from "./types.ts";
import { reattachCurrentGuardianWorktree } from "./done-reattach.ts";
import { guardianDoneLandClean } from "./done-land-clean.ts";
import { primaryMainDone } from "./done-primary-publish.ts";
import { dirtySnapshot } from "./done-primary-snapshot.ts";
import { blocked, samePath } from "./done-shared.ts";
import { guardianFinishWorkflow } from "./workflow.ts";
import { rescueDirtyWorktree } from "./done-rescue.ts";
import { activeFeatureSessions, featureSessionCommands, type FeatureSession } from "./done-feature-sessions.ts";
import { guardianDoneAll } from "./done-all.ts";

function activeSessionIdForWorktree(state: Awaited<ReturnType<typeof readState>>, currentWorktree: string) {
  for (const [sessionId, session] of Object.entries(state.sessions ?? {})) {
    if (isRecordLike(session) && isActiveSession(session) && typeof session.worktree_path === "string" && samePath(session.worktree_path, currentWorktree)) return sessionId;
  }
  return null;
}

function activeSessionIdForBranch(state: Awaited<ReturnType<typeof readState>>, branch: string) {
  for (const [sessionId, session] of Object.entries(state.sessions ?? {})) {
    if (isRecordLike(session) && isActiveSession(session) && session.branch === branch) return sessionId;
  }
  return null;
}

function selectSession(reason: string, sessions: readonly FeatureSession[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: false,
    status: "needs-selection",
    lane: "select-session",
    reason,
    availableSessions: sessions,
    suggestedCommands: featureSessionCommands(sessions),
    ...extra,
  };
}

function useDirectFinishMode(input: Record<string, unknown>) {
  return typeof input.finishMode === "string" && input.finishMode !== "create-pr";
}

function preservedSessionForWorktree(
  state: Awaited<ReturnType<typeof readState>>,
  currentWorktree: string,
  requestedSessionId: string | null,
): { readonly sessionId: string; readonly session: GuardianSession } | null {
  if (requestedSessionId) {
    const session = state.sessions?.[requestedSessionId];
    if (isRecordLike(session) && session.status === "preserved") return { sessionId: requestedSessionId, session };
    return null;
  }
  for (const [sessionId, session] of Object.entries(state.sessions ?? {})) {
    if (isRecordLike(session) && session.status === "preserved" && typeof session.worktree_path === "string" && samePath(session.worktree_path, currentWorktree)) {
      return { sessionId, session };
    }
  }
  return null;
}

async function preservedDoneNoOp(
  currentWorktree: string,
  config: GuardianConfig,
  sessionId: string,
  session: GuardianSession,
): Promise<Record<string, unknown>> {
  const branch = typeof session.branch === "string" ? session.branch : null;
  const commit = typeof session.head_commit === "string" ? session.head_commit : null;
  const safetyRefs = Array.isArray(session.safety_refs) ? session.safety_refs.filter((ref): ref is string => typeof ref === "string") : [];
  const safetyRef = safetyRefs[safetyRefs.length - 1] ?? null;
  let localUntrackedFileCount = 0;
  let localDirtyFileCount = 0;
  try {
    const snapshot = await dirtySnapshot(currentWorktree, config);
    localDirtyFileCount = snapshot.paths.length;
    localUntrackedFileCount = snapshot.entries.filter((entry) => entry.status === "??").length;
  } catch {
    localUntrackedFileCount = 0;
  }
  return {
    ok: true,
    status: "no-op",
    lane: "already-preserved",
    message: "session already preserved",
    sessionId,
    sessionStatus: session.status,
    branch,
    commit,
    safetyRef,
    safetyRefs,
    localUntrackedFileCount,
    localDirtyFileCount,
    session,
  };
}

export async function guardianDone(input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const config = isRecordLike(input.config) ? normalizeConfig(input.config) : (await loadConfig(repoRoot)).config;
  const mode = input.mode ?? "plan";
  if (mode !== "plan" && mode !== "apply") return { ok: false, status: "blocked", reason: "mode must be plan or apply", mode };

  if (input.all === true) return guardianDoneAll({ ...input, repoRoot, config });

  const currentWorktree = await getRepoRoot(cwd);
  if (input.rescue === true) {
    return rescueDirtyWorktree(currentWorktree, config, input);
  }
  const currentBranch = await getCurrentBranch(currentWorktree);
  const baseBranch = String(config.baseBranch);
  const protectedBranches = Array.isArray(config.protectedBranches) ? config.protectedBranches : [];
  const state = await readState(await getGuardianPaths(repoRoot), { repoRoot, config });
  const requestedSessionId = typeof input.sessionId === "string" && input.sessionId.trim().length > 0 ? input.sessionId : null;
  const requestedBranch = typeof input.branch === "string" && input.branch.trim().length > 0 ? input.branch.trim() : null;
  const branchSessionId = requestedBranch && !requestedSessionId ? activeSessionIdForBranch(state, requestedBranch) : null;
  if (requestedBranch && !requestedSessionId && !branchSessionId) {
    const candidates = await activeFeatureSessions(state, repoRoot, config);
    return {
      ok: false,
      status: "blocked",
      lane: "branch-not-found",
      reason: `no active Guardian session owns branch ${requestedBranch}`,
      branch: requestedBranch,
      availableSessions: candidates,
      suggestedCommands: featureSessionCommands(candidates),
    };
  }
  const sessionId = requestedSessionId ?? branchSessionId ?? activeSessionIdForWorktree(state, currentWorktree);
  const currentSession = sessionId ? state.sessions?.[sessionId] : null;

  if (currentSession && isActiveSession(currentSession) && typeof currentSession.worktree_path === "string") {
    if (!sessionId) return blocked("active Guardian session could not be matched to a session id", { lane: "session-finish" });
    if (!samePath(currentWorktree, currentSession.worktree_path)) {
      const snapshot = samePath(currentWorktree, repoRoot) ? await dirtySnapshot(repoRoot, config) : { paths: [] };
      if (snapshot.paths.length > 0) {
        if (currentBranch === baseBranch && protectedBranches.includes(baseBranch)) {
          return primaryMainDone(repoRoot, currentWorktree, config, input);
        }
        return blocked("changes were made outside the active Guardian lane; consolidate them before finishing", {
          lane: "wrong-lane-dirty-work",
          dirtyFiles: snapshot.paths,
          nextAction: "Finish the lane directly with branch=<lane-branch>, or rerun with rescue=true to back up and clear these out-of-lane changes.",
          suggestedCommands: ["guardian_done rescue=true", "guardian_status"],
        });
      }
      if (useDirectFinishMode(input)) {
        const finish = await guardianFinish({ ...input, repoRoot, cwd: currentSession.worktree_path, sessionId, config });
        return { ...finish, lane: "session-finish" };
      }
      const result = await guardianDoneLandClean({ input: { ...input, mode }, repoRoot, cwd: currentSession.worktree_path, sessionId, session: currentSession, config });
      return { ...result, lane: "session-finish" };
    }
    if (useDirectFinishMode(input)) {
      const finish = await guardianFinish({ ...input, repoRoot, cwd: currentWorktree, sessionId, config });
      return { ...finish, lane: "session-finish" };
    }
    const result = await guardianDoneLandClean({ input: { ...input, mode }, repoRoot, cwd: currentWorktree, sessionId, session: currentSession, config });
    return { ...result, lane: "session-finish" };
  }

  const preserved = preservedSessionForWorktree(state, currentWorktree, requestedSessionId);
  if (preserved) {
    const preservedHead = typeof preserved.session.head_commit === "string" ? preserved.session.head_commit : null;
    const currentHead = await getHeadCommit(currentWorktree).catch(() => null);
    if (preservedHead && currentHead === preservedHead) {
      return preservedDoneNoOp(currentWorktree, config, preserved.sessionId, preserved.session);
    }
  }

  if (!samePath(currentWorktree, repoRoot)) {
    return reattachCurrentGuardianWorktree(repoRoot, currentWorktree, currentBranch, config, currentSession ? null : requestedSessionId, input);
  }

  if (samePath(currentWorktree, repoRoot) && currentBranch === baseBranch && protectedBranches.includes(baseBranch)) {
    const snapshot = await dirtySnapshot(repoRoot, config);
    if (snapshot.paths.length > 0) return primaryMainDone(repoRoot, currentWorktree, config, input);
    if (!requestedSessionId && !requestedBranch) {
      const candidates = await activeFeatureSessions(state, repoRoot, config);
      if (candidates.length > 0) {
        return selectSession("no Guardian session matches the current location; choose a feature session to finish, or run guardian_finish_workflow to sweep merged worktrees", candidates, { currentWorktree, currentBranch, baseBranch });
      }
    }
    const cleanup = await guardianFinishWorkflow({ ...input, repoRoot, cwd: repoRoot, config });
    return { ...cleanup, lane: "cleanup-only" };
  }

  if (samePath(currentWorktree, repoRoot) && currentBranch && protectedBranches.includes(currentBranch)) {
    return {
      ok: false,
      status: "blocked",
      lane: "primary-rescue-recommended",
      reason: "dirty protected primary work is not on the configured base branch; rescue it to a Guardian worktree before finishing",
      currentBranch,
      baseBranch,
      suggestedCommands: ["guardian_start createWorktree=true", "guardian_status"],
    };
  }

  if (!requestedSessionId && !requestedBranch) {
    const candidates = await activeFeatureSessions(state, repoRoot, config);
    if (candidates.length > 0) {
      return selectSession("no Guardian session matches the current location; choose a feature session to finish", candidates, { currentWorktree, currentBranch, baseBranch });
    }
  }

  return {
    ok: false,
    status: "blocked",
    lane: "blocked",
    reason: "guardian_done could not choose a safe finish lane; use guardian_status for evidence or guardian_finish from an owned session worktree",
    currentWorktree,
    currentBranch,
    baseBranch,
  };
}
