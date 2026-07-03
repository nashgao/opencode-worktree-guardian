import { arrayValue, recordValue, textValue } from "./readable-output-values.ts";

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
  const reason = textValue(result.reason, "");
  if (result.ok === false && reason) lines.push(`[FAIL] ${reason}`);
  if (typeof result.nextAction === "string") lines.push(`[INFO] nextAction: ${result.nextAction}`);
  if (steps.length > 0) {
    lines.push("[INFO] goal steps:");
    for (const step of steps.slice(0, 8)) lines.push(formatStep(step));
  }
  if (blockers.length > 0) {
    lines.push("[WARN] blockers:");
    for (const entry of blockers.slice(0, 8)) {
      const blocker = recordValue(entry);
      lines.push(`  - ${textValue(blocker.tool)}: ${textValue(blocker.reason)}`);
    }
  }
  if (typeof result.commit === "string") lines.push(`[INFO] commit: ${result.commit.slice(0, 12)}`);
  return lines.join("\n");
}
