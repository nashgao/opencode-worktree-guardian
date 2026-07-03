import crypto from "node:crypto";
import path from "node:path";
import { loadConfig, normalizeConfig } from "./config.ts";
import { guardianDone } from "./done.ts";
import { getRepoRoot } from "./git.ts";
import { guardianHygiene } from "./hygiene.ts";
import type { GuardianConfig, GuardianGoalConfig, GuardianToolInput, GuardianToolResult, RecordLike } from "./types.ts";
import { isRecordLike } from "./types.ts";

const DONE_GOAL_KEYS = ["commitDirty", "landToBase", "pushBase", "cleanupWorktrees", "cleanupBranches"] as const;
const GOAL_HYGIENE_CATEGORIES = ["known-cleanable"] as const;
const NO_HYGIENE_TARGETS_REASON = "no approved hygiene cleanup targets";

type GoalTool = "guardian_hygiene" | "guardian_done";

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
  readonly status: "planned" | "planned-partial" | "blocked";
  readonly lane: "goal";
  readonly repoRoot: string;
  readonly cwd: string;
  readonly goal: GuardianGoalConfig;
  readonly steps: readonly GoalStep[];
  readonly blockers: readonly GoalBlocker[];
  readonly confirmToken?: string;
  readonly nextAction?: string;
  readonly reason?: string;
};

type TokenJson = null | boolean | number | string | readonly TokenJson[] | { readonly [key: string]: TokenJson };

function wantsDone(goal: GuardianGoalConfig): boolean {
  return DONE_GOAL_KEYS.some((key) => goal[key]);
}

function canUseDone(goal: GuardianGoalConfig): boolean {
  return DONE_GOAL_KEYS.every((key) => goal[key]);
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
    return { tool, ok: true, status: "noop", reason: NO_HYGIENE_TARGETS_REASON, result };
  }
  const status = textValue(result.status, result.ok === false ? "blocked" : "planned");
  const reason = textValue(result.reason);
  const base = { tool, ok: result.ok !== false, status, result };
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
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

async function resolveGoalContext(input: GuardianToolInput): Promise<{ readonly repoRoot: string; readonly cwd: string; readonly config: GuardianConfig }> {
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

  if (goal.cleanupHygiene) {
    const hygiene = await guardianHygiene({ ...input, repoRoot, cwd, config, mode: "plan", allowCategories: [...GOAL_HYGIENE_CATEGORIES] });
    const step = stepFromResult("guardian_hygiene", hygiene);
    steps.push(step);
    const blocker = blockerFromStep(step);
    if (blocker) blockers.push(blocker);
  } else {
    steps.push({ tool: "guardian_hygiene", ok: true, status: "skipped", reason: "cleanupHygiene=false" });
  }

  if (!wantsDone(goal)) {
    steps.push({ tool: "guardian_done", ok: true, status: "skipped", reason: "done goal flags are disabled" });
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

  const hasPartialStep = steps.some((step) => step.status === "planned-partial");
  const basePlan = {
    ok: blockers.length === 0,
    status: blockers.length > 0 ? "blocked" : hasPartialStep ? "planned-partial" : "planned",
    lane: "goal",
    repoRoot,
    cwd,
    goal,
    steps,
    blockers,
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
  if (plan.ok !== true) return { ...plan, ok: false, status: "blocked", reason: "guardian_goal apply requires a blocker-free plan" };
  if (input.confirm !== true) {
    return { ...plan, ok: false, status: "blocked", reason: "guardian_goal apply requires confirm=true", nextAction: "guardian_goal mode=apply confirm=true" };
  }
  if (typeof plan.confirmToken !== "string" || input.confirmToken !== plan.confirmToken) {
    return {
      ok: false,
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
    await applyDoneStep(input, plan, config),
  ];
  const blockers = appliedSteps.map(blockerFromStep).filter((blocker): blocker is GoalBlocker => blocker !== null);
  const complete = blockers.length === 0;
  return {
    ok: complete,
    status: complete ? "complete" : "partial",
    lane: "goal",
    repoRoot: plan.repoRoot,
    cwd: plan.cwd,
    goal: plan.goal,
    steps: appliedSteps,
    blockers,
    ...(complete ? {} : { reason: "guardian_goal applied safe steps but remaining blockers need attention" }),
    ...topLevelCommit(appliedSteps),
  };
}
