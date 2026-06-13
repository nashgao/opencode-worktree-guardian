import { arrayValue, recordValue, shortCommit, textValue } from "./readable-output-values.ts";

export function formatGuardianFinishWorkflowOutput(rawResult: unknown) {
  const result = recordValue(rawResult);
  const preflight = recordValue(result.preflight);
  const candidates = arrayValue(result.candidates);
  const blockers = arrayValue(result.blockers);
  const results = arrayValue(result.results);
  const lines = [
    `${result.ok === false ? "[FAIL]" : result.status === "planned" ? "[WARN]" : "[GOOD]"} guardian_finish_workflow ${textValue(result.status)}`,
    `[INFO] mode: ${textValue(preflight.mode)} | branch: ${textValue(preflight.currentBranch)} | baseRef: ${textValue(preflight.baseRef)} | baseRefOid: ${shortCommit(preflight.baseRefOid)}`,
    `[INFO] candidates: ${candidates.length} | blockers: ${blockers.length} | maxCandidates: ${Number(preflight.maxCandidateCount ?? 0)} | dirty: ${Number(preflight.dirtyFileCount ?? 0)} | stashes: ${Number(preflight.stashCount ?? 0)}`,
  ];
  const reason = textValue(result.reason, "");
  if (result.ok === false || reason) lines.push(`[FAIL] ${reason || "guardian_finish_workflow blocked"}`);
  if (typeof result.confirmToken === "string") lines.push(`[WARN] confirmToken: ${result.confirmToken}`);
  if (candidates.length > 0) {
    lines.push("[INFO] cleanup candidates:");
    for (const entry of candidates.slice(0, 8)) {
      const candidate = recordValue(entry);
      lines.push(`  - kind=${textValue(candidate.kind)} targetKind=${textValue(candidate.targetKind)} branch=${textValue(candidate.branch)} path=${textValue(candidate.targetPath)} head=${shortCommit(candidate.head)}`);
    }
  }
  if (blockers.length > 0) {
    lines.push("[WARN] cleanup blockers:");
    for (const entry of blockers.slice(0, 8)) {
      const blocker = recordValue(entry);
      lines.push(`  - kind=${textValue(blocker.kind)} branch=${textValue(blocker.branch)} path=${textValue(blocker.targetPath)} reason=${textValue(blocker.reason)}`);
    }
  }
  if (results.length > 0) {
    lines.push("[INFO] cleanup results:");
    for (const entry of results.slice(0, 8)) {
      const item = recordValue(entry);
      lines.push(`  - status=${textValue(item.status)} branch=${textValue(item.branch)} worktreeRemoved=${String(item.worktreeRemoved === true)} branchDeleted=${String(item.branchDeleted === true)}`);
    }
  }
  return lines.join("\n");
}

export function formatGuardianDoneOutput(rawResult: unknown) {
  const result = recordValue(rawResult);
  const preflight = recordValue(result.preflight);
  const cleanupPlan = recordValue(result.cleanupPlan);
  const dirtySnapshot = recordValue(result.dirtySnapshot);
  const dirtyPaths = arrayValue(dirtySnapshot.paths ?? preflight.dirtyFiles);
  const lines = [
    `${result.ok === false ? "[FAIL]" : result.status === "planned" ? "[WARN]" : "[GOOD]"} guardian_done ${textValue(result.status)}`,
    `[INFO] lane: ${textValue(result.lane)} | branch: ${textValue(preflight.currentBranch ?? result.branch)} | baseBranch: ${textValue(preflight.baseBranch)}`,
    `[INFO] dirty: ${dirtyPaths.length} | stashes: ${Number(preflight.stashCount ?? 0)} | safetyRef: ${textValue(result.safetyRef)}`,
  ];
  const reason = textValue(result.reason, "");
  if (result.ok === false || reason) lines.push(`[FAIL] ${reason || "guardian_done blocked"}`);
  if (typeof result.nextAction === "string") lines.push(`[INFO] nextAction: ${result.nextAction}`);
  if (typeof result.commitMessage === "string") lines.push(`[INFO] commitMessage: ${result.commitMessage}`);
  if (typeof result.commit === "string") lines.push(`[INFO] commit: ${shortCommit(result.commit)}`);
  if (dirtyPaths.length > 0) {
    lines.push("[INFO] dirty files:");
    for (const entry of dirtyPaths.slice(0, 8)) lines.push(`  - ${textValue(entry, String(entry))}`);
  }
  if (Object.keys(cleanupPlan).length > 0) {
    lines.push(`[INFO] cleanupPlan: ${textValue(cleanupPlan.status)} candidates=${arrayValue(cleanupPlan.candidates).length} blockers=${arrayValue(cleanupPlan.blockers).length}`);
  }
  const suggestions = arrayValue(result.suggestedCommands);
  if (suggestions.length > 0) {
    lines.push("[INFO] suggested commands:");
    for (const command of suggestions.slice(0, 8)) lines.push(`  - ${textValue(command, String(command))}`);
  }
  return lines.join("\n");
}
