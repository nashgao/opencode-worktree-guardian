import { arrayValue, describeEntry, recordValue, shortCommit, textValue } from "./readable-output-values.ts";

function countLine(result: Record<string, unknown>) {
  const counts = [
    ["sessions", arrayValue(result.sessions).length],
    ["worktrees", arrayValue(result.worktrees).length],
    ["orphaned", arrayValue(result.orphanedSessions).length],
    ["poisoned", arrayValue(result.poisonedSessions).length],
    ["dirty", arrayValue(result.dirtyFiles).length],
    ["stashes", arrayValue(result.stashes).length],
    ["safetyRefs", arrayValue(result.safetyRefs).length],
    ["preservedRefs", arrayValue(result.preservedRefs).length],
    ["recoveryCandidates", arrayValue(result.recoveryCandidates).length],
  ];
  return counts.map(([label, count]) => `${label}: ${count}`).join(" | ");
}

export function formatGuardianStatusOutput(name: string, rawResult: unknown) {
  const result = recordValue(rawResult);
  const lines = [
    `${result.ok === false ? "[FAIL]" : "[GOOD]"} ${name} snapshot`,
    `[INFO] repoRoot: ${textValue(result.repoRoot)}`,
    `[INFO] ${countLine(result)}`,
  ];
  const reason = textValue(result.reason, "");
  if (result.ok === false || reason) lines.push(`[FAIL] ${reason || "guardian tool reported failure"}`);
  const warningSections = [
    ["orphaned sessions", result.orphanedSessions],
    ["poisoned sessions", result.poisonedSessions],
    ["worktrees without state", result.worktreesWithoutState],
    ["state branches without worktrees", result.stateBranchesWithoutWorktrees],
    ["dirty files", result.dirtyFiles],
    ["stashes", result.stashes],
  ];
  for (const [label, value] of warningSections) {
    const entries = arrayValue(value);
    if (entries.length > 0) {
      lines.push(`[WARN] ${label}: ${entries.length}`);
      for (const entry of entries.slice(0, 8)) lines.push(`  - ${describeEntry(entry)}`);
    }
  }
  const activeSessions = arrayValue(result.activeSessions);
  const terminalSessions = arrayValue(result.terminalSessions);
  const sessions = arrayValue(result.sessions);
  const visibleActiveSessions = activeSessions.length > 0 ? activeSessions : sessions.filter((entry) => recordValue(entry).status === "active");
  lines.push(`[INFO] active sessions: ${visibleActiveSessions.length}`);
  for (const entry of visibleActiveSessions.slice(0, 12)) {
    const session = recordValue(entry);
    lines.push(`  - session_id=${textValue(session.session_id ?? session.sessionId)} status=${textValue(session.status)} branch=${textValue(session.branch)} worktree_path=${textValue(session.worktree_path ?? session.worktreePath)} head=${shortCommit(session.head_commit ?? session.headCommit)}`);
  }
  lines.push(`[INFO] terminal sessions: ${terminalSessions.length}`);
  for (const entry of terminalSessions.slice(0, 12)) {
    const session = recordValue(entry);
    lines.push(`  - session_id=${textValue(session.session_id ?? session.sessionId)} status=${textValue(session.status)} branch=${textValue(session.branch)} worktree_path=${textValue(session.worktree_path ?? session.worktreePath)} head=${shortCommit(session.head_commit ?? session.headCommit)}`);
  }
  const worktrees = arrayValue(result.worktrees);
  lines.push(`[INFO] worktrees: ${worktrees.length}`);
  for (const entry of worktrees.slice(0, 12)) {
    const worktree = recordValue(entry);
    const markers = [worktree.detached === true ? "detached" : "", worktree.bare === true ? "bare" : ""].filter(Boolean).join(",");
    lines.push(`  - branch=${textValue(worktree.branch)} head=${shortCommit(worktree.head ?? worktree.head_commit ?? worktree.headCommit)} path=${textValue(worktree.path ?? worktree.worktree_path ?? worktree.worktreePath)}${markers ? ` markers=${markers}` : ""}`);
  }
  const recoveryCandidates = arrayValue(result.recoveryCandidates);
  if (recoveryCandidates.length > 0) {
    lines.push(`[INFO] recovery candidates: ${recoveryCandidates.length}`);
    for (const entry of recoveryCandidates.slice(0, 12)) lines.push(`  - ${describeEntry(entry)}`);
  }
  const suggestions = arrayValue(result.suggestedCommands);
  if (suggestions.length > 0) {
    lines.push("[INFO] suggested commands:");
    for (const command of suggestions) lines.push(`  - ${textValue(command, String(command))}`);
  }
  return lines.join("\n");
}

export function formatGuardianReportOutput(rawResult: unknown) {
  const result = recordValue(rawResult);
  const status = recordValue(result.status);
  const recover = recordValue(result.recover);
  return [
    `${result.ok === false ? "[FAIL]" : "[GOOD]"} guardian_report_html wrote offline report`,
    `[INFO] reportPath: ${textValue(result.reportPath)}`,
    `[INFO] repoRoot: ${textValue(status.repoRoot)}`,
    `[INFO] sessions: ${arrayValue(status.sessions).length} | worktrees: ${arrayValue(status.worktrees).length} | risks: ${arrayValue(status.orphanedSessions).length + arrayValue(status.worktreesWithoutState).length + arrayValue(status.dirtyFiles).length + arrayValue(status.stashes).length} | recoveryCandidates: ${arrayValue(recover.recoveryCandidates).length}`,
  ].join("\n");
}
