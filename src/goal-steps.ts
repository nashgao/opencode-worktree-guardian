import { projectGoalHygieneResult } from "./goal-hygiene-child-result.ts";
import type { GuardianToolResult, RecordLike } from "./types.ts";
import { isRecordLike } from "./types.ts";

const NO_HYGIENE_TARGETS_REASON = "no approved hygiene cleanup targets";

export type GoalTool = "guardian_hygiene" | "guardian_clean_completion" | "guardian_done" | "guardian_finish_workflow";

export type GoalStep = {
  readonly tool: GoalTool;
  readonly ok: boolean;
  readonly status: string;
  readonly reason?: string;
  readonly result?: GuardianToolResult;
};

export type GoalStepBlocker = {
  readonly tool: GoalTool;
  readonly reason: string;
};

function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function recordValue(value: unknown): RecordLike {
  return isRecordLike(value) ? value : {};
}

function hygieneNoTargetPlan(result: GuardianToolResult): boolean {
  const approvedTargetCount = recordValue(result.summary).approvedTargetCount;
  return result.ok === false
    && textValue(result.reason) === NO_HYGIENE_TARGETS_REASON
    && !(typeof approvedTargetCount === "number" && Number.isFinite(approvedTargetCount) && approvedTargetCount > 0);
}

export function goalStepFromResult(tool: GoalTool, result: GuardianToolResult): GoalStep {
  if (tool === "guardian_hygiene" && hygieneNoTargetPlan(result)) {
    return { tool, ok: true, status: "noop", reason: NO_HYGIENE_TARGETS_REASON, result: projectGoalHygieneResult(result) };
  }
  const status = textValue(result.status, result.ok === false ? "blocked" : "planned");
  const reason = textValue(result.reason);
  const base = { tool, ok: result.ok !== false, status, result: tool === "guardian_hygiene" ? projectGoalHygieneResult(result) : result };
  return reason ? { ...base, reason } : base;
}

export function blockedGoalStep(tool: GoalTool, reason: string): GoalStep {
  return { tool, ok: false, status: "blocked", reason };
}

export function goalBlockerFromStep(step: GoalStep): GoalStepBlocker | null {
  if (step.ok) return null;
  return { tool: step.tool, reason: step.reason ?? `${step.tool} blocked` };
}

export function findGoalStep(steps: readonly GoalStep[], tool: GoalTool): GoalStep | null {
  return steps.find((step) => step.tool === tool) ?? null;
}

export function topLevelGoalCommit(steps: readonly GoalStep[]): Record<string, unknown> {
  const result = findGoalStep(steps, "guardian_done")?.result;
  if (!isRecordLike(result)) return {};
  const commit = typeof result.commit === "string" ? result.commit : undefined;
  const branch = typeof result.branch === "string" ? result.branch : undefined;
  return { ...(commit ? { commit } : {}), ...(branch ? { branch } : {}) };
}
