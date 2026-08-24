import { appendCleanupResults, appendFinalPostflightEvidence } from "./readable-output-evidence.ts";
import { appendReservationRetirementEvidence, formatCleanupSweepSummary } from "./readable-output-retirement.ts";
import { appendBoundedList, appendStashInventoryWarning, arrayValue, recordValue, shortCommit, textValue } from "./readable-output-values.ts";
import { appendDoneHygieneGuidance, appendPostCompletionHygiene } from "./readable-output-hygiene.ts";

function statusPrefix(result: Record<string, unknown>): "[FAIL]" | "[WARN]" | "[GOOD]" {
  if (result.ok === false) return "[FAIL]";
  return result.status === "planned" || result.status === "planned-partial" ? "[WARN]" : "[GOOD]";
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

function formatDoneAllRemaining(entry: unknown): string {
  const remaining = recordValue(entry);
  if (remaining.session_id !== undefined || remaining.disposition !== undefined || remaining.status !== undefined) return formatDoneAllSession(entry);
  const kind = textValue(remaining.kind);
  const branch = textValue(remaining.branch);
  const path = textValue(remaining.targetPath);
  const head = remaining.head ? ` head=${shortCommit(remaining.head)}` : "";
  const reason = textValue(remaining.reason, "");
  return `  - kind=${kind} branch=${branch} path=${path}${head}${reason ? ` reason=${reason}` : ""}`;
}

function formatCleanupPlanEntry(entry: unknown): string {
  const item = recordValue(entry);
  const kind = textValue(item.kind);
  const targetKind = textValue(item.targetKind);
  const branch = textValue(item.branch);
  const path = textValue(item.targetPath);
  const head = item.head ? ` head=${shortCommit(item.head)}` : "";
  const abandon = item.abandonUnmerged === true ? " abandonUnmerged=true" : "";
  const reason = textValue(item.reason, "");
  return `  - kind=${kind} targetKind=${targetKind} branch=${branch} path=${path}${head}${abandon}${reason ? ` reason=${reason}` : ""}`;
}

function formatDirtyTarget(entry: unknown): string {
  const target = recordValue(entry);
  const targetKind = textValue(target.targetKind);
  const session = textValue(target.sessionId, "");
  const branch = textValue(target.branch);
  const worktree = textValue(target.worktreePath);
  const dirtyCount = arrayValue(target.dirtyFiles).length;
  return `  - target=${targetKind}${session ? ` session=${session}` : ""} branch=${branch} path=${worktree} dirty=${dirtyCount}`;
}

function formatGuardianDoneAllOutput(result: Record<string, unknown>) {
  const summary = recordValue(result.summary);
  const sessions = arrayValue(result.sessions);
  const finishable = sessions.filter((entry) => textValue(recordValue(entry).disposition) === "finishable");
  const remaining = arrayValue(result.remaining);
  const results = arrayValue(result.results);
  const cleanupPlan = recordValue(result.cleanupPlan);
  const cleanupPreflight = recordValue(cleanupPlan.preflight);
  const cleanupCandidates = arrayValue(cleanupPlan.candidates);
  const cleanupBlockers = arrayValue(cleanupPlan.blockers);
  const lines = [
    `${statusPrefix(result)} guardian_done ${textValue(result.status)}`,
    `[INFO] lane: done-all | summary: ${formatDoneAllSummary(summary)}`,
  ];
  appendStashInventoryWarning(lines, result.stashCount ?? cleanupPreflight.stashCount);
  const reason = textValue(result.reason, "");
  if (result.ok === false) lines.push(`[FAIL] ${reason || "guardian_done blocked"}`);
  else if (reason) lines.push(`[INFO] ${reason}`);
  if (typeof result.confirmToken === "string") lines.push(`[WARN] confirmToken: ${result.confirmToken}`);
  if (typeof result.nextAction === "string") lines.push(`[INFO] nextAction: ${textValue(result.nextAction)}`);
  if (typeof result.baseRef === "string") lines.push(`[INFO] baseRef: ${result.baseRef} | baseRefOid: ${shortCommit(result.baseRefOid)}`);
  if (Object.keys(cleanupPlan).length > 0) {
    lines.push(`[INFO] cleanupPlan: ${textValue(cleanupPlan.status)} candidates=${cleanupCandidates.length} blockers=${cleanupBlockers.length}`);
  }
  appendBoundedList({ lines, heading: "[INFO] cleanup candidates", entries: cleanupCandidates, format: formatCleanupPlanEntry });
  appendBoundedList({ lines, heading: "[WARN] cleanup blockers", entries: cleanupBlockers, format: formatCleanupPlanEntry });
  appendBoundedList({ lines, heading: "[INFO] finishable sessions", entries: finishable, format: formatDoneAllSession });
  appendBoundedList({ lines, heading: "[INFO] finish results", entries: results, format: formatDoneAllSession });
  appendBoundedList({ lines, heading: "[WARN] remaining repo blockers", entries: remaining, format: formatDoneAllRemaining });
  const mainSync = recordValue(result.mainSync);
  if (Object.keys(mainSync).length > 0) {
    lines.push(`[INFO] mainSync: ok=${String(mainSync.ok === true)} baseBranch=${textValue(mainSync.baseBranch)} fastForwarded=${String(mainSync.fastForwarded === true)} alreadySynced=${String(mainSync.alreadySynced === true)} reason=${textValue(mainSync.reason, "")}`);
  }
  const cleanupSweep = recordValue(result.cleanupSweep);
  if (Object.keys(cleanupSweep).length > 0) {
    lines.push(formatCleanupSweepSummary(cleanupSweep));
  }
  const hint = textValue(result.remainingHint, "");
  if (hint) lines.push(`[WARN] ${hint}`);
  appendReservationRetirementEvidence(lines, result);
  appendFinalPostflightEvidence(lines, result.finalPostflight);
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
    const candidates = arrayValue(result.candidates);
    const lines = [
      "[WARN] guardian_done needs target selection",
      `[INFO] ${textValue(result.reason, "no Guardian session matched the current location")}`,
      `[INFO] active feature sessions: ${sessions.length}`,
    ];
    appendBoundedList({ lines, heading: "[INFO] dirty target candidates", entries: candidates, format: formatDirtyTarget });
    appendBoundedList({
      lines,
      heading: "[INFO] active feature sessions",
      entries: sessions,
      format: (entry) => {
      const session = recordValue(entry);
        return `  - branch=${textValue(session.branch)} session=${textValue(session.session_id)} head=${shortCommit(session.head)} path=${textValue(session.worktree_path)}`;
      },
    });
    const commands = arrayValue(result.suggestedCommands);
    appendBoundedList({ lines, heading: "[INFO] finish one with", entries: commands, format: (command) => `  - ${textValue(command, String(command))}` });
    return lines.join("\n");
  }
  const preflight = recordValue(result.preflight);
  const cleanupPlan = recordValue(result.cleanupPlan);
  const cleanup = recordValue(result.cleanup);
  const candidates = arrayValue(result.candidates);
  const results = arrayValue(result.results);
  const pr = recordValue(result.pr);
  const dirtySnapshot = recordValue(result.dirtySnapshot);
  const selectedTarget = recordValue(result.selectedTarget);
  const dirtyPaths = arrayValue(dirtySnapshot.paths ?? preflight.dirtyFiles ?? result.dirtyFiles);
  const stashCount = preflight.stashCount ?? result.stashCount;
  const branch = preflight.currentBranch ?? result.branch;
  const baseBranch = preflight.baseBranch ?? result.baseBranch;
  const lines = [
    `${statusPrefix(result)} guardian_done ${textValue(result.status)}`,
    `[INFO] lane: ${textValue(result.lane)} | branch: ${textValue(branch)} | baseBranch: ${textValue(baseBranch)}`,
    `[INFO] dirty: ${dirtyPaths.length} | stashes: ${Number(stashCount ?? 0)} | safetyRef: ${textValue(result.safetyRef)}`,
  ];
  appendStashInventoryWarning(lines, stashCount);
  const reason = textValue(result.reason, "");
  if (result.ok === false || reason) lines.push(`[FAIL] ${reason || "guardian_done blocked"}`);
  if (typeof result.nextAction === "string") lines.push(`[INFO] nextAction: ${textValue(result.nextAction)}`);
  if (Object.keys(selectedTarget).length > 0) {
    lines.push(`[INFO] selectedTarget: ${textValue(selectedTarget.targetKind)} session=${textValue(selectedTarget.sessionId)} branch=${textValue(selectedTarget.branch)} path=${textValue(selectedTarget.worktreePath)} dirty=${arrayValue(selectedTarget.dirtyFiles).length}`);
  }
  if (typeof result.worktreePath === "string") lines.push(`[INFO] worktree: ${textValue(result.worktreePath)}`);
  if (typeof result.head === "string") lines.push(`[INFO] head: ${shortCommit(result.head)}`);
  if (Object.keys(pr).length > 0) lines.push(`[INFO] pr: #${textValue(pr.number)} ${textValue(pr.url)} created=${String(result.prCreated === true)} adminBypass=${String(result.adminBypass === true)}`);
  if (Object.keys(cleanup).length > 0) lines.push(`[INFO] cleanup: ${textValue(cleanup.status)} worktreeRemoved=${String(cleanup.worktreeRemoved === true)} branchDeleted=${String(cleanup.branchDeleted === true)}`);
  const mainSync = recordValue(result.mainSync);
  if (Object.keys(mainSync).length > 0) lines.push(`[INFO] mainSync: ok=${String(mainSync.ok === true)} baseBranch=${textValue(mainSync.baseBranch)} fastForwarded=${String(mainSync.fastForwarded === true)} alreadySynced=${String(mainSync.alreadySynced === true)} reason=${textValue(mainSync.reason, "")}`);
  const cleanupSweep = recordValue(result.cleanupSweep);
  if (Object.keys(cleanupSweep).length > 0) lines.push(formatCleanupSweepSummary(cleanupSweep));
  if (typeof result.commitMessage === "string") lines.push(`[INFO] commitMessage: ${textValue(result.commitMessage)}`);
  if (typeof result.commit === "string") lines.push(`[INFO] commit: ${shortCommit(result.commit)}`);
  appendBoundedList({ lines, heading: "[INFO] dirty files", entries: dirtyPaths, format: (entry) => `  - ${textValue(entry, String(entry))}` });
  appendDoneHygieneGuidance(lines, result);
  appendPostCompletionHygiene(lines, result);
  if (Object.keys(cleanupPlan).length > 0) {
    lines.push(`[INFO] cleanupPlan: ${textValue(cleanupPlan.status)} candidates=${arrayValue(cleanupPlan.candidates).length} blockers=${arrayValue(cleanupPlan.blockers).length}`);
  }
  appendBoundedList({ lines, heading: "[INFO] cleanup candidates", entries: candidates, format: formatCleanupPlanEntry });
  appendCleanupResults(lines, results);
  const suggestions = arrayValue(result.suggestedCommands);
  appendBoundedList({ lines, heading: "[INFO] suggested commands", entries: suggestions, format: (command) => `  - ${textValue(command, String(command))}` });
  const available = arrayValue(result.availableSessions);
  appendBoundedList({
    lines,
    heading: "[INFO] active feature sessions you can finish",
    entries: available,
    format: (entry) => {
      const session = recordValue(entry);
      return `  - branch=${textValue(session.branch)} session=${textValue(session.session_id)} path=${textValue(session.worktree_path)}`;
    },
  });
  appendReservationRetirementEvidence(lines, result);
  appendFinalPostflightEvidence(lines, result.finalPostflight);
  return lines.join("\n");
}
