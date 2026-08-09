import { appendCleanupEvidence, appendFinalPostflightEvidence } from "./readable-output-evidence.ts";
import { appendReservationRetirementEvidence } from "./readable-output-retirement.ts";
import { appendBoundedList, appendStashInventoryWarning, arrayValue, recordValue, textValue } from "./readable-output-values.ts";
import { sanitizeGoalResidualText } from "../goal-hygiene-postcondition.ts";

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

function appendHygienePostcondition(lines: string[], value: unknown, complete: boolean | null): void {
  const postcondition = recordValue(value);
  if (Object.keys(postcondition).length === 0) return;
  const counts = recordValue(postcondition.residualByCategory);
  const shownFindings = arrayValue(postcondition.residualFindingsShown);
  const residualCount = Number(postcondition.residualCount ?? 0);
  const completeText = complete === null ? "pending" : String(complete);
  lines.push(`[INFO] hygiene mode=${sanitizeGoalResidualText(postcondition.mode)} phase=${sanitizeGoalResidualText(postcondition.phase)} status=${sanitizeGoalResidualText(postcondition.status)} complete=${completeText}`);
  lines.push(`[${residualCount > 0 ? "WARN" : "INFO"}] hygiene residuals: ${residualCount} | known-cleanable=${Number(counts["known-cleanable"] ?? 0)} | nested-git=${Number(counts["nested-git"] ?? 0)} | suspicious=${Number(counts.suspicious ?? 0)}`);
  if (shownFindings.length > 0) {
    lines.push("[WARN] hygiene residual findings:");
    for (const entry of shownFindings.slice(0, 8)) {
      const finding = recordValue(entry);
      lines.push(`  - ${sanitizeGoalResidualText(finding.category)} ${sanitizeGoalResidualText(finding.path)}: ${sanitizeGoalResidualText(finding.reason)}`);
    }
  }
  const omitted = Number(postcondition.residualFindingsOmittedCount ?? 0);
  if (omitted > 0) lines.push(`[WARN] hygiene residual findings omitted: ${omitted}`);
  lines.push(`[INFO] hygiene exclusions: ${Number(postcondition.protectedExclusionCount ?? 0)} | reviewable inventory: ${Number(postcondition.reviewableCandidateCount ?? 0)}`);
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
  appendHygienePostcondition(lines, result.hygienePostcondition, result.complete === null ? null : result.complete === true);
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
