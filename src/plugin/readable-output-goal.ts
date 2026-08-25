import { appendCleanupEvidence, appendFinalPostflightEvidence } from "./readable-output-evidence.ts";
import { appendReservationRetirementEvidence } from "./readable-output-retirement.ts";
import { appendBoundedList, appendStashInventoryWarning, arrayValue, recordValue, shortCommit, textValue } from "./readable-output-values.ts";
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
  const protectedInventory = recordValue(postcondition.protectedInventory);
  const shownFindings = arrayValue(postcondition.residualFindingsShown);
  const shownReviewables = arrayValue(postcondition.reviewableCandidatesShown);
  const residualCount = Number(postcondition.residualCount ?? 0);
  const reviewableCount = Number(postcondition.reviewableCandidateCount ?? 0);
  const completeText = complete === null ? "pending" : String(complete);
  lines.push(`[INFO] hygiene mode=${sanitizeGoalResidualText(postcondition.mode)} phase=${sanitizeGoalResidualText(postcondition.phase)} status=${sanitizeGoalResidualText(postcondition.status)} complete=${completeText}`);
  lines.push(`[${residualCount > 0 ? "WARN" : "INFO"}] hygiene residuals: ${residualCount} | known-cleanable=${Number(counts["known-cleanable"] ?? 0)} | nested-git=${Number(counts["nested-git"] ?? 0)} | suspicious=${Number(counts.suspicious ?? 0)}`);
  if (shownFindings.length > 0) {
    appendBoundedList({
      lines,
      heading: "[WARN] hygiene residual findings",
      entries: shownFindings,
      count: postcondition.residualFindingCount ?? residualCount,
      format: (entry) => {
      const finding = recordValue(entry);
        return `  - ${sanitizeGoalResidualText(finding.category)} ${sanitizeGoalResidualText(finding.path)}: ${sanitizeGoalResidualText(finding.reason)}`;
      },
    });
  }
  if (reviewableCount > 0) {
    appendBoundedList({
      lines,
      heading: "[WARN] hygiene reviewable candidates",
      entries: shownReviewables,
      count: reviewableCount,
      format: (entry) => {
        const candidate = recordValue(entry);
        const fileCount = Number(candidate.fileCount ?? 0);
        const bytes = Number(candidate.bytes ?? 0);
        const bytesSuffix = candidate.bytesTruncated === true ? `${bytes}+` : String(bytes);
        return `  - ${sanitizeGoalResidualText(candidate.status)} ${sanitizeGoalResidualText(candidate.path)} (${fileCount} file${fileCount === 1 ? "" : "s"}, ${bytesSuffix} bytes): ${sanitizeGoalResidualText(candidate.reason)}\n    next: ${sanitizeGoalResidualText(candidate.suggestedDeletePathCommand)}`;
      },
    });
    lines.push(`[INFO] reviewable digest: ${sanitizeGoalResidualText(postcondition.reviewableDigest)}`);
    lines.push("[INFO] reviewable resolution: add intentional paths to protectedPaths, move retained evidence under a configured protected path (.omo/evidence when .omo is protected), or use the exact guardian_delete_paths mode=plan command above");
  }
  if (postcondition.reviewableInventoryComplete === false) lines.push("[WARN] hygiene inventory coverage is incomplete; strict residue completion remains partial");
  lines.push(`[INFO] hygiene exclusions: ${Number(postcondition.protectedExclusionCount ?? 0)} | reviewable inventory: ${reviewableCount}`);
  const protectedRootCount = Number(protectedInventory.rootCount ?? 0);
  if (protectedRootCount > 0) {
    const protectedBytes = Number(protectedInventory.totalBytes ?? 0);
    lines.push(`[WARN] protected inventory: ${protectedRootCount} root${protectedRootCount === 1 ? "" : "s"} | files=${Number(protectedInventory.fileCount ?? 0)} | directories=${Number(protectedInventory.directoryCount ?? 0)} | bytes=${protectedBytes}${protectedInventory.bytesTruncated === true ? "+" : ""} | assessment=not-assessed | cleanup-authorized=false`);
  }
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
  if (typeof result.nextAction === "string") lines.push(`[INFO] nextAction: ${textValue(result.nextAction)}`);
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
  if (typeof result.commit === "string") lines.push(`[INFO] commit: ${shortCommit(result.commit)}`);
  return lines.join("\n");
}
