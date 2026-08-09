import { loadConfig, normalizeConfig } from "./config.ts";
import { fetchRemote, getDirtyFiles, getHeadCommit, getRefCommit, getRepoRoot } from "./git.ts";
import { configuredRemoteAuthority } from "./git-authority.ts";
import { getGuardianPaths, readState } from "./state.ts";
import { guardianDoneLandClean } from "./done-land-clean.ts";
import { combineCleanupSweeps, createDoneAllConfirmToken, observeBaseTransition, preSessionCleanupSweep } from "./done-all-cleanup.ts";
import { finalPostflightCommitsFromCleanupSweep, runCleanupSweep } from "./done-cleanup-sweep.ts";
import { guardianFinishWorkflow } from "./workflow.ts";
import { workflowApplyWorkCount } from "./workflow-candidates.ts";
import { activeFeatureSessions, type FeatureSession } from "./done-feature-sessions.ts";
import { syncLocalBase } from "./done-main-sync.ts";
import { runFinalCleanupPostflight } from "./final-postflight.ts";
import { isRecordLike } from "./types.ts";
import { batchChildFailureCanContinue } from "./done-land-clean-consent.ts";
import type { BatchLandAuthorization } from "./done-land-clean-consent.ts";

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
  readonly finishConfirmToken?: string;
};

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
  const mode = input.mode ?? "plan";
  if (mode !== "plan" && mode !== "apply") return { ok: false, status: "blocked", lane: "done-all", reason: "mode must be plan or apply", mode, remoteRefresh: "skipped" };
  if (mode === "apply" && input.confirm !== true) return { ok: false, status: "blocked", lane: "done-all", reason: "guardian_done apply requires confirm=true before remote refresh or planning", confirmationRequired: true, tokenChecked: false, remoteRefresh: "skipped", nextAction: input.all === true ? "guardian_done all=true mode=apply confirm=true" : "guardian_done mode=apply confirm=true" };
  const { timestamp: _timestamp, ...nestedInput } = input;
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const config = isRecordLike(input.config) ? normalizeConfig(input.config) : (await loadConfig(repoRoot)).config;

  const protectedBranches = Array.isArray(config.protectedBranches) ? config.protectedBranches.filter((branch): branch is string => typeof branch === "string") : [];
  const baseRef = `${String(config.remote)}/${String(config.baseBranch)}`;
  let baseAuthorityRef: string;
  try {
    baseAuthorityRef = configuredRemoteAuthority(config).authorityRef;
  } catch (error) {
    return { ok: false, status: "blocked", lane: "done-all", reason: "remote base ref is invalid", baseRef, error: error instanceof Error ? error.message : String(error) };
  }
  const state = await readState(await getGuardianPaths(repoRoot), { repoRoot, config });
  const sessions = await activeFeatureSessions(state, repoRoot, config);

  let baseRefOid: string | null = null;
  let baseRefFetched = false;
  try {
    await fetchRemote(repoRoot, String(config.remote));
    baseRefFetched = true;
    baseRefOid = await getRefCommit(repoRoot, baseAuthorityRef);
  } catch (error) {
    return { ok: false, status: "blocked", lane: "done-all", reason: "remote base ref could not be fetched or resolved", baseRef, error: error instanceof Error ? error.message : String(error) };
  }

  const plans: SessionPlan[] = [];
  for (const session of sessions) {
    const classified = await classifySession(session, protectedBranches);
    if (classified.disposition !== "finishable") {
      plans.push(classified);
      continue;
    }
    const recorded = state.sessions?.[classified.session_id];
    if (!isRecordLike(recorded)) {
      plans.push({ ...classified, disposition: "blocked", reason: "session record disappeared before finish planning" });
      continue;
    }
    const finishPlan = await guardianDoneLandClean({ input: { ...nestedInput, mode: "plan", skipPostFinishMaintenance: true }, repoRoot, cwd: classified.worktree_path, sessionId: classified.session_id, session: recorded, config });
    if (finishPlan.ok !== true || typeof finishPlan.confirmToken !== "string" || finishPlan.baseRefOid !== baseRefOid || finishPlan.branch !== classified.branch || finishPlan.worktreePath !== classified.worktree_path || finishPlan.head !== classified.head) {
      plans.push({ ...classified, disposition: "blocked", reason: typeof finishPlan.reason === "string" ? finishPlan.reason : "session finish could not be planned" });
      continue;
    }
    plans.push({ ...classified, finishConfirmToken: finishPlan.confirmToken });
  }
  plans.sort((left, right) => left.session_id < right.session_id ? -1 : left.session_id > right.session_id ? 1 : 0);

  const finishable = plans.filter((plan) => plan.disposition === "finishable");
  const dirtySkipped = plans.filter((plan) => plan.disposition === "dirty-skipped");
  const blockedSessions = plans.filter((plan) => plan.disposition === "blocked");
  const remaining = [...dirtySkipped, ...blockedSessions];
  const summary = { total: plans.length, finishable: finishable.length, dirtySkipped: dirtySkipped.length, blocked: blockedSessions.length };

  if (finishable.length > MAX_DONE_ALL_SESSIONS) {
    return { ok: false, status: "blocked", lane: "done-all", reason: `finishable session count ${finishable.length} exceeds maximum ${MAX_DONE_ALL_SESSIONS}`, summary, sessions: plans };
  }

  const cleanupExcludeBranches = plans.map((plan) => plan.branch).filter((branch): branch is string => typeof branch === "string" && branch.length > 0);
  const cleanupPlan = await guardianFinishWorkflow({ ...nestedInput, repoRoot, cwd: repoRoot, mode: "plan", config, excludeBranches: cleanupExcludeBranches, allowIgnoredFiles: input.allowIgnoredFiles === true, abandonUnmerged: true });
  const cleanupCandidates = Array.isArray(cleanupPlan.candidates) ? cleanupPlan.candidates.length : 0;
  const cleanupRetirementCandidates = Array.isArray(cleanupPlan.reservationRetirementCandidates) ? cleanupPlan.reservationRetirementCandidates.length : 0;
  const cleanupApplyWorkCount = workflowApplyWorkCount(cleanupPlan);
  const cleanupBlockerRecords = Array.isArray(cleanupPlan.blockers) ? cleanupPlan.blockers.filter((blocker): blocker is Record<string, unknown> => isRecordLike(blocker)) : [];
  const cleanupBlockers = cleanupBlockerRecords.length;
  const cleanupHasApplyToken = typeof cleanupPlan.confirmToken === "string";
  const cleanupPreflight = isRecordLike(cleanupPlan.preflight) ? cleanupPlan.preflight : {};
  const cleanupPreflightBlockers = Array.isArray(cleanupPreflight.blockers) ? cleanupPreflight.blockers.filter((blocker): blocker is string => typeof blocker === "string") : [];
  const cleanupScanCompleted = cleanupPreflight.candidateScanStatus === "completed";
  const cleanupHasCandidateBound = cleanupBlockerRecords.some((blocker) => blocker.kind === "candidate-bound");
  const cleanupHasSafeWork = finishable.length > 0 || cleanupApplyWorkCount > 0 && cleanupHasApplyToken;
  const cleanupHardBlocked = cleanupApplyWorkCount > 0 && !cleanupHasApplyToken
    || cleanupHasCandidateBound
    || cleanupPreflightBlockers.length > 0
    || cleanupPlan.ok !== true && (!cleanupScanCompleted || !cleanupHasSafeWork);
  if (cleanupHardBlocked) {
    return {
      ok: false,
      status: "blocked",
      lane: "done-all",
      reason: cleanupApplyWorkCount > 0 && !cleanupHasApplyToken ? "cleanup plan has work but no apply token" : "cleanup plan has blockers; resolve them and re-plan before finishing all sessions",
      baseRef,
      baseRefOid,
      baseRefFetched,
      summary,
      sessions: plans,
      remaining,
      cleanupPlan,
      cleanupSummary: { candidates: cleanupCandidates, retirementCandidates: cleanupRetirementCandidates, applyWorkCount: cleanupApplyWorkCount, blockers: cleanupBlockers },
    };
  }
  const confirmToken = createDoneAllConfirmToken({ repoRoot, config, baseRef, baseRefOid, protectedBranches, plans, cleanupPlan, allowIgnoredFiles: input.allowIgnoredFiles === true, allowAdminBypass: input.allowAdminBypass === true });

  if (mode === "plan") {
    const noSessionWork = plans.length === 0;
    const noCleanupWork = cleanupApplyWorkCount === 0 && cleanupBlockers === 0 && cleanupPlan.ok === true;
    const willRemainPartial = remaining.length > 0 || cleanupBlockers > 0 || cleanupRetirementCandidates > 0 || cleanupPlan.ok !== true;
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

  if (input.confirmToken !== confirmToken) {
    const planCommand = input.all === true ? "guardian_done all=true mode=plan" : "guardian_done mode=plan";
    return { ok: false, status: "blocked", lane: "done-all", reason: `confirm token mismatch; the active session set, base ref, or a worktree changed since plan. Re-run ${planCommand} and use the returned confirmToken`, summary, tokenChecked: true, driftDetected: true, plannedConfirmToken: input.confirmToken, refreshedConfirmToken: confirmToken };
  }

  const cleanupApply = cleanupApplyWorkCount > 0 && cleanupHasApplyToken
    ? await guardianFinishWorkflow({ ...nestedInput, repoRoot, cwd: repoRoot, mode: "apply", confirm: true, confirmToken: cleanupPlan.confirmToken, config, excludeBranches: cleanupExcludeBranches, skipFinalPostflight: true, abandonUnmerged: true })
    : null;
  const cleanupSweep = preSessionCleanupSweep({ cleanupPlan, cleanupCandidates, cleanupRetirementCandidates, cleanupApplyWorkCount, cleanupBlockers, cleanupApply });
  if (cleanupApply?.freshPlanRequired === true) {
    return {
      ok: false,
      status: "partial",
      lane: "done-all",
      reason: "reservation retirement completed; run a fresh plan before further maintenance",
      summary,
      results: [],
      remaining: cleanupSweep.remaining ?? [],
      cleanupSweep,
      freshPlanRequired: true,
    };
  }

  const results: Record<string, unknown>[] = [];
  const baseTransitions: Record<string, unknown>[] = [];
  let baseCursor = baseRefOid;
  for (const plan of finishable) {
    const session = state.sessions?.[plan.session_id];
    if (!isRecordLike(session)) {
      results.push({ session_id: plan.session_id, branch: plan.branch, ok: false, status: "blocked", reason: "session record disappeared before finish" });
      continue;
    }
    if (!baseCursor || !plan.head) {
      return { ok: false, status: "blocked", lane: "done-all", reason: "batch authorization is missing a base or session head", results, baseTransitions };
    }
    const cursor = baseCursor;
    const approvedHead = plan.head;
    try {
      if (typeof plan.finishConfirmToken !== "string") {
        results.push({ session_id: plan.session_id, branch: plan.branch, ok: false, status: "blocked", reason: "session finish plan is missing its approved token" });
        continue;
      }
      const batchAuthorization: BatchLandAuthorization = { kind: "done-all", originalConfirmToken: plan.finishConfirmToken, originalBaseRefOid: baseRefOid, authorizedBaseRefOid: cursor };
      const finish = await guardianDoneLandClean({
        input: { ...nestedInput, mode: "apply", confirm: true, confirmToken: plan.finishConfirmToken, skipPostFinishMaintenance: true },
        repoRoot,
        cwd: plan.worktree_path,
        sessionId: plan.session_id,
        session,
        config,
        batchAuthorization,
      });
      const transition = await observeBaseTransition(repoRoot, baseAuthorityRef, String(config.remote), cursor, approvedHead);
      baseTransitions.push({ session_id: plan.session_id, ...transition });
      const childResult = {
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
      };
      if (finish.ok !== true) {
        results.push(childResult);
        if (batchChildFailureCanContinue(false, transition.before, transition.after)) continue;
        return { ok: false, status: "blocked", lane: "done-all", reason: "failed child moved the remote base; refusing to continue batch", results, baseTransitions, failedChildTransition: transition };
      }
      if (!transition.ok) {
        results.push(childResult);
        return { ok: false, status: "blocked", lane: "done-all", reason: "batch authorization rejected base transition", results, baseTransitions, batchAuthorizationError: transition };
      }
      baseCursor = transition.after;
      results.push(childResult);
    } catch (error) {
      const childResult = { session_id: plan.session_id, branch: plan.branch, ok: false, status: "error", reason: error instanceof Error ? error.message : String(error) };
      results.push(childResult);
      try {
        const transition = await observeBaseTransition(repoRoot, baseAuthorityRef, String(config.remote), cursor, approvedHead);
        baseTransitions.push({ session_id: plan.session_id, ...transition });
        if (transition.before === transition.after) continue;
        return { ok: false, status: "blocked", lane: "done-all", reason: "failed child moved the remote base; refusing to continue batch", results, baseTransitions, failedChildTransition: transition };
      } catch (observationError) {
        return { ok: false, status: "blocked", lane: "done-all", reason: "failed child base observation could not be completed; refusing to continue batch", results, baseTransitions, observationError: observationError instanceof Error ? observationError.message : String(observationError) };
      }
    }
  }

  const finishedCount = results.filter((result) => result.ok === true).length;
  const failedCount = results.length - finishedCount;
  const hardFailure = failedCount > 0;
  const postSessionCleanupSweep = await runCleanupSweep(repoRoot, config, { ...nestedInput, deferBaseSync: true });
  const combinedCleanupSweep = combineCleanupSweeps(cleanupSweep, postSessionCleanupSweep);
  const cleanupRemaining = Array.isArray(combinedCleanupSweep.remaining) ? combinedCleanupSweep.remaining.filter((entry): entry is Record<string, unknown> => isRecordLike(entry)) : [];
  const allRemaining = [...remaining, ...cleanupRemaining];
  if (postSessionCleanupSweep.freshPlanRequired === true) {
    return {
      ok: false,
      status: "partial",
      lane: "done-all",
      reason: "reservation retirement completed; run a fresh plan before final postflight",
      summary: { ...summary, finished: finishedCount, failed: failedCount },
      results,
      remaining: allRemaining,
      cleanupSweep: combinedCleanupSweep,
      baseTransitions,
      freshPlanRequired: true,
    };
  }
  const mainSync = await syncLocalBase(repoRoot, config);
  const requiredCommits = results
    .filter((result) => result.ok === true && typeof result.head === "string")
    .map((result) => ({ commit: String(result.head), source: typeof result.branch === "string" ? result.branch : "done-all-session", reason: "finished session commit must be present on final base" }));
  const finalPostflight = await runFinalCleanupPostflight({ repoRoot, config, requiredCommits: [...requiredCommits, ...finalPostflightCommitsFromCleanupSweep(combinedCleanupSweep)] });
  const finalRemaining = finalPostflight.ok === true ? allRemaining : [...allRemaining, { kind: "final-postflight", status: "blocked", reason: finalPostflight.reason ?? "final cleanup postflight failed", finalPostflight }];
  const repoFinished = !hardFailure && combinedCleanupSweep.ok === true && mainSync.ok === true && finalPostflight.ok === true && finalRemaining.length === 0;
  return {
    ok: repoFinished,
    status: repoFinished ? "finished" : "partial",
    lane: "done-all",
    summary: { ...summary, finished: finishedCount, failed: failedCount },
    results,
    remaining: finalRemaining,
    mainSync,
    finalPostflight,
    stashCount: finalPostflight.stashCount ?? cleanupPreflight.stashCount ?? 0,
    stashes: finalPostflight.stashes ?? cleanupPreflight.stashes ?? [],
    cleanupSweep: combinedCleanupSweep,
    baseTransitions,
    ...(finalRemaining.length > 0 ? { remainingHint: "safe work was applied; remaining entries need explicit cleanup or individual guardian_done handling before the repo is done" } : {}),
  };
}
