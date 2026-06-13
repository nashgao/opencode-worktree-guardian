import { loadConfig, normalizeConfig } from "./config.ts";
import { guardianFinish } from "./finish.ts";
import { getCurrentBranch, getRepoRoot } from "./git.ts";
import { isActiveSession } from "./lifecycle.ts";
import { getGuardianPaths, readState } from "./state.ts";
import { isRecordLike } from "./types.ts";
import { reattachCurrentGuardianWorktree } from "./done-reattach.ts";
import { primaryMainDone } from "./done-primary-publish.ts";
import { dirtySnapshot } from "./done-primary-snapshot.ts";
import { blocked, samePath } from "./done-shared.ts";
import { guardianFinishWorkflow } from "./workflow.ts";

function activeSessionIdForWorktree(state: Awaited<ReturnType<typeof readState>>, currentWorktree: string) {
  for (const [sessionId, session] of Object.entries(state.sessions ?? {})) {
    if (isRecordLike(session) && isActiveSession(session) && typeof session.worktree_path === "string" && samePath(session.worktree_path, currentWorktree)) return sessionId;
  }
  return null;
}

export async function guardianDone(input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const config = isRecordLike(input.config) ? normalizeConfig(input.config) : (await loadConfig(repoRoot)).config;
  const mode = input.mode ?? "plan";
  if (mode !== "plan" && mode !== "apply") return { ok: false, status: "blocked", reason: "mode must be plan or apply", mode };

  const currentWorktree = await getRepoRoot(cwd);
  const currentBranch = await getCurrentBranch(currentWorktree);
  const baseBranch = String(config.baseBranch);
  const protectedBranches = Array.isArray(config.protectedBranches) ? config.protectedBranches : [];
  const state = await readState(await getGuardianPaths(repoRoot), { repoRoot, config });
  const requestedSessionId = typeof input.sessionId === "string" && input.sessionId.trim().length > 0 ? input.sessionId : null;
  const sessionId = requestedSessionId ?? activeSessionIdForWorktree(state, currentWorktree);
  const currentSession = sessionId ? state.sessions?.[sessionId] : null;

  if (currentSession && isActiveSession(currentSession) && typeof currentSession.worktree_path === "string") {
    if (!samePath(currentWorktree, currentSession.worktree_path)) {
      const snapshot = samePath(currentWorktree, repoRoot) ? await dirtySnapshot(repoRoot, config) : { paths: [] };
      if (snapshot.paths.length > 0) {
        if (currentBranch === baseBranch && protectedBranches.includes(baseBranch)) {
          return primaryMainDone(repoRoot, currentWorktree, config, input);
        }
        return blocked("changes were made outside the active Guardian lane; consolidate them before finishing", {
          lane: "wrong-lane-dirty-work",
          dirtyFiles: snapshot.paths,
          nextAction: "Review the dirty files, then rerun guardian_done after they are moved into the active lane.",
        });
      }
      const result = await guardianFinish({ ...input, repoRoot, cwd: currentSession.worktree_path, sessionId, config });
      return { ...result, lane: "session-finish" };
    }
    const result = await guardianFinish({ ...input, repoRoot, cwd: currentWorktree, sessionId, config });
    return { ...result, lane: "session-finish" };
  }

  if (!samePath(currentWorktree, repoRoot)) {
    return reattachCurrentGuardianWorktree(repoRoot, currentWorktree, currentBranch, config, currentSession ? null : requestedSessionId, input);
  }

  if (samePath(currentWorktree, repoRoot) && currentBranch === baseBranch && protectedBranches.includes(baseBranch)) {
    const snapshot = await dirtySnapshot(repoRoot, config);
    if (snapshot.paths.length > 0) return primaryMainDone(repoRoot, currentWorktree, config, input);
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
