import { appendCleanupResults, appendFinalPostflightEvidence } from "./readable-output-evidence.ts";
import { appendReservationRetirementEvidence } from "./readable-output-retirement.ts";
import { appendBoundedList, appendStashInventoryWarning, arrayValue, recordValue, shortCommit, textValue } from "./readable-output-values.ts";
import { appendPostCompletionHygiene } from "./readable-output-hygiene.ts";

export function formatGuardianFinishWorkflowOutput(rawResult: unknown) {
  const result = recordValue(rawResult);
  const preflight = recordValue(result.preflight);
  const candidates = arrayValue(result.candidates);
  const blockers = arrayValue(result.blockers);
  const remaining = arrayValue(result.remaining);
  const results = arrayValue(result.results);
  const scanStatus = textValue(preflight.candidateScanStatus, "unknown");
  const lines = [
    `${statusPrefix(result)} guardian_finish_workflow ${textValue(result.status)}`,
    `[INFO] mode: ${textValue(preflight.mode)} | branch: ${textValue(preflight.currentBranch)} | baseRef: ${textValue(preflight.baseRef)} | baseRefOid: ${shortCommit(preflight.baseRefOid)}`,
  ];
  if (scanStatus === "completed") {
    lines.push(`[INFO] candidateScan: completed | candidates: ${Number(preflight.candidateCount ?? candidates.length)} | blockers: ${Number(preflight.blockerCount ?? blockers.length)} | maxCandidates: ${Number(preflight.maxCandidateCount ?? 0)} | dirty: ${Number(preflight.dirtyFileCount ?? 0)} | stashes: ${Number(preflight.stashCount ?? 0)}`);
  } else {
    const scanReason = scanStatus === "skipped" ? textValue(preflight.candidateScanSkippedReason) : textValue(preflight.candidateScanFailedReason);
    lines.push(`[WARN] candidateScan: ${scanStatus} | reason: ${scanReason} | maxCandidates: ${Number(preflight.maxCandidateCount ?? 0)} | dirty: ${Number(preflight.dirtyFileCount ?? 0)} | stashes: ${Number(preflight.stashCount ?? 0)}`);
  }
  appendStashInventoryWarning(lines, preflight.stashCount);
  const reason = textValue(result.reason, "");
  if (result.ok === false || reason) lines.push(`[FAIL] ${reason || "guardian_finish_workflow blocked"}`);
  if (typeof result.confirmToken === "string") lines.push(`[WARN] confirmToken: ${result.confirmToken}`);
  appendBoundedList({ lines, heading: "[INFO] cleanup candidates", entries: candidates, format: formatCleanupCandidate, count: preflight.candidateCount });
  appendBoundedList({ lines, heading: "[WARN] cleanup blockers", entries: blockers, format: formatCleanupBlocker, count: preflight.blockerCount });
  appendBoundedList({ lines, heading: "[WARN] remaining repo blockers", entries: remaining, format: formatRemaining });
  appendCleanupResults(lines, results);
  appendReservationRetirementEvidence(lines, result);
  appendFinalPostflightEvidence(lines, result.finalPostflight);
  appendPostCompletionHygiene(lines, result);
  return lines.join("\n");
}

function statusPrefix(result: Record<string, unknown>): "[FAIL]" | "[WARN]" | "[GOOD]" {
  if (result.ok === false) return "[FAIL]";
  return result.status === "planned" || result.status === "planned-partial" ? "[WARN]" : "[GOOD]";
}

function formatCleanupCandidate(entry: unknown): string {
  const candidate = recordValue(entry);
  const abandon = candidate.abandonUnmerged === true ? " abandonUnmerged=true" : "";
  return `  - kind=${textValue(candidate.kind)} targetKind=${textValue(candidate.targetKind)} branch=${textValue(candidate.branch)} path=${textValue(candidate.targetPath)} head=${shortCommit(candidate.head)}${abandon}`;
}

function formatCleanupBlocker(entry: unknown): string {
  const blocker = recordValue(entry);
  return `  - kind=${textValue(blocker.kind)} branch=${textValue(blocker.branch)} path=${textValue(blocker.targetPath)} reason=${textValue(blocker.reason)}`;
}

function formatRemaining(entry: unknown): string {
  const remaining = recordValue(entry);
  const kind = textValue(remaining.kind);
  const branch = textValue(remaining.branch);
  const path = textValue(remaining.targetPath);
  const head = remaining.head ? ` head=${shortCommit(remaining.head)}` : "";
  const reason = textValue(remaining.reason, "");
  return `  - kind=${kind} branch=${branch} path=${path}${head}${reason ? ` reason=${reason}` : ""}`;
}
