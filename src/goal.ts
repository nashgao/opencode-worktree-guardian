import { proveAndPersistCleanCompletion } from "./clean-completion-proof.ts";
import { guardianDone } from "./done.ts";
import { applyGoalSteps } from "./goal-apply.ts";
import { goalCleanCompletionBlockReason, planGoalCleanCompletion, plannedGoalCleanCompletionStep } from "./goal-clean-completion.ts";
import { createGoalConfirmToken } from "./goal-confirm-token.ts";
import { resolveGoalContext } from "./goal-context.ts";
import type { GoalContext } from "./goal-context.ts";
import { approvedHygieneTargetPaths, failedGoalHygienePostcondition, postconditionBlocksCompletion, postconditionIsComplete, postconditionReason, scanGoalHygienePostcondition } from "./goal-hygiene-postcondition.ts";
import type { GoalHygienePostcondition } from "./goal-hygiene-postcondition.ts";
import { blockedGoalStep, goalBlockerFromStep, goalStepFromResult, topLevelGoalCommit } from "./goal-steps.ts";
import type { GoalStep, GoalStepBlocker, GoalTool } from "./goal-steps.ts";
import type { GoalBlocker, GoalPlan } from "./goal-types.ts";
import { guardianHygiene } from "./hygiene.ts";
import type { GuardianToolInput, GuardianToolResult } from "./types.ts";
import type { NormalizedGuardianGoalConfig } from "./normalized-config.ts";
import { guardianFinishWorkflow } from "./workflow.ts";

const DONE_GOAL_KEYS = ["commitDirty", "landToBase", "pushBase", "cleanupWorktrees", "cleanupBranches"] as const;
const WRITE_GOAL_KEYS = ["commitDirty", "landToBase", "pushBase"] as const;
const CLEANUP_GOAL_KEYS = ["cleanupWorktrees", "cleanupBranches"] as const;
const GOAL_HYGIENE_CATEGORIES = ["known-cleanable", "filesystem-only-empty-directory"] as const;

function wantsDone(goal: NormalizedGuardianGoalConfig): boolean {
  return DONE_GOAL_KEYS.some((key) => goal[key]);
}

function canUseDone(goal: NormalizedGuardianGoalConfig): boolean {
  return DONE_GOAL_KEYS.every((key) => goal[key]);
}

function isCleanupOnlyGoal(goal: NormalizedGuardianGoalConfig): boolean {
  return WRITE_GOAL_KEYS.every((key) => !goal[key]) && CLEANUP_GOAL_KEYS.some((key) => goal[key]);
}

async function buildGoalPlan(input: GuardianToolInput, context: GoalContext): Promise<GoalPlan> {
  const { repoRoot, cwd, config, hygieneConfig, intentionalPaths, trackedBaseline } = context;
  const hygieneInput = { ...input, trackedBaselineCommit: trackedBaseline.commit, trackedBaselineSource: trackedBaseline.source, trackedIntentionalPaths: intentionalPaths };
  const goal = config.goal;
  const steps: GoalStep[] = [];
  const blockers: GoalBlocker[] = [];
  const cleanCompletion = await planGoalCleanCompletion({ request: input, repoRoot, cwd, config });
  let hygienePostcondition: GoalHygienePostcondition;
  let hygieneHasApprovedTargets = false;

  if (goal.cleanupHygiene) {
    let hygiene: GuardianToolResult | undefined;
    let approvedTargetPaths: readonly string[] = [];
    let step: GoalStep;
    try {
      hygiene = await guardianHygiene({ ...hygieneInput, repoRoot: cwd, cwd, config: hygieneConfig, mode: "plan", allowCategories: [...GOAL_HYGIENE_CATEGORIES], allowDirtyNestedGit: false });
      approvedTargetPaths = approvedHygieneTargetPaths(hygiene);
      hygieneHasApprovedTargets = approvedTargetPaths.length > 0;
      step = goalStepFromResult("guardian_hygiene", hygiene);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      step = blockedGoalStep("guardian_hygiene", `guardian_hygiene planning failed: ${error.message}`);
    }
    steps.push(step);
    const blocker = goalBlockerFromStep(step);
    if (blocker) blockers.push(blocker);
    hygienePostcondition = await scanGoalHygienePostcondition({
      repoRoot: cwd,
      cwd,
      config: hygieneConfig,
      input: hygieneInput,
      phase: "plan",
      approvedTargetPaths,
    });
    if (hygienePostcondition.status === "scan-failed") {
      blockers.push({ tool: "guardian_goal", reason: postconditionReason(hygienePostcondition) ?? "guardian_goal hygiene postcondition scan failed" });
    }
  } else {
    steps.push({ tool: "guardian_hygiene", ok: true, status: "skipped", reason: "cleanupHygiene=false" });
    hygienePostcondition = await scanGoalHygienePostcondition({ repoRoot: cwd, cwd, config: hygieneConfig, input: hygieneInput, phase: "plan" });
  }

  if (cleanCompletion) {
    const step = plannedGoalCleanCompletionStep(cleanCompletion);
    steps.push(step);
    const blocker = goalBlockerFromStep(step);
    if (blocker) blockers.push(blocker);
  }

  if (!wantsDone(goal)) {
    steps.push({ tool: "guardian_done", ok: true, status: "skipped", reason: "done goal flags are disabled" });
  } else if (!canUseDone(goal) && isCleanupOnlyGoal(goal)) {
    const cleanup = await guardianFinishWorkflow({ ...input, repoRoot, cwd, config, mode: "plan" });
    const step = goalStepFromResult("guardian_finish_workflow", cleanup);
    steps.push(step);
    const blocker = goalBlockerFromStep(step);
    if (blocker) blockers.push(blocker);
  } else if (!canUseDone(goal)) {
    const reason = "guardian_goal can only delegate to guardian_done when commitDirty, landToBase, pushBase, cleanupWorktrees, and cleanupBranches are all true";
    const step = blockedGoalStep("guardian_done", reason);
    steps.push(step);
    blockers.push({ tool: "guardian_goal", reason });
  } else {
    const forecastsIgnoredCleanup = hygieneHasApprovedTargets || cleanCompletion && goalCleanCompletionBlockReason(cleanCompletion) === null;
    const done = await guardianDone({ ...input, repoRoot, cwd, config, mode: "plan", ...(forecastsIgnoredCleanup ? { allowIgnoredFiles: true } : {}) });
    const step = goalStepFromResult("guardian_done", done);
    steps.push(step);
    const blocker = goalBlockerFromStep(step);
    if (blocker) blockers.push(blocker);
  }

  const hasPartialStep = steps.some((step) => step.status === "planned-partial") || postconditionBlocksCompletion(hygienePostcondition);
  const basePlan = {
    ok: blockers.length === 0,
    complete: null,
    status: blockers.length > 0 ? "blocked" : hasPartialStep ? "planned-partial" : "planned",
    lane: "goal",
    repoRoot,
    cwd,
    intentionalPaths,
    trackedBaseline,
    goal,
    steps,
    blockers,
    hygienePostcondition,
    ...(cleanCompletion ? { cleanCompletion } : {}),
    ...(blockers.length > 0 ? { reason: "guardian_goal plan has blockers" } : {}),
  } satisfies Omit<GoalPlan, "confirmToken" | "nextAction">;
  if (basePlan.ok !== true) return basePlan;
  const confirmToken = createGoalConfirmToken(basePlan);
  return { ...basePlan, confirmToken, nextAction: "guardian_goal mode=apply confirm=true" };
}

export async function guardianGoal(input: GuardianToolInput = {}): Promise<GuardianToolResult> {
  const requestedMode = input.mode ?? "plan";
  if (requestedMode !== "plan" && requestedMode !== "apply") return { ok: false, status: "blocked", lane: "goal", reason: "mode must be plan or apply", mode: requestedMode };
  const resolved = await resolveGoalContext(input);
  if (!resolved.ok) {
    return {
      ok: false,
      complete: requestedMode === "apply" ? false : null,
      status: "blocked",
      lane: "goal",
      repoRoot: resolved.repoRoot,
      cwd: resolved.cwd,
      blockers: [{ tool: "guardian_goal", reason: resolved.reason }],
      reason: resolved.reason,
      ...(resolved.hygieneCompletion ? { hygienePostcondition: failedGoalHygienePostcondition(resolved.hygieneCompletion, requestedMode) } : {}),
    };
  }
  const plan = await buildGoalPlan(input, resolved.context);
  if (requestedMode === "plan") return plan;
  if (plan.ok !== true) return { ...plan, ok: false, complete: false, status: "blocked", reason: "guardian_goal apply requires a blocker-free plan" };
  if (input.confirm !== true) {
    return { ...plan, ok: false, complete: false, status: "blocked", reason: "guardian_goal apply requires confirm=true", nextAction: "guardian_goal mode=apply confirm=true" };
  }
  if (typeof plan.confirmToken !== "string" || input.confirmToken !== plan.confirmToken) {
    return {
      ok: false,
      complete: false,
      status: "blocked",
      lane: "goal",
      repoRoot: plan.repoRoot,
      cwd: plan.cwd,
      intentionalPaths: plan.intentionalPaths,
      trackedBaseline: plan.trackedBaseline,
      goal: plan.goal,
      steps: plan.steps,
      blockers: [{ tool: "guardian_goal", reason: "confirm token mismatch; re-run mode=plan and use the returned confirmToken" }],
      reason: "confirm token mismatch; re-run mode=plan and use the returned confirmToken",
      tokenMatched: false,
    };
  }

  const { config, hygieneConfig } = resolved.context;
  const applied = await applyGoalSteps({ request: input, plan, config, hygieneConfig });
  const appliedSteps = applied.steps;
  const stepBlockers = appliedSteps.map(goalBlockerFromStep).filter((blocker): blocker is GoalStepBlocker => blocker !== null);
  const hygienePostcondition = applied.hygienePostcondition;
  const proofResult = plan.cleanCompletion?.applicable === true && stepBlockers.length === 0 && postconditionIsComplete(hygienePostcondition)
    ? await proveAndPersistCleanCompletion({ repoRoot: plan.repoRoot, config })
    : null;
  const proofBlocker: GoalBlocker | null = proofResult?.ok === false ? { tool: "guardian_goal", reason: proofResult.reason } : null;
  const blockers = proofBlocker ? [...stepBlockers, proofBlocker] : stepBlockers;
  const ok = blockers.length === 0;
  const complete = ok && postconditionIsComplete(hygienePostcondition) && (plan.cleanCompletion?.applicable !== true || proofResult?.ok === true);
  const postconditionFailure = postconditionReason(hygienePostcondition);
  return {
    ok,
    complete,
    status: complete ? "complete" : "partial",
    lane: "goal",
    repoRoot: plan.repoRoot,
    cwd: plan.cwd,
    intentionalPaths: plan.intentionalPaths,
    trackedBaseline: plan.trackedBaseline,
    goal: plan.goal,
    steps: appliedSteps,
    blockers,
    hygienePostcondition,
    ...(proofResult?.ok === true ? { cleanCompletionProof: proofResult.evidence } : {}),
    ...(!ok ? { reason: "guardian_goal applied safe steps but remaining blockers need attention" } : postconditionFailure ? { reason: postconditionFailure } : {}),
    ...topLevelGoalCommit(appliedSteps),
  };
}
