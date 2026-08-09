import { appendCleanupEvidence, appendFinalPostflightEvidence } from "./readable-output-evidence.ts";
import { appendReservationRetirementEvidence } from "./readable-output-retirement.ts";
import { appendBoundedList, appendStashInventoryWarning, arrayValue, recordValue, textValue } from "./readable-output-values.ts";

function statusPrefix(result: Record<string, unknown>): "[FAIL]" | "[WARN]" | "[GOOD]" {
  if (result.ok === false || result.status === "blocked") return "[FAIL]";
  if (result.status === "planned" || result.status === "planned-partial" || result.status === "partial") return "[WARN]";
  return "[GOOD]";
}

function boolText(goal: Record<string, unknown>, key: string): string {
  return `${key}=${String(goal[key] === true)}`;
}

function formatGoalFlags(goal: Record<string, unknown>): string {
  return [
    boolText(goal, "commitDirty"),
    boolText(goal, "landToBase"),
    boolText(goal, "pushBase"),
    boolText(goal, "cleanupWorktrees"),
    boolText(goal, "cleanupBranches"),
    boolText(goal, "cleanupHygiene"),
  ].join(" ");
}

function formatStep(entry: unknown): string {
  const step = recordValue(entry);
  const result = recordValue(step.result);
  const summary = recordValue(result.summary);
  const lane = textValue(result.lane, "");
  const reason = textValue(step.reason ?? result.reason, "");
  const hygieneTargets = Number(summary.approvedTargetCount ?? arrayValue(result.targets).length);
  const blockers = arrayValue(result.blockers).length || Number(summary.blockedTargetCount ?? 0);
  const details = step.tool === "guardian_hygiene"
    ? ` targets=${hygieneTargets} blockers=${blockers}`
    : lane
      ? ` lane=${lane}`
      : "";
  return `  - ${textValue(step.tool)} status=${textValue(step.status)} ok=${String(step.ok === true)}${details}${reason ? ` reason=${reason}` : ""}`;
}

export function formatGuardianGoalOutput(rawResult: unknown): string {
  const result = recordValue(rawResult);
  const goal = recordValue(result.goal);
  const steps = arrayValue(result.steps);
  const blockers = arrayValue(result.blockers);
  const lines = [
    `${statusPrefix(result)} guardian_goal ${textValue(result.status)}`,
    `[INFO] desired: ${formatGoalFlags(goal)}`,
    `[INFO] steps: ${steps.length} | blockers: ${blockers.length}`,
  ];
  const doneStep = steps.map(recordValue).find((step) => step.tool === "guardian_done" || step.tool === "guardian_finish_workflow");
  const doneResult = recordValue(doneStep?.result);
  const donePreflight = recordValue(doneResult.preflight);
  const doneCleanupPlan = recordValue(doneResult.cleanupPlan);
  const doneCleanupPreflight = recordValue(doneCleanupPlan.preflight);
  appendStashInventoryWarning(lines, donePreflight.stashCount ?? doneResult.stashCount ?? doneCleanupPreflight.stashCount);
  const reason = textValue(result.reason, "");
  if (result.ok === false && reason) lines.push(`[FAIL] ${reason}`);
  if (typeof result.nextAction === "string") lines.push(`[INFO] nextAction: ${result.nextAction}`);
  appendBoundedList({ lines, heading: "[INFO] goal steps", entries: steps, format: formatStep });
  appendBoundedList({ lines, heading: "[WARN] blockers", entries: blockers, format: (entry) => {
    const blocker = recordValue(entry);
    return `  - ${textValue(blocker.tool)}: ${textValue(blocker.reason)}`;
  } });
  for (const step of steps.map(recordValue)) {
    const nested = recordValue(step.result);
    if (Object.keys(nested).length === 0 || (step.tool !== "guardian_done" && step.tool !== "guardian_finish_workflow")) continue;
    lines.push(`[${nested.ok === false || nested.status === "blocked" || nested.status === "partial" || nested.status === "planned-partial" ? "WARN" : "INFO"}] ${textValue(step.tool)} evidence:`);
    appendCleanupEvidence(lines, nested);
    appendReservationRetirementEvidence(lines, nested);
    appendFinalPostflightEvidence(lines, nested.finalPostflight);
  }
  if (typeof result.commit === "string") lines.push(`[INFO] commit: ${result.commit.slice(0, 12)}`);
  return lines.join("\n");
}
