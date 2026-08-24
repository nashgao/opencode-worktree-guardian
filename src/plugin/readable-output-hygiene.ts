import { appendBoundedList, arrayValue, recordValue, textValue } from "./readable-output-values.ts";

function appendPathList(lines: string[], heading: string, paths: readonly unknown[]): void {
  if (paths.length === 0) return;
  appendBoundedList({ lines, heading, entries: paths, format: (entry) => `  - ${textValue(entry, String(entry))}` });
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

export function appendPostCompletionHygiene(lines: string[], result: Record<string, unknown>): void {
  const postCompletionHygiene = recordValue(result.postCompletionHygiene);
  if (Object.keys(postCompletionHygiene).length === 0) return;
  const inventory = recordValue(postCompletionHygiene.inventory);
  const summary = recordValue(inventory.summary);
  const findings = arrayValue(inventory.findings);
  const reviewableCandidates = arrayValue(inventory.reviewableCandidates);
  const emptyDirectories = arrayValue(inventory.filesystemOnlyEmptyDirectories);
  const scanComplete = summary.filesystemOnlyEmptyDirectoryScanComplete === true;
  lines.push(`[INFO] post-completion hygiene: ${textValue(postCompletionHygiene.status)}`);
  lines.push(`[INFO] findings: ${Number(summary.findingCount ?? findings.length)} | reviewable: ${Number(summary.reviewableCandidateCount ?? reviewableCandidates.length)} | filesystem-only empty directories: ${Number(summary.filesystemOnlyEmptyDirectoryCount ?? emptyDirectories.length)} | omitted: ${scanComplete ? 0 : "coverage-incomplete"}`);
  if (!scanComplete) lines.push("[FAIL] post-completion hygiene inventory is incomplete");
  for (const entry of findings) {
    const finding = recordValue(entry);
    lines.push(`  - finding ${textValue(finding.category)} ${textValue(finding.path)}: ${textValue(finding.reason)}`);
  }
  for (const entry of reviewableCandidates) {
    const candidate = recordValue(entry);
    lines.push(`  - reviewable ${textValue(candidate.status)} ${textValue(candidate.path)} (${Number(candidate.fileCount ?? 1)} files): ${textValue(candidate.reason)}`);
  }
  for (const entry of emptyDirectories) {
    const directory = recordValue(entry);
    lines.push(`  - empty-directory ${textValue(directory.classification)} ${textValue(directory.path)}: ${textValue(directory.reason)}`);
  }
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
