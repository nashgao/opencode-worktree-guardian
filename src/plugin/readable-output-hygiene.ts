import { arrayValue, recordValue, textValue } from "./readable-output-values.ts";

function appendPathList(lines: string[], heading: string, paths: readonly unknown[]): void {
  if (paths.length === 0) return;
  lines.push(heading);
  for (const entry of paths.slice(0, 8)) lines.push(`  - ${textValue(entry, String(entry))}`);
}

function targetCount(plan: Record<string, unknown>): number {
  const report = recordValue(plan.report);
  const approvedTargets = arrayValue(report.approvedTargets);
  if (approvedTargets.length > 0) return approvedTargets.length;
  return arrayValue(plan.targets).length;
}

function blockerCount(plan: Record<string, unknown>): number {
  const blockers = arrayValue(plan.blockers);
  if (blockers.length > 0) return blockers.length;
  return arrayValue(recordValue(plan.report).blockers).length;
}

function appendPlanSummary(lines: string[], label: string, rawPlan: unknown): void {
  const plan = recordValue(rawPlan);
  if (Object.keys(plan).length === 0) return;
  lines.push(`[INFO] ${label}: ${textValue(plan.status)} targets=${targetCount(plan)} blockers=${blockerCount(plan)}`);
}

export function appendDoneHygieneGuidance(lines: string[], result: Record<string, unknown>): void {
  if (result.status !== "blocked-workspace-hygiene-required") return;
  appendPathList(lines, "[INFO] guardian_hygiene candidates:", arrayValue(result.knownCleanablePaths));
  appendPathList(lines, "[INFO] guardian_delete_paths candidates:", arrayValue(result.reviewablePaths));
  appendPathList(lines, "[INFO] ignore candidates:", arrayValue(result.ignoreCandidates));
  appendPathList(lines, "[WARN] manual review candidates:", arrayValue(result.manualReviewCandidates));
  appendPlanSummary(lines, "hygienePlan", result.hygienePlan);
  appendPlanSummary(lines, "deletePathsPlan", result.deletePathsPlan);
  appendPathList(lines, "[INFO] next actions:", arrayValue(result.nextActions));
}
