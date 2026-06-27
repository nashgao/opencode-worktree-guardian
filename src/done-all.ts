import crypto from "node:crypto";
import path from "node:path";
import { loadConfig, normalizeConfig } from "./config.ts";
import { fetchRemote, getDirtyFiles, getHeadCommit, getRefCommit, getRepoRoot } from "./git.ts";
import { getGuardianPaths, readState } from "./state.ts";
import { guardianDoneLandClean } from "./done-land-clean.ts";
import { guardianFinishWorkflow } from "./workflow.ts";
import { candidateTokenMaterial } from "./workflow-candidates.ts";
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
function cleanupPlanTokenMaterial(cleanupPlan: Record<string, unknown>): Record<string, unknown> {
  const candidates = Array.isArray(cleanupPlan.candidates) ? cleanupPlan.candidates.filter((candidate): candidate is Record<string, unknown> => isRecordLike(candidate)) : [];
  const blockers = Array.isArray(cleanupPlan.blockers) ? cleanupPlan.blockers.filter((blocker): blocker is Record<string, unknown> => isRecordLike(blocker)) : [];
  return {
    ok: cleanupPlan.ok === true,
    status: typeof cleanupPlan.status === "string" ? cleanupPlan.status : null,
    confirmToken: typeof cleanupPlan.confirmToken === "string" ? cleanupPlan.confirmToken : null,
    candidates: candidates.map(candidateTokenMaterial),
    blockers: blockers.map((blocker) => ({
      kind: blocker.kind ?? null,
      targetPath: blocker.targetPath ?? null,
      branch: blocker.branch ?? null,
      head: blocker.head ?? null,
      targetKind: blocker.targetKind ?? null,
      remote: blocker.remote ?? null,
      remoteBranch: blocker.remoteBranch ?? null,
      reason: blocker.reason ?? null,
    })),
  };
}

function tokenMaterial(repoRoot: string, config: GuardianConfig, baseRef: string, baseRefOid: string | null, protectedBranches: readonly string[], plans: readonly SessionPlan[], cleanupPlan: Record<string, unknown>): Record<string, unknown> {
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
    cleanupPlan: cleanupPlanTokenMaterial(cleanupPlan),
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

  const cleanupExcludeBranches = plans.map((plan) => plan.branch).filter((branch): branch is string => typeof branch === "string" && branch.length > 0);
  const cleanupPlan = await guardianFinishWorkflow({ repoRoot, cwd: repoRoot, mode: "plan", config, excludeBranches: cleanupExcludeBranches });
  const cleanupCandidates = Array.isArray(cleanupPlan.candidates) ? cleanupPlan.candidates.length : 0;
  const cleanupBlockerRecords = Array.isArray(cleanupPlan.blockers) ? cleanupPlan.blockers.filter((blocker): blocker is Record<string, unknown> => isRecordLike(blocker)) : [];
  const cleanupBlockers = cleanupBlockerRecords.length;
  const cleanupHasApplyToken = typeof cleanupPlan.confirmToken === "string";
  const cleanupPreflight = isRecordLike(cleanupPlan.preflight) ? cleanupPlan.preflight : {};
  const cleanupPreflightBlockers = Array.isArray(cleanupPreflight.blockers) ? cleanupPreflight.blockers.filter((blocker): blocker is string => typeof blocker === "string") : [];
  const cleanupScanCompleted = cleanupPreflight.candidateScanStatus === "completed";
  const cleanupHasCandidateBound = cleanupBlockerRecords.some((blocker) => blocker.kind === "candidate-bound");
  const cleanupHasSafeWork = finishable.length > 0 || cleanupCandidates > 0 && cleanupHasApplyToken;
  const cleanupHardBlocked = cleanupCandidates > 0 && !cleanupHasApplyToken
    || cleanupHasCandidateBound
    || cleanupPreflightBlockers.length > 0
    || cleanupPlan.ok !== true && (!cleanupScanCompleted || !cleanupHasSafeWork);
  if (cleanupHardBlocked) {
    return {
      ok: false,
      status: "blocked",
      lane: "done-all",
      reason: cleanupCandidates > 0 && !cleanupHasApplyToken ? "cleanup plan has candidates but no apply token" : "cleanup plan has blockers; resolve them and re-plan before finishing all sessions",
      baseRef,
      baseRefOid,
      baseRefFetched,
      summary,
      sessions: plans,
      remaining,
      cleanupPlan,
      cleanupSummary: { candidates: cleanupCandidates, blockers: cleanupBlockers },
    };
  }
  const confirmToken = createDoneAllToken(tokenMaterial(repoRoot, config, baseRef, baseRefOid, protectedBranches, plans, cleanupPlan));

  if (mode === "plan") {
    const noSessionWork = plans.length === 0;
    const noCleanupWork = cleanupCandidates === 0 && cleanupBlockers === 0 && cleanupPlan.ok === true;
    const willRemainPartial = remaining.length > 0 || cleanupBlockers > 0 || cleanupPlan.ok !== true;
    return {
      ok: true,
      status: noSessionWork && noCleanupWork ? "no-op" : willRemainPartial ? "planned-partial" : "planned",
      lane: "done-all",
      confirmToken,
      baseRef,
      baseRefOid,
      baseRefFetched,
      summary,
      sessions: plans,
      remaining,
      cleanupPlan,
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

  const cleanupApply = cleanupCandidates > 0 && cleanupHasApplyToken
    ? await guardianFinishWorkflow({ ...input, repoRoot, cwd: repoRoot, mode: "apply", confirmToken: cleanupPlan.confirmToken, config, excludeBranches: cleanupExcludeBranches })
    : null;
  const cleanupApplyResults = cleanupApply && Array.isArray(cleanupApply.results) ? cleanupApply.results : [];
  const cleanupSweep = cleanupApply
    ? {
      ok: cleanupApply.ok === true,
      status: cleanupApply.status === "cleaned" ? "cleaned" : "partial",
      reason: cleanupApply.ok === true ? undefined : "cleanup sweep applied safe candidates with remaining blockers",
      candidateCount: cleanupCandidates,
      cleanedCount: cleanupApplyResults.filter((result) => isRecordLike(result) && result.ok === true).length,
      failedCount: cleanupApplyResults.filter((result) => !isRecordLike(result) || result.ok !== true).length,
      plan: cleanupPlan,
      apply: cleanupApply,
      remaining: cleanupApply.remaining ?? cleanupApply.blockers ?? [],
    }
    : cleanupCandidates > 0
      ? { ok: false, status: "blocked", reason: "cleanup plan has candidates but no apply token", candidateCount: cleanupCandidates, plan: cleanupPlan }
      : cleanupBlockers > 0 || cleanupPlan.ok !== true
        ? { ok: false, status: "partial", reason: "cleanup blockers remain", candidateCount: 0, plan: cleanupPlan, remaining: cleanupPlan.blockers ?? [] }
        : { ok: true, status: "no-op", candidateCount: 0, plan: cleanupPlan };

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
  const cleanupRemaining = isRecordLike(cleanupSweep) && Array.isArray(cleanupSweep.remaining) ? cleanupSweep.remaining.filter((entry): entry is Record<string, unknown> => isRecordLike(entry)) : [];
  const allRemaining = [...remaining, ...cleanupRemaining];
  const repoFinished = !hardFailure && cleanupSweep.ok === true && allRemaining.length === 0;
  const mainSync = await syncLocalBase(repoRoot, config);
  return {
    ok: repoFinished,
    status: repoFinished ? "finished" : "partial",
    lane: "done-all",
    summary: { ...summary, finished: finishedCount, failed: failedCount },
    results,
    remaining: allRemaining,
    mainSync,
    cleanupSweep,
    ...(allRemaining.length > 0 ? { remainingHint: "safe work was applied; remaining entries need explicit cleanup or individual guardian_done handling before the repo is done" } : {}),
  };
}
