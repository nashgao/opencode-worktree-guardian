import { guardianDone } from "./done.ts";
import { applyGoalCleanCompletion } from "./goal-clean-completion.ts";
import { postconditionBlocksCompletion, postconditionReason, scanGoalHygienePostcondition } from "./goal-hygiene-postcondition.ts";
import type { GoalHygienePostcondition } from "./goal-hygiene-types.ts";
import { blockedGoalStep, findGoalStep, goalBlockerFromStep, goalStepFromResult } from "./goal-steps.ts";
import type { GoalStep, GoalStepBlocker, GoalTool } from "./goal-steps.ts";
import type { GoalPlan } from "./goal-types.ts";
import { guardianHygiene } from "./hygiene.ts";
import type { NormalizedGuardianConfig } from "./normalized-config.ts";
import type { GuardianToolInput } from "./types.ts";
import { isRecordLike } from "./types.ts";
import { guardianFinishWorkflow } from "./workflow.ts";

const GOAL_HYGIENE_CATEGORIES = ["known-cleanable", "filesystem-only-empty-directory"] as const;

type ApplyStepInput = {
  readonly input: GuardianToolInput;
  readonly plan: GoalPlan;
  readonly config: NormalizedGuardianConfig;
};

export type GoalApplyResult = {
  readonly steps: readonly GoalStep[];
  readonly hygienePostcondition: GoalHygienePostcondition;
  readonly completionApplied: boolean;
};

async function applyHygieneStep(context: ApplyStepInput): Promise<GoalStep> {
  const step = findGoalStep(context.plan.steps, "guardian_hygiene");
  const result = step?.result;
  if (!step || step.status === "skipped" || step.status === "noop" || !isRecordLike(result) || result.ok !== true || typeof result.confirmToken !== "string") {
    return step ?? { tool: "guardian_hygiene", ok: true, status: "skipped", reason: "cleanupHygiene=false" };
  }
  const applied = await guardianHygiene({
    ...context.input,
    trackedBaselineCommit: context.plan.trackedBaseline.commit,
    trackedBaselineSource: context.plan.trackedBaseline.source,
    trackedIntentionalPaths: context.plan.intentionalPaths,
    repoRoot: context.plan.cwd,
    cwd: context.plan.cwd,
    config: context.config,
    mode: "apply",
    allowCategories: [...GOAL_HYGIENE_CATEGORIES],
    allowDirtyNestedGit: false,
    confirmDelete: true,
    confirmToken: result.confirmToken,
  });
  const appliedStep = goalStepFromResult("guardian_hygiene", applied);
  return appliedStep.ok ? { ...appliedStep, status: "applied" } : appliedStep;
}

async function applyDoneStep(context: ApplyStepInput): Promise<GoalStep> {
  const plannedStep = findGoalStep(context.plan.steps, "guardian_done");
  if (!plannedStep || plannedStep.status === "skipped") return plannedStep ?? { tool: "guardian_done", ok: true, status: "skipped" };
  const freshPlan = await guardianDone({ ...context.input, repoRoot: context.plan.repoRoot, cwd: context.plan.cwd, config: context.config, mode: "plan" });
  if (freshPlan.ok !== true) return goalStepFromResult("guardian_done", freshPlan);
  const applied = await guardianDone({
    ...context.input,
    repoRoot: context.plan.repoRoot,
    cwd: context.plan.cwd,
    config: context.config,
    mode: "apply",
    confirm: true,
    ...(typeof freshPlan.confirmToken === "string" ? { confirmToken: freshPlan.confirmToken } : {}),
  });
  const appliedStep = goalStepFromResult("guardian_done", applied);
  return appliedStep.ok ? { ...appliedStep, status: "applied" } : appliedStep;
}

async function applyCleanupWorkflowStep(context: ApplyStepInput): Promise<GoalStep> {
  const plannedStep = findGoalStep(context.plan.steps, "guardian_finish_workflow");
  if (!plannedStep || plannedStep.status === "skipped") return plannedStep ?? { tool: "guardian_finish_workflow", ok: true, status: "skipped" };
  const freshPlan = await guardianFinishWorkflow({ ...context.input, repoRoot: context.plan.repoRoot, cwd: context.plan.cwd, config: context.config, mode: "plan" });
  if (freshPlan.ok !== true) return goalStepFromResult("guardian_finish_workflow", freshPlan);
  const applied = await guardianFinishWorkflow({
    ...context.input,
    repoRoot: context.plan.repoRoot,
    cwd: context.plan.cwd,
    config: context.config,
    mode: "apply",
    ...(typeof freshPlan.confirmToken === "string" ? { confirmToken: freshPlan.confirmToken } : {}),
  });
  const appliedStep = goalStepFromResult("guardian_finish_workflow", applied);
  return appliedStep.ok ? { ...appliedStep, status: "applied" } : appliedStep;
}

function completionTool(plan: GoalPlan): GoalTool {
  return findGoalStep(plan.steps, "guardian_finish_workflow") ? "guardian_finish_workflow" : "guardian_done";
}

function gateReason(blocker: GoalStepBlocker | null, postcondition: GoalHygienePostcondition): string | null {
  if (blocker) return blocker.reason;
  if (!postconditionBlocksCompletion(postcondition)) return null;
  return postconditionReason(postcondition) ?? "guardian_goal hygiene completion blocks commit and push";
}

export async function applyGoalSteps(input: {
  readonly request: GuardianToolInput;
  readonly plan: GoalPlan;
  readonly config: NormalizedGuardianConfig;
  readonly hygieneConfig: NormalizedGuardianConfig;
}): Promise<GoalApplyResult> {
  const hygiene = await applyHygieneStep({ input: input.request, plan: input.plan, config: input.hygieneConfig });
  const cleanCompletion = await applyGoalCleanCompletion(input.request, input.plan, input.config);
  const safeSteps = [hygiene, cleanCompletion];
  const safeBlocker = safeSteps.map(goalBlockerFromStep).find((blocker): blocker is GoalStepBlocker => blocker !== null) ?? null;
  const hygienePostcondition = await scanGoalHygienePostcondition({ repoRoot: input.plan.cwd, cwd: input.plan.cwd, config: input.hygieneConfig, input: { ...input.request, trackedBaselineCommit: input.plan.trackedBaseline.commit, trackedBaselineSource: input.plan.trackedBaseline.source, trackedIntentionalPaths: input.plan.intentionalPaths }, phase: "apply" });
  const tool = completionTool(input.plan);
  const plannedCompletion = findGoalStep(input.plan.steps, tool);
  const reason = plannedCompletion?.status === "skipped" ? null : gateReason(safeBlocker, hygienePostcondition);
  const completion = reason
    ? blockedGoalStep(tool, reason)
    : tool === "guardian_finish_workflow"
      ? await applyCleanupWorkflowStep({ input: input.request, plan: input.plan, config: input.config })
      : await applyDoneStep({ input: input.request, plan: input.plan, config: input.config });
  return {
    steps: [...safeSteps, completion],
    hygienePostcondition,
    completionApplied: completion.status === "applied",
  };
}
