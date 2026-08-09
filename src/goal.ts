import crypto from "node:crypto";
import path from "node:path";
import type { CleanCompletionPlan } from "./clean-completion.ts";
import { planCleanCompletion } from "./clean-completion.ts";
import { loadConfig, normalizeConfig } from "./config.ts";
import { guardianDone } from "./done.ts";
import { getRepoRoot } from "./git.ts";
import { approvedHygieneTargetPaths, postconditionBlocksCompletion, postconditionIsComplete, postconditionReason, scanGoalHygienePostcondition } from "./goal-hygiene-postcondition.ts";
import type { GoalHygienePostcondition } from "./goal-hygiene-postcondition.ts";
import { projectGoalHygieneResult } from "./goal-hygiene-child-result.ts";
import { guardianHygiene } from "./hygiene.ts";
import { getGuardianPaths, readState } from "./state.ts";
import type { GuardianConfig, GuardianToolInput, GuardianToolResult, RecordLike } from "./types.ts";
import { isRecordLike } from "./types.ts";
import type { NormalizedGuardianConfig, NormalizedGuardianGoalConfig } from "./normalized-config.ts";
import { guardianFinishWorkflow } from "./workflow.ts";

const DONE_GOAL_KEYS = ["commitDirty", "landToBase", "pushBase", "cleanupWorktrees", "cleanupBranches"] as const;
const WRITE_GOAL_KEYS = ["commitDirty", "landToBase", "pushBase"] as const;
const CLEANUP_GOAL_KEYS = ["cleanupWorktrees", "cleanupBranches"] as const;
const GOAL_HYGIENE_CATEGORIES = ["known-cleanable"] as const;
const NO_HYGIENE_TARGETS_REASON = "no approved hygiene cleanup targets";

type GoalTool = "guardian_hygiene" | "guardian_done" | "guardian_finish_workflow";

type GoalBlocker = {
  readonly tool: GoalTool | "guardian_goal";
  readonly reason: string;
};

type GoalStep = {
  readonly tool: GoalTool;
  readonly ok: boolean;
  readonly status: string;
  readonly reason?: string;
  readonly result?: GuardianToolResult;
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

type TokenJson = null | boolean | number | string | readonly TokenJson[] | { readonly [key: string]: TokenJson };

function wantsDone(goal: NormalizedGuardianGoalConfig): boolean {
  return DONE_GOAL_KEYS.some((key) => goal[key]);
}

function canUseDone(goal: NormalizedGuardianGoalConfig): boolean {
  return DONE_GOAL_KEYS.every((key) => goal[key]);
}

function isCleanupOnlyGoal(goal: NormalizedGuardianGoalConfig): boolean {
  return WRITE_GOAL_KEYS.every((key) => !goal[key]) && CLEANUP_GOAL_KEYS.some((key) => goal[key]);
}

function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function recordValue(value: unknown): RecordLike {
  return isRecordLike(value) ? value : {};
}

function numericSummaryValue(result: GuardianToolResult, key: string): number {
  const summary = recordValue(result.summary);
  const value = summary[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function hygieneHasApprovedTargets(result: GuardianToolResult): boolean {
  return numericSummaryValue(result, "approvedTargetCount") > 0;
}

function hygieneNoTargetPlan(result: GuardianToolResult): boolean {
  return result.ok === false && textValue(result.reason) === NO_HYGIENE_TARGETS_REASON && !hygieneHasApprovedTargets(result);
}

function stepFromResult(tool: GoalTool, result: GuardianToolResult): GoalStep {
  if (tool === "guardian_hygiene" && hygieneNoTargetPlan(result)) {
    return { tool, ok: true, status: "noop", reason: NO_HYGIENE_TARGETS_REASON, result: projectGoalHygieneResult(result) };
  }
  const status = textValue(result.status, result.ok === false ? "blocked" : "planned");
  const reason = textValue(result.reason);
  const base = { tool, ok: result.ok !== false, status, result: tool === "guardian_hygiene" ? projectGoalHygieneResult(result) : result };
  return reason ? { ...base, reason } : base;
}

function blockedStep(tool: GoalTool, reason: string): GoalStep {
  return { tool, ok: false, status: "blocked", reason };
}

function blockerFromStep(step: GoalStep): GoalBlocker | null {
  if (step.ok) return null;
  return { tool: step.tool, reason: step.reason ?? `${step.tool} blocked` };
}

function tokenValue(value: unknown): TokenJson {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((entry) => tokenValue(entry));
  if (!isRecordLike(value)) return null;
  const output: Record<string, TokenJson> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "scannedAt") continue;
    output[key] = tokenValue(entry);
  }
  return output;
}

function createGoalConfirmToken(plan: Omit<GoalPlan, "confirmToken" | "nextAction">): string {
  const material = {
    tool: "guardian_goal",
    repoRoot: plan.repoRoot,
    cwd: plan.cwd,
    goal: plan.goal,
    steps: plan.steps.map((step) => ({
      tool: step.tool,
      ok: step.ok,
      status: step.status,
      reason: step.reason ?? null,
      result: tokenValue(step.result),
    })),
    blockers: plan.blockers,
    complete: plan.complete,
    hygienePostcondition: tokenValue(plan.hygienePostcondition),
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

async function resolveGoalContext(input: GuardianToolInput): Promise<{ readonly repoRoot: string; readonly cwd: string; readonly config: NormalizedGuardianConfig }> {
  const cwdInput = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const cwd = path.resolve(cwdInput);
  const repoRoot = path.resolve(typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd));
  const config = isRecordLike(input.config) ? normalizeConfig(input.config) : (await loadConfig(repoRoot)).config;
  return { repoRoot, cwd, config };
}

async function resolveCleanCompletionSession(repoRoot: string, config: GuardianConfig, sessionId: unknown) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const paths = await getGuardianPaths(repoRoot);
  const state = await readState(paths, { repoRoot, config });
  return state.sessions[sessionId] ?? null;
}

async function buildCleanCompletionStep(input: GuardianToolInput, repoRoot: string, cwd: string, config: GuardianConfig): Promise<CleanCompletionPlan | undefined> {
  if (!config.goal.quarantineSessionResidue) return undefined;
  const session = await resolveCleanCompletionSession(repoRoot, config, input.sessionId);
  if (!session) return { applicable: false, finalProof: { status: "not-applicable", reason: "no session resolved for quarantine session residue check", candidates: [] }, incompleteOperationCount: 0 };
  return planCleanCompletion({ repoRoot, cwd, config, session });
}

async function buildGoalPlan(input: GuardianToolInput): Promise<GoalPlan> {
  const { repoRoot, cwd, config } = await resolveGoalContext(input);
  const goal = config.goal;
  const steps: GoalStep[] = [];
  const blockers: GoalBlocker[] = [];
  const cleanCompletion = await buildCleanCompletionStep(input, repoRoot, cwd, config);
  let hygienePostcondition: GoalHygienePostcondition;

  if (goal.cleanupHygiene) {
    let hygiene: GuardianToolResult | undefined;
    let approvedTargetPaths: readonly string[] = [];
    let step: GoalStep;
    try {
      hygiene = await guardianHygiene({ ...input, repoRoot, cwd, config, mode: "plan", allowCategories: [...GOAL_HYGIENE_CATEGORIES], allowDirtyNestedGit: false });
      approvedTargetPaths = approvedHygieneTargetPaths(hygiene);
      step = stepFromResult("guardian_hygiene", hygiene);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      step = blockedStep("guardian_hygiene", `guardian_hygiene planning failed: ${error.message}`);
    }
    steps.push(step);
    const blocker = blockerFromStep(step);
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

  if (!wantsDone(goal)) {
    steps.push({ tool: "guardian_done", ok: true, status: "skipped", reason: "done goal flags are disabled" });
  } else if (!canUseDone(goal) && isCleanupOnlyGoal(goal)) {
    const cleanup = await guardianFinishWorkflow({ ...input, repoRoot, cwd, config, mode: "plan" });
    const step = stepFromResult("guardian_finish_workflow", cleanup);
    steps.push(step);
    const blocker = blockerFromStep(step);
    if (blocker) blockers.push(blocker);
  } else if (!canUseDone(goal)) {
    const reason = "guardian_goal can only delegate to guardian_done when commitDirty, landToBase, pushBase, cleanupWorktrees, and cleanupBranches are all true";
    const step = blockedStep("guardian_done", reason);
    steps.push(step);
    blockers.push({ tool: "guardian_goal", reason });
  } else {
    const done = await guardianDone({ ...input, repoRoot, cwd, config, mode: "plan" });
    const step = stepFromResult("guardian_done", done);
    steps.push(step);
    const blocker = blockerFromStep(step);
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

function findStep(plan: GoalPlan, tool: GoalTool): GoalStep | null {
  return plan.steps.find((step) => step.tool === tool) ?? null;
}

async function applyHygieneStep(input: GuardianToolInput, plan: GoalPlan, config: GuardianConfig): Promise<GoalStep> {
  const step = findStep(plan, "guardian_hygiene");
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
  const appliedStep = stepFromResult("guardian_hygiene", applied);
  return appliedStep.ok ? { ...appliedStep, status: "applied" } : appliedStep;
}

async function applyDoneStep(input: GuardianToolInput, plan: GoalPlan, config: GuardianConfig): Promise<GoalStep> {
  const plannedStep = findStep(plan, "guardian_done");
  if (!plannedStep || plannedStep.status === "skipped") return plannedStep ?? { tool: "guardian_done", ok: true, status: "skipped" };
  const freshPlan = await guardianDone({ ...input, repoRoot: plan.repoRoot, cwd: plan.cwd, config, mode: "plan" });
  if (freshPlan.ok !== true) return stepFromResult("guardian_done", freshPlan);
  const applied = await guardianDone({
    ...input,
    repoRoot: plan.repoRoot,
    cwd: plan.cwd,
    config,
    mode: "apply",
    confirm: true,
    ...(typeof freshPlan.confirmToken === "string" ? { confirmToken: freshPlan.confirmToken } : {}),
  });
  const appliedStep = stepFromResult("guardian_done", applied);
  return appliedStep.ok ? { ...appliedStep, status: "applied" } : appliedStep;
}

async function applyCleanupWorkflowStep(input: GuardianToolInput, plan: GoalPlan, config: GuardianConfig): Promise<GoalStep> {
  const plannedStep = findStep(plan, "guardian_finish_workflow");
  if (!plannedStep || plannedStep.status === "skipped") return plannedStep ?? { tool: "guardian_finish_workflow", ok: true, status: "skipped" };
  const freshPlan = await guardianFinishWorkflow({ ...input, repoRoot: plan.repoRoot, cwd: plan.cwd, config, mode: "plan" });
  if (freshPlan.ok !== true) return stepFromResult("guardian_finish_workflow", freshPlan);
  const applied = await guardianFinishWorkflow({
    ...input,
    repoRoot: plan.repoRoot,
    cwd: plan.cwd,
    config,
    mode: "apply",
    ...(typeof freshPlan.confirmToken === "string" ? { confirmToken: freshPlan.confirmToken } : {}),
  });
  const appliedStep = stepFromResult("guardian_finish_workflow", applied);
  return appliedStep.ok ? { ...appliedStep, status: "applied" } : appliedStep;
}

function topLevelCommit(steps: readonly GoalStep[]): Record<string, unknown> {
  const done = steps.find((step) => step.tool === "guardian_done");
  const result = done?.result;
  if (!isRecordLike(result)) return {};
  const commit = typeof result.commit === "string" ? result.commit : undefined;
  const branch = typeof result.branch === "string" ? result.branch : undefined;
  return {
    ...(commit ? { commit } : {}),
    ...(branch ? { branch } : {}),
  };
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
    findStep(plan, "guardian_finish_workflow")
      ? await applyCleanupWorkflowStep(input, plan, config)
      : await applyDoneStep(input, plan, config),
  ];
  const blockers = appliedSteps.map(blockerFromStep).filter((blocker): blocker is GoalBlocker => blocker !== null);
  const hygienePostcondition = await scanGoalHygienePostcondition({ repoRoot: plan.repoRoot, cwd: plan.cwd, config, input, phase: "apply" });
  const ok = blockers.length === 0;
  const complete = ok && postconditionIsComplete(hygienePostcondition);
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
    ...(!ok ? { reason: "guardian_goal applied safe steps but remaining blockers need attention" } : postconditionFailure ? { reason: postconditionFailure } : {}),
    ...topLevelCommit(appliedSteps),
  };
}
