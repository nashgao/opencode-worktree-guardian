import { arrayValue, recordValue, shortCommit, textValue } from "./readable-output-values.ts";

export function formatGuardianFinishWorkflowOutput(rawResult: unknown) {
  const result = recordValue(rawResult);
  const preflight = recordValue(result.preflight);
  const candidates = arrayValue(result.candidates);
  const blockers = arrayValue(result.blockers);
  const results = arrayValue(result.results);
  const scanStatus = textValue(preflight.candidateScanStatus, "unknown");
  const lines = [
    `${result.ok === false ? "[FAIL]" : result.status === "planned" ? "[WARN]" : "[GOOD]"} guardian_finish_workflow ${textValue(result.status)}`,
    `[INFO] mode: ${textValue(preflight.mode)} | branch: ${textValue(preflight.currentBranch)} | baseRef: ${textValue(preflight.baseRef)} | baseRefOid: ${shortCommit(preflight.baseRefOid)}`,
  ];
  if (scanStatus === "completed") {
    lines.push(`[INFO] candidateScan: completed | candidates: ${Number(preflight.candidateCount ?? candidates.length)} | blockers: ${Number(preflight.blockerCount ?? blockers.length)} | maxCandidates: ${Number(preflight.maxCandidateCount ?? 0)} | dirty: ${Number(preflight.dirtyFileCount ?? 0)} | stashes: ${Number(preflight.stashCount ?? 0)}`);
  } else {
    const scanReason = scanStatus === "skipped" ? textValue(preflight.candidateScanSkippedReason) : textValue(preflight.candidateScanFailedReason);
    lines.push(`[WARN] candidateScan: ${scanStatus} | reason: ${scanReason} | maxCandidates: ${Number(preflight.maxCandidateCount ?? 0)} | dirty: ${Number(preflight.dirtyFileCount ?? 0)} | stashes: ${Number(preflight.stashCount ?? 0)}`);
  }
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

function formatDoneAllSummary(summary: Record<string, unknown>): string {
  const keys = ["total", "finishable", "dirtySkipped", "blocked", "finished", "failed"];
  return keys
    .filter((key) => summary[key] !== undefined)
    .map((key) => `${key}=${Number(summary[key] ?? 0)}`)
    .join(" ");
}

function formatDoneAllSession(entry: unknown): string {
  const session = recordValue(entry);
  const id = textValue(session.session_id);
  const branch = textValue(session.branch);
  const status = textValue(session.status ?? session.disposition);
  const reason = textValue(session.reason, "");
  const head = session.head ? ` head=${shortCommit(session.head)}` : "";
  return `  - session=${id} branch=${branch} status=${status}${head}${reason ? ` reason=${reason}` : ""}`;
}

function formatGuardianDoneAllOutput(result: Record<string, unknown>) {
  const summary = recordValue(result.summary);
  const sessions = arrayValue(result.sessions);
  const finishable = sessions.filter((entry) => textValue(recordValue(entry).disposition) === "finishable");
  const remaining = arrayValue(result.remaining);
  const results = arrayValue(result.results);
  const lines = [
    `${result.ok === false ? "[FAIL]" : result.status === "planned" ? "[WARN]" : "[GOOD]"} guardian_done ${textValue(result.status)}`,
    `[INFO] lane: done-all | summary: ${formatDoneAllSummary(summary)}`,
  ];
  const reason = textValue(result.reason, "");
  if (result.ok === false) lines.push(`[FAIL] ${reason || "guardian_done all=true blocked"}`);
  else if (reason) lines.push(`[INFO] ${reason}`);
  if (typeof result.confirmToken === "string") lines.push(`[WARN] confirmToken: ${result.confirmToken}`);
  if (typeof result.nextAction === "string") lines.push(`[INFO] nextAction: ${result.nextAction}`);
  if (typeof result.baseRef === "string") lines.push(`[INFO] baseRef: ${result.baseRef} | baseRefOid: ${shortCommit(result.baseRefOid)}`);
  if (finishable.length > 0) {
    lines.push("[INFO] finishable sessions:");
    for (const entry of finishable.slice(0, 8)) lines.push(formatDoneAllSession(entry));
  }
  if (results.length > 0) {
    lines.push("[INFO] finish results:");
    for (const entry of results.slice(0, 8)) lines.push(formatDoneAllSession(entry));
  }
  if (remaining.length > 0) {
    lines.push("[WARN] dirty or blocked sessions:");
    for (const entry of remaining.slice(0, 8)) lines.push(formatDoneAllSession(entry));
  }
  const hint = textValue(result.remainingHint, "");
  if (hint) lines.push(`[WARN] ${hint}`);
  return lines.join("\n");
}

export function formatGuardianDoneOutput(rawResult: unknown) {
  const result = recordValue(rawResult);
  if (result.lane === "done-all") return formatGuardianDoneAllOutput(result);
  if (result.ok !== false && result.status === "no-op" && result.lane === "already-preserved") {
    const lines = [
      "[GOOD] guardian_done no-op: session already preserved",
      `[INFO] branch: ${textValue(result.branch)}`,
      `[INFO] commit: ${textValue(result.commit)}`,
      `[INFO] safetyRef: ${textValue(result.safetyRef)}`,
    ];
    const untracked = Number(result.localUntrackedFileCount ?? 0);
    if (untracked > 0) lines.push(`[INFO] local untracked files remain by user choice: ${untracked}`);
    return lines.join("\n");
  }
  if (result.status === "needs-selection" || result.lane === "select-session") {
    const sessions = arrayValue(result.availableSessions);
    const lines = [
      "[WARN] guardian_done needs a session selection",
      `[INFO] ${textValue(result.reason, "no Guardian session matched the current location")}`,
      `[INFO] active feature sessions: ${sessions.length}`,
    ];
    for (const entry of sessions.slice(0, 8)) {
      const session = recordValue(entry);
      lines.push(`  - branch=${textValue(session.branch)} session=${textValue(session.session_id)} head=${shortCommit(session.head)} path=${textValue(session.worktree_path)}`);
    }
    const commands = arrayValue(result.suggestedCommands);
    if (commands.length > 0) {
      lines.push("[INFO] finish one with:");
      for (const command of commands.slice(0, 8)) lines.push(`  - ${textValue(command, String(command))}`);
    }
    return lines.join("\n");
  }
  const preflight = recordValue(result.preflight);
  const cleanupPlan = recordValue(result.cleanupPlan);
  const cleanup = recordValue(result.cleanup);
  const pr = recordValue(result.pr);
  const dirtySnapshot = recordValue(result.dirtySnapshot);
  const dirtyPaths = arrayValue(dirtySnapshot.paths ?? preflight.dirtyFiles);
  const branch = preflight.currentBranch ?? result.branch;
  const baseBranch = preflight.baseBranch ?? result.baseBranch;
  const lines = [
    `${result.ok === false ? "[FAIL]" : result.status === "planned" ? "[WARN]" : "[GOOD]"} guardian_done ${textValue(result.status)}`,
    `[INFO] lane: ${textValue(result.lane)} | branch: ${textValue(branch)} | baseBranch: ${textValue(baseBranch)}`,
    `[INFO] dirty: ${dirtyPaths.length} | stashes: ${Number(preflight.stashCount ?? 0)} | safetyRef: ${textValue(result.safetyRef)}`,
  ];
  const reason = textValue(result.reason, "");
  if (result.ok === false || reason) lines.push(`[FAIL] ${reason || "guardian_done blocked"}`);
  if (typeof result.nextAction === "string") lines.push(`[INFO] nextAction: ${result.nextAction}`);
  if (typeof result.worktreePath === "string") lines.push(`[INFO] worktree: ${result.worktreePath}`);
  if (typeof result.head === "string") lines.push(`[INFO] head: ${shortCommit(result.head)}`);
  if (Object.keys(pr).length > 0) lines.push(`[INFO] pr: #${textValue(pr.number)} ${textValue(pr.url)} created=${String(result.prCreated === true)} adminBypass=${String(result.adminBypass === true)}`);
  if (Object.keys(cleanup).length > 0) lines.push(`[INFO] cleanup: ${textValue(cleanup.status)} worktreeRemoved=${String(cleanup.worktreeRemoved === true)} branchDeleted=${String(cleanup.branchDeleted === true)}`);
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
  const available = arrayValue(result.availableSessions);
  if (available.length > 0) {
    lines.push("[INFO] active feature sessions you can finish:");
    for (const entry of available.slice(0, 8)) {
      const session = recordValue(entry);
      lines.push(`  - branch=${textValue(session.branch)} session=${textValue(session.session_id)} path=${textValue(session.worktree_path)}`);
    }
  }
  return lines.join("\n");
}
