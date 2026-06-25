import crypto from "node:crypto";
import path from "node:path";
import { loadConfig, normalizeConfig } from "./config.ts";
import { fetchRemote, getDirtyFiles, getHeadCommit, getRefCommit, getRepoRoot } from "./git.ts";
import { getGuardianPaths, readState } from "./state.ts";
import { guardianDoneLandClean } from "./done-land-clean.ts";
import { runCleanupSweep } from "./done-cleanup-sweep.ts";
import { activeFeatureSessions, type FeatureSession } from "./done-feature-sessions.ts";
import { syncLocalBase } from "./done-main-sync.ts";
import { isRecordLike } from "./types.ts";
import type { GuardianConfig } from "./types.ts";

// Bounds one batch finish so a runaway state file cannot fan out into an unbounded sequence
// of pushes, PR merges, and worktree deletions. Mirrors MAX_WORKFLOW_CLEANUP_CANDIDATES.
export const MAX_DONE_ALL_SESSIONS = 25;

type Disposition = "finishable" | "dirty-skipped" | "blocked";

type SessionPlan = {
  readonly session_id: string;
  readonly branch: string | null;
  readonly worktree_path: string;
  readonly head: string | null;
  readonly dirtyFileCount: number;
  readonly disposition: Disposition;
  readonly reason?: string;
};

function createDoneAllToken(material: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

// The confirm token binds everything an apply must not have drifted on between plan and apply:
// the resolved base commit, the policy that classified each session, and every session's identity,
// live head, and dirty fingerprint. Any of these changing (session added/removed, base moved, a
// finishable head advanced, a clean worktree went dirty) recomputes a different token and fails closed.
function tokenMaterial(repoRoot: string, config: GuardianConfig, baseRef: string, baseRefOid: string | null, protectedBranches: readonly string[], plans: readonly SessionPlan[]): Record<string, unknown> {
  return {
    operation: "guardian_done_all/v1",
    repoRoot: path.resolve(repoRoot),
    remote: config.remote,
    baseBranch: config.baseBranch,
    baseRef,
    baseRefOid,
    protectedBranches: [...protectedBranches].sort(),
    sessions: plans.map((plan) => ({
      session_id: plan.session_id,
      branch: plan.branch,
      worktree_path: path.resolve(plan.worktree_path),
      head: plan.head,
      dirtyFileCount: plan.dirtyFileCount,
      disposition: plan.disposition,
    })),
  };
}

// Clean-only v1 contract: protected branches and no-branch sessions are hard-blocked, dirty
// sessions are skipped (a single shared commit message across N sessions would be unsafe), and
// only clean, branch-owning sessions are finishable. The live head and dirty count feed the token.
async function classifySession(session: FeatureSession, protectedBranches: readonly string[]): Promise<SessionPlan> {
  const head = await getHeadCommit(session.worktree_path).catch(() => session.head);
  const dirty = await getDirtyFiles(session.worktree_path).catch(() => [] as string[]);
  const base = { session_id: session.session_id, branch: session.branch, worktree_path: session.worktree_path, head, dirtyFileCount: dirty.length };
  if (!session.branch) return { ...base, disposition: "blocked", reason: "session has no branch to land" };
  if (protectedBranches.includes(session.branch)) return { ...base, disposition: "blocked", reason: `session branch ${session.branch} is protected` };
  if (dirty.length > 0) return { ...base, disposition: "dirty-skipped", reason: `worktree has uncommitted changes; finish it individually with guardian_done branch=${session.branch} commitMessage=...` };
  return { ...base, disposition: "finishable" };
}

// Repo-wide implementation-done batch: finish every active Guardian feature session
// (commit-free land -> push -> PR -> merge -> prove -> remove worktree+branch) in one gated pass.
// This is an orchestrator over guardianDoneLandClean, not a reimplementation: it enumerates,
// classifies, token-gates, then drives the existing per-session finish sequentially with
// per-session failure isolation so one stuck PR cannot abort the rest.
export async function guardianDoneAll(input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const config = isRecordLike(input.config) ? normalizeConfig(input.config) : (await loadConfig(repoRoot)).config;
  const mode = input.mode ?? "plan";
  if (mode !== "plan" && mode !== "apply") return { ok: false, status: "blocked", lane: "done-all", reason: "mode must be plan or apply", mode };

  const protectedBranches = Array.isArray(config.protectedBranches) ? config.protectedBranches.filter((branch): branch is string => typeof branch === "string") : [];
  const baseRef = `${String(config.remote)}/${String(config.baseBranch)}`;
  const state = await readState(await getGuardianPaths(repoRoot), { repoRoot, config });
  const sessions = await activeFeatureSessions(state, repoRoot, config);

  if (sessions.length === 0) {
    return { ok: true, status: "no-op", lane: "done-all", reason: "no active Guardian feature sessions to finish", summary: { total: 0, finishable: 0, dirtySkipped: 0, blocked: 0 }, sessions: [] };
  }

  let baseRefOid: string | null = null;
  let baseRefFetched = false;
  try {
    await fetchRemote(repoRoot, String(config.remote));
    baseRefFetched = true;
    baseRefOid = await getRefCommit(repoRoot, baseRef);
  } catch (error) {
    return { ok: false, status: "blocked", lane: "done-all", reason: "remote base ref could not be fetched or resolved", baseRef, error: error instanceof Error ? error.message : String(error) };
  }

  const plans: SessionPlan[] = [];
  for (const session of sessions) plans.push(await classifySession(session, protectedBranches));
  plans.sort((left, right) => left.session_id.localeCompare(right.session_id));

  const finishable = plans.filter((plan) => plan.disposition === "finishable");
  const dirtySkipped = plans.filter((plan) => plan.disposition === "dirty-skipped");
  const blockedSessions = plans.filter((plan) => plan.disposition === "blocked");
  const remaining = [...dirtySkipped, ...blockedSessions];
  const summary = { total: plans.length, finishable: finishable.length, dirtySkipped: dirtySkipped.length, blocked: blockedSessions.length };

  if (finishable.length > MAX_DONE_ALL_SESSIONS) {
    return { ok: false, status: "blocked", lane: "done-all", reason: `finishable session count ${finishable.length} exceeds maximum ${MAX_DONE_ALL_SESSIONS}`, summary, sessions: plans };
  }

  const confirmToken = createDoneAllToken(tokenMaterial(repoRoot, config, baseRef, baseRefOid, protectedBranches, plans));

  if (mode === "plan") {
    return {
      ok: true,
      status: "planned",
      lane: "done-all",
      confirmToken,
      baseRef,
      baseRefOid,
      baseRefFetched,
      summary,
      sessions: plans,
      remaining,
      nextAction: input.all === true ? "guardian_done all=true mode=apply confirm=true" : "guardian_done mode=apply confirm=true",
    };
  }

  if (input.confirm !== true) {
    return { ok: false, status: "blocked", lane: "done-all", reason: "guardian_done apply requires confirm=true before finishing every active session", summary, confirmToken, nextAction: input.all === true ? "guardian_done all=true mode=apply confirm=true" : "guardian_done mode=apply confirm=true" };
  }
  if (input.confirmToken !== confirmToken) {
    const planCommand = input.all === true ? "guardian_done all=true mode=plan" : "guardian_done mode=plan";
    return { ok: false, status: "blocked", lane: "done-all", reason: `confirm token mismatch; the active session set, base ref, or a worktree changed since plan. Re-run ${planCommand} and use the returned confirmToken`, summary };
  }

  const results: Record<string, unknown>[] = [];
  for (const plan of finishable) {
    const session = state.sessions?.[plan.session_id];
    if (!isRecordLike(session)) {
      results.push({ session_id: plan.session_id, branch: plan.branch, ok: false, status: "blocked", reason: "session record disappeared before finish" });
      continue;
    }
    try {
      const finish = await guardianDoneLandClean({
        input: { ...input, mode: "apply", confirm: true, skipPostFinishMaintenance: true },
        repoRoot,
        cwd: plan.worktree_path,
        sessionId: plan.session_id,
        session,
        config,
      });
      results.push({
        session_id: plan.session_id,
        branch: plan.branch,
        ok: finish.ok === true,
        status: finish.status,
        reason: finish.reason,
        head: finish.head,
        pr: finish.pr,
        worktreeRemoved: finish.worktreeRemoved === true,
        branchDeleted: finish.branchDeleted === true,
        safetyRef: finish.commitSafetyRef ?? (isRecordLike(finish.cleanup) ? finish.cleanup.safetyRef : undefined),
      });
    } catch (error) {
      results.push({ session_id: plan.session_id, branch: plan.branch, ok: false, status: "error", reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const finishedCount = results.filter((result) => result.ok === true).length;
  const failedCount = results.length - finishedCount;
  const hardFailure = failedCount > 0;
  const mainSync = await syncLocalBase(repoRoot, config);
  const cleanupSweep = await runCleanupSweep(repoRoot, config, input);
  const sweepFailure = cleanupSweep.ok === false;
  return {
    ok: !hardFailure && !sweepFailure,
    status: !hardFailure && !sweepFailure && remaining.length === 0 ? "finished" : "partial",
    lane: "done-all",
    summary: { ...summary, finished: finishedCount, failed: failedCount },
    results,
    remaining,
    mainSync,
    cleanupSweep,
    ...(remaining.length > 0 ? { remainingHint: "dirty or protected sessions were skipped; finish them individually with guardian_done branch=<branch> commitMessage=..." } : {}),
  };
}
