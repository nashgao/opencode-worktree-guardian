import path from "node:path";
import type { CleanCompletionPlan } from "./clean-completion.ts";
import { proveAndPersistCleanCompletion } from "./clean-completion-proof.ts";
import { loadConfig, normalizeConfig } from "./config.ts";
import { guardianDone } from "./done.ts";
import { getRepoRoot } from "./git.ts";
import { applyGoalCleanCompletion, goalCleanCompletionBlockReason, planGoalCleanCompletion, plannedGoalCleanCompletionStep } from "./goal-clean-completion.ts";
import { createGoalConfirmToken } from "./goal-confirm-token.ts";
import { approvedHygieneTargetPaths, postconditionBlocksCompletion, postconditionIsComplete, postconditionReason, scanGoalHygienePostcondition } from "./goal-hygiene-postcondition.ts";
import type { GoalHygienePostcondition } from "./goal-hygiene-postcondition.ts";
import { blockedGoalStep, findGoalStep, goalBlockerFromStep, goalStepFromResult, topLevelGoalCommit } from "./goal-steps.ts";
import type { GoalStep, GoalStepBlocker, GoalTool } from "./goal-steps.ts";
import { guardianHygiene } from "./hygiene.ts";
import type { GuardianConfig, GuardianToolInput, GuardianToolResult } from "./types.ts";
import { isRecordLike } from "./types.ts";
import type { NormalizedGuardianConfig, NormalizedGuardianGoalConfig } from "./normalized-config.ts";
import { guardianFinishWorkflow } from "./workflow.ts";

const DONE_GOAL_KEYS = ["commitDirty", "landToBase", "pushBase", "cleanupWorktrees", "cleanupBranches"] as const;
const WRITE_GOAL_KEYS = ["commitDirty", "landToBase", "pushBase"] as const;
const CLEANUP_GOAL_KEYS = ["cleanupWorktrees", "cleanupBranches"] as const;
const GOAL_HYGIENE_CATEGORIES = ["known-cleanable"] as const;

type GoalBlocker = {
  readonly tool: GoalTool | "guardian_goal";
  readonly reason: string;
};

type GoalPlan = {
  readonly ok: boolean;
  readonly complete: null;
  readonly status: "planned" | "planned-partial" | "blocked";
  readonly lane: "goal";
  readonly repoRoot: string;
  readonly cwd: string;
  readonly goal: NormalizedGuardianGoalConfig;
  readonly steps: readonly GoalStep[];
  readonly blockers: readonly GoalBlocker[];
  readonly hygienePostcondition: GoalHygienePostcondition;
  readonly cleanCompletion?: CleanCompletionPlan;
  readonly confirmToken?: string;
  readonly nextAction?: string;
  readonly reason?: string;
};

function wantsDone(goal: NormalizedGuardianGoalConfig): boolean {
  return DONE_GOAL_KEYS.some((key) => goal[key]);
}

function canUseDone(goal: NormalizedGuardianGoalConfig): boolean {
  return DONE_GOAL_KEYS.every((key) => goal[key]);
}

function isCleanupOnlyGoal(goal: NormalizedGuardianGoalConfig): boolean {
  return WRITE_GOAL_KEYS.every((key) => !goal[key]) && CLEANUP_GOAL_KEYS.some((key) => goal[key]);
}

async function resolveGoalContext(input: GuardianToolInput): Promise<{ readonly repoRoot: string; readonly cwd: string; readonly config: NormalizedGuardianConfig }> {
  const cwdInput = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const cwd = path.resolve(cwdInput);
  const repoRoot = path.resolve(typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd));
  const config = isRecordLike(input.config) ? normalizeConfig(input.config) : (await loadConfig(repoRoot)).config;
  return { repoRoot, cwd, config };
}

async function buildGoalPlan(input: GuardianToolInput): Promise<GoalPlan> {
  const { repoRoot, cwd, config } = await resolveGoalContext(input);
  const goal = config.goal;
  const steps: GoalStep[] = [];
  const blockers: GoalBlocker[] = [];
  const cleanCompletion = await planGoalCleanCompletion(input, repoRoot, cwd, config);
  let hygienePostcondition: GoalHygienePostcondition;

  if (goal.cleanupHygiene) {
    let hygiene: GuardianToolResult | undefined;
    let approvedTargetPaths: readonly string[] = [];
    let step: GoalStep;
    try {
      hygiene = await guardianHygiene({ ...input, repoRoot, cwd, config, mode: "plan", allowCategories: [...GOAL_HYGIENE_CATEGORIES], allowDirtyNestedGit: false });
      approvedTargetPaths = approvedHygieneTargetPaths(hygiene);
      step = goalStepFromResult("guardian_hygiene", hygiene);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      step = blockedGoalStep("guardian_hygiene", `guardian_hygiene planning failed: ${error.message}`);
    }
    steps.push(step);
    const blocker = goalBlockerFromStep(step);
    if (blocker) blockers.push(blocker);
    hygienePostcondition = await scanGoalHygienePostcondition({
      repoRoot,
      cwd,
      config,
      input,
      phase: "plan",
      approvedTargetPaths,
    });
    if (hygienePostcondition.status === "scan-failed") {
      blockers.push({ tool: "guardian_goal", reason: postconditionReason(hygienePostcondition) ?? "guardian_goal hygiene postcondition scan failed" });
    }
  } else {
    steps.push({ tool: "guardian_hygiene", ok: true, status: "skipped", reason: "cleanupHygiene=false" });
    hygienePostcondition = await scanGoalHygienePostcondition({ repoRoot, cwd, config, input, phase: "plan" });
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
    const done = await guardianDone({ ...input, repoRoot, cwd, config, mode: "plan", ...(cleanCompletion && goalCleanCompletionBlockReason(cleanCompletion) === null ? { allowIgnoredFiles: true } : {}) });
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

async function applyHygieneStep(input: GuardianToolInput, plan: GoalPlan, config: GuardianConfig): Promise<GoalStep> {
  const step = findGoalStep(plan.steps, "guardian_hygiene");
  const result = step?.result;
  if (!step || step.status === "skipped" || step.status === "noop" || !isRecordLike(result) || result.ok !== true || typeof result.confirmToken !== "string") {
    return step ?? { tool: "guardian_hygiene", ok: true, status: "skipped", reason: "cleanupHygiene=false" };
  }
  const applied = await guardianHygiene({
    ...input,
    repoRoot: plan.repoRoot,
    cwd: plan.cwd,
    config,
    mode: "apply",
    allowCategories: [...GOAL_HYGIENE_CATEGORIES],
    allowDirtyNestedGit: false,
    confirmDelete: true,
    confirmToken: result.confirmToken,
  });
  const appliedStep = goalStepFromResult("guardian_hygiene", applied);
  return appliedStep.ok ? { ...appliedStep, status: "applied" } : appliedStep;
}

async function applyDoneStep(input: GuardianToolInput, plan: GoalPlan, config: GuardianConfig): Promise<GoalStep> {
  const plannedStep = findGoalStep(plan.steps, "guardian_done");
  if (!plannedStep || plannedStep.status === "skipped") return plannedStep ?? { tool: "guardian_done", ok: true, status: "skipped" };
  const freshPlan = await guardianDone({ ...input, repoRoot: plan.repoRoot, cwd: plan.cwd, config, mode: "plan" });
  if (freshPlan.ok !== true) return goalStepFromResult("guardian_done", freshPlan);
  const applied = await guardianDone({
    ...input,
    repoRoot: plan.repoRoot,
    cwd: plan.cwd,
    config,
    mode: "apply",
    confirm: true,
    ...(typeof freshPlan.confirmToken === "string" ? { confirmToken: freshPlan.confirmToken } : {}),
  });
  const appliedStep = goalStepFromResult("guardian_done", applied);
  return appliedStep.ok ? { ...appliedStep, status: "applied" } : appliedStep;
}

async function applyCleanupWorkflowStep(input: GuardianToolInput, plan: GoalPlan, config: GuardianConfig): Promise<GoalStep> {
  const plannedStep = findGoalStep(plan.steps, "guardian_finish_workflow");
  if (!plannedStep || plannedStep.status === "skipped") return plannedStep ?? { tool: "guardian_finish_workflow", ok: true, status: "skipped" };
  const freshPlan = await guardianFinishWorkflow({ ...input, repoRoot: plan.repoRoot, cwd: plan.cwd, config, mode: "plan" });
  if (freshPlan.ok !== true) return goalStepFromResult("guardian_finish_workflow", freshPlan);
  const applied = await guardianFinishWorkflow({
    ...input,
    repoRoot: plan.repoRoot,
    cwd: plan.cwd,
    config,
    mode: "apply",
    ...(typeof freshPlan.confirmToken === "string" ? { confirmToken: freshPlan.confirmToken } : {}),
  });
  const appliedStep = goalStepFromResult("guardian_finish_workflow", applied);
  return appliedStep.ok ? { ...appliedStep, status: "applied" } : appliedStep;
}

export async function guardianGoal(input: GuardianToolInput = {}): Promise<GuardianToolResult> {
  const requestedMode = input.mode ?? "plan";
  if (requestedMode !== "plan" && requestedMode !== "apply") return { ok: false, status: "blocked", lane: "goal", reason: "mode must be plan or apply", mode: requestedMode };
  const plan = await buildGoalPlan(input);
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
      goal: plan.goal,
      steps: plan.steps,
      blockers: [{ tool: "guardian_goal", reason: "confirm token mismatch; re-run mode=plan and use the returned confirmToken" }],
      reason: "confirm token mismatch; re-run mode=plan and use the returned confirmToken",
      tokenMatched: false,
    };
  }

  const { config } = await resolveGoalContext(input);
  const appliedSteps = [
    await applyHygieneStep(input, plan, config),
    await applyGoalCleanCompletion(input, plan, config),
    findGoalStep(plan.steps, "guardian_finish_workflow")
      ? await applyCleanupWorkflowStep(input, plan, config)
      : await applyDoneStep(input, plan, config),
  ];
  const stepBlockers = appliedSteps.map(goalBlockerFromStep).filter((blocker): blocker is GoalStepBlocker => blocker !== null);
  const hygienePostcondition = await scanGoalHygienePostcondition({ repoRoot: plan.repoRoot, cwd: plan.cwd, config, input, phase: "apply" });
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
    goal: plan.goal,
    steps: appliedSteps,
    blockers,
    hygienePostcondition,
    ...(proofResult?.ok === true ? { cleanCompletionProof: proofResult.evidence } : {}),
    ...(!ok ? { reason: "guardian_goal applied safe steps but remaining blockers need attention" } : postconditionFailure ? { reason: postconditionFailure } : {}),
    ...topLevelGoalCommit(appliedSteps),
  };
}
