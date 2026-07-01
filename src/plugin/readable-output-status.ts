import { computeGuardianVerdict } from "../verdict.ts";
import { TERMINAL_SESSION_STATUSES, TERMINAL_SESSION_STATUS_VALUES } from "../lifecycle.ts";
import { arrayValue, describeEntry, recordValue, shortCommit, textValue } from "./readable-output-values.ts";

function operationalLine(result: Record<string, unknown>, activeSessionCount: number) {
  return [
    `Active sessions: ${activeSessionCount}`,
    `Worktrees: ${arrayValue(result.worktrees).length}`,
    `Dirty files: ${arrayValue(result.dirtyFiles).length}`,
    `Stashes: ${arrayValue(result.stashes).length}`,
    `Orphaned sessions: ${arrayValue(result.orphanedSessions).length}`,
    `Poisoned sessions: ${arrayValue(result.poisonedSessions).length}`,
    `Recovery candidates: ${arrayValue(result.recoveryCandidates).length}`,
  ];
}

function terminalHistoryLines(terminalSessions: readonly unknown[], result: Record<string, unknown>) {
  const counts = new Map<string, number>();
  for (const entry of terminalSessions) {
    const status = textValue(recordValue(entry).status, "unknown");
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const knownParts: string[] = [];
  for (const status of TERMINAL_SESSION_STATUS_VALUES) {
    const count = counts.get(status) ?? 0;
    if (count > 0) knownParts.push(`${status}: ${count}`);
  }
  const unknownParts = [...counts.entries()]
    .filter(([status]) => !TERMINAL_SESSION_STATUSES.has(status))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}: ${count}`);
  return [
    `Retained terminal sessions: ${terminalSessions.length}`,
    ...knownParts,
    ...unknownParts,
    `Safety refs: ${arrayValue(result.safetyRefs).length}`,
    `Preserved refs: ${arrayValue(result.preservedRefs).length}`,
  ];
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function addSection(lines: string[], title: string, entries: readonly string[]) {
  if (entries.length === 0) return;
  lines.push("", title);
  for (const entry of entries) lines.push(`  ${entry}`);
}

function addProblemList(lines: string[], label: string, value: unknown) {
  const entries = arrayValue(value);
  if (entries.length === 0) return;
  lines.push(`  ${label}: ${entries.length}`);
  for (const entry of entries.slice(0, 8)) lines.push(`    - ${describeEntry(entry)}`);
  if (entries.length > 8) lines.push(`    - ... ${entries.length - 8} more`);
}

function hygieneProblemLines(result: Record<string, unknown>): string[] {
  const summary = recordValue(recordValue(result.hygiene).summary);
  const fail = numberValue(recordValue(summary.bySeverity).fail);
  const warn = numberValue(recordValue(summary.bySeverity).warn);
  const total = numberValue(summary.findingCount);
  if (total === 0) return [];
  const severity = [fail > 0 ? `${fail} fail` : "", warn > 0 ? `${warn} warn` : ""].filter(Boolean).join(", ");
  return [`Hygiene findings: ${total}${severity ? ` (${severity})` : ""}`];
}

function statusHeader(name: string, result: Record<string, unknown>) {
  if (result.ok === false || name !== "guardian_status") return `${result.ok === false ? "[FAIL]" : "[GOOD]"} ${name} snapshot`;
  const verdict = computeGuardianVerdict(result);
  const marker = verdict.tone === "bad" ? "[FAIL]" : verdict.tone === "warn" ? "[WARN]" : "[GOOD]";
  const state = verdict.tone === "good" ? "Clean" : "Needs attention";
  return `${marker} Guardian Status: ${state}`;
}

function statusVerdict(result: Record<string, unknown>) {
  return result.ok === false ? null : computeGuardianVerdict(result);
}

export function formatGuardianStatusOutput(name: string, rawResult: unknown) {
  const result = recordValue(rawResult);
  const lines: string[] = [statusHeader(name, result)];
  const verdict = name === "guardian_status" ? statusVerdict(result) : null;
  if (verdict) addSection(lines, "Reason", [verdict.headline]);
  if (verdict?.nextAction) addSection(lines, "Next", [verdict.nextAction]);
  addSection(lines, "Repo", [textValue(result.repoRoot)]);
  const reason = textValue(result.reason, "");
  if (result.ok === false || reason) addSection(lines, "Problem", [reason || "guardian tool reported failure"]);
  const activeSessions = arrayValue(result.activeSessions);
  const terminalSessions = arrayValue(result.terminalSessions);
  const sessions = arrayValue(result.sessions);
  const visibleActiveSessions = activeSessions.length > 0 ? activeSessions : sessions.filter((entry) => recordValue(entry).status === "active");
  addSection(lines, "Work Now", operationalLine(result, visibleActiveSessions.length));
  const problemStart = lines.length;
  lines.push("", "Problems");
  for (const entry of hygieneProblemLines(result)) lines.push(`  ${entry}`);
  addProblemList(lines, "Dirty files", result.dirtyFiles);
  addProblemList(lines, "Orphaned sessions", result.orphanedSessions);
  addProblemList(lines, "Poisoned sessions", result.poisonedSessions);
  addProblemList(lines, "Worktrees without state", result.worktreesWithoutState);
  addProblemList(lines, "State branches without worktrees", result.stateBranchesWithoutWorktrees);
  addProblemList(lines, "Stashes", result.stashes);
  if (lines.length === problemStart + 2) lines.splice(problemStart, 2);
  addSection(lines, "History", terminalHistoryLines(terminalSessions, result));
  if (visibleActiveSessions.length > 0) lines.push("", "Active Sessions");
  for (const entry of visibleActiveSessions.slice(0, 12)) {
    const session = recordValue(entry);
    lines.push(`  ${textValue(session.session_id ?? session.sessionId)} ${textValue(session.status)} ${textValue(session.branch)} ${shortCommit(session.head_commit ?? session.headCommit)}`);
    lines.push(`    ${textValue(session.worktree_path ?? session.worktreePath)}`);
  }
  const worktrees = arrayValue(result.worktrees);
  lines.push("", "Current Worktrees");
  for (const entry of worktrees.slice(0, 12)) {
    const worktree = recordValue(entry);
    const markers = [worktree.detached === true ? "detached" : "", worktree.bare === true ? "bare" : ""].filter(Boolean).join(",");
    lines.push(`  ${textValue(worktree.branch)} ${shortCommit(worktree.head ?? worktree.head_commit ?? worktree.headCommit)} ${textValue(worktree.path ?? worktree.worktree_path ?? worktree.worktreePath)}${markers ? ` (${markers})` : ""}`);
  }
  const recoveryCandidates = arrayValue(result.recoveryCandidates);
  if (recoveryCandidates.length > 0) {
    lines.push("", "Recovery Candidates");
    for (const entry of recoveryCandidates.slice(0, 12)) lines.push(`  - ${describeEntry(entry)}`);
  }
  const suggestions = arrayValue(result.suggestedCommands);
  addSection(lines, "Suggested Commands", suggestions.map((command) => textValue(command, String(command))));
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
