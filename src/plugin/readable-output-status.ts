import { computeGuardianVerdict } from "../verdict.ts";
import { TERMINAL_SESSION_STATUSES, TERMINAL_SESSION_STATUS_VALUES } from "../lifecycle.ts";
import { appendOperationalScope } from "./readable-output-evidence.ts";
import { appendBoundedList, arrayValue, describeEntry, recordValue, shortCommit, textValue } from "./readable-output-values.ts";

function recoveryCandidateEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const candidates = recordValue(value);
  return [
    ...arrayValue(candidates.reflog).map((entry) => ({ ...recordValue(entry), kind: "reflog" })),
    ...arrayValue(candidates.unreachable).map((entry) => typeof entry === "string" ? { kind: "unreachable", commit: entry } : { ...recordValue(entry), kind: "unreachable" }),
  ];
}

function formatRecoveryCandidate(entry: unknown): string {
  const candidate = recordValue(entry);
  const kind = textValue(candidate.kind);
  const commit = shortCommit(candidate.commit);
  if (kind === "reflog") return `  - reflog ${textValue(candidate.selector)} ${commit} ${textValue(candidate.subject)}`;
  return `  - unreachable ${commit}`;
}

function safeRecoveryValue(value: unknown): string {
  return textValue(value).replace(/\r\n|\n|\r/g, "\\n").replace(/\t/g, "\\t");
}

function quarantineRecoveryLines(result: Record<string, unknown>): string[] {
  const items = arrayValue(result.quarantineItems).map(recordValue);
  const operations = arrayValue(result.incompleteQuarantineOperations).map(recordValue);
  return [
    ...items.map((item) => `- ${safeRecoveryValue(item.state)} ${safeRecoveryValue(item.quarantineId)} ${safeRecoveryValue(item.originalRelativePath)}`),
    ...operations.map((operation) => `- ${safeRecoveryValue(operation.action)} ${safeRecoveryValue(operation.phase)} ${safeRecoveryValue(operation.operationId)} ${safeRecoveryValue(operation.quarantineId)}`),
  ];
}

function operationalLine(result: Record<string, unknown>, activeSessionCount: number) {
  return [
    `Active sessions: ${activeSessionCount}`,
    `Worktrees: ${arrayValue(result.worktrees).length}`,
    `Dirty files: ${arrayValue(result.dirtyFiles).length}`,
    `Stashes: ${arrayValue(result.stashes).length}`,
    `Orphaned sessions: ${arrayValue(result.orphanedSessions).length}`,
    `Poisoned sessions: ${arrayValue(result.poisonedSessions).length}`,
    `Recovery candidates: ${recoveryCandidateEntries(result.recoveryCandidates).length}`,
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

function terminalRecoveryPlanLines(result: Record<string, unknown>) {
  const actions = arrayValue(result.terminalRecoveryActions);
  const count = numberValue(result.terminalRecoveryActionCount ?? actions.length);
  if (count === 0) return [];
  const omittedCount = numberValue(result.terminalRecoveryActionOmittedCount ?? Math.max(0, count - actions.length));
  return [
    `Available plans: ${count} | omitted: ${omittedCount}`,
    ...actions.map((action) => `- ${textValue(recordValue(action).command).replace(/\r\n|\n|\r/g, "\\n").replace(/\t/g, "\\t")}`),
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
  appendBoundedList({ lines, heading: `  ${label}`, entries, format: (entry) => `    - ${describeEntry(entry)}` });
}

function hygieneProblemLines(result: Record<string, unknown>): string[] {
  const summary = recordValue(recordValue(result.hygiene).summary);
  const fail = numberValue(recordValue(summary.bySeverity).fail);
  const warn = numberValue(recordValue(summary.bySeverity).warn);
  const total = numberValue(summary.findingCount);
  const protectedInventoryCount = numberValue(summary.protectedInventoryCount);
  const protectedInventoryRootsTruncated = summary.protectedInventoryRootsTruncated === true;
  const lines: string[] = [];
  if (total > 0) {
    const severity = [fail > 0 ? `${fail} need manual review` : "", warn > 0 ? `${warn} warning${warn === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
    lines.push(`Hygiene findings: ${total}${severity ? ` (${severity})` : ""}`);
  }
  if (protectedInventoryCount > 0) lines.push(`Protected inventory not retention-assessed: ${protectedInventoryCount}${protectedInventoryRootsTruncated ? "+" : ""} root${protectedInventoryCount === 1 && !protectedInventoryRootsTruncated ? "" : "s"}`);
  return lines;
}

function statusHeader(name: string, result: Record<string, unknown>) {
  if (result.ok === false || name !== "guardian_status") return `${result.ok === false ? "[FAIL]" : "[GOOD]"} ${name} snapshot`;
  const verdict = computeGuardianVerdict(result);
  const marker = verdict.tone === "bad" ? "[FAIL]" : verdict.tone === "warn" ? "[WARN]" : "[GOOD]";
  const state = verdict.tone === "good" ? "Clean" : verdict.tone === "warn" ? "Needs review" : "Blocked";
  return `${marker} Guardian Status: ${state}`;
}

function configLines(result: Record<string, unknown>) {
  const source = textValue(result.configSource, "");
  if (source === "input") return ["input override"];
  const configPath = textValue(result.configPath);
  if (source === "file") return [`file ${configPath}`];
  if (source === "defaults") return [`defaults active; ${configPath} not written`, "guardian_init to write repo config"];
  return [];
}

function baseDistanceLine(result: Record<string, unknown>, session: Record<string, unknown>) {
  const sessionId = textValue(session.session_id ?? session.sessionId, "(unknown)");
  const distance = arrayValue(result.activeSessionBaseDistances)
    .map(recordValue)
    .find((entry) => textValue(entry.sessionId, "(unknown)") === sessionId);
  if (!distance) return "Base distance: unavailable (not reported)";
  if (textValue(distance.status) !== "available") return `Base distance: unavailable (${textValue(distance.reason)})`;
  return `Base distance: ${textValue(distance.baseRef)} ${shortCommit(distance.baseRefOid)} ahead=${numberValue(distance.ahead)} behind=${numberValue(distance.behind)} relation=${textValue(distance.relation)}`;
}

export function formatGuardianInitOutput(rawResult: unknown) {
  const result = recordValue(rawResult);
  const status = textValue(result.status, result.ok === false ? "blocked" : "completed");
  const created = result.created === true;
  return [
    `${result.ok === false ? "[FAIL]" : created ? "[GOOD]" : "[INFO]"} guardian_init ${status}`,
    `[INFO] repoRoot: ${textValue(result.repoRoot)}`,
    `[INFO] configPath: ${textValue(result.configPath)}`,
    `[INFO] ${created ? "wrote default Guardian config" : "config already exists; left unchanged"}`,
  ].join("\n");
}

function statusVerdict(result: Record<string, unknown>) {
  return result.ok === false ? null : computeGuardianVerdict(result);
}

function cleanCompletionProofLines(result: Record<string, unknown>): string[] {
  const proof = recordValue(result.cleanCompletionProof);
  const status = textValue(proof.status, "");
  if (!status) return [];
  const lines = [`status: ${status}`];
  const reason = textValue(proof.reason, "");
  const provenAt = textValue(proof.provenAt, "");
  const digest = textValue(proof.inventoryDigest, "");
  if (reason) lines.push(`reason: ${reason}`);
  if (provenAt) lines.push(`proven at: ${provenAt}`);
  if (digest) lines.push(`inventory digest: ${shortCommit(digest)}`);
  if (typeof proof.stateVersion === "number") lines.push(`state version: ${proof.stateVersion}`);
  if (typeof proof.worktreeCount === "number") lines.push(`worktrees: ${proof.worktreeCount}`);
  if (typeof proof.quarantineItemCount === "number") lines.push(`recoverable quarantine items: ${proof.quarantineItemCount}`);
  return lines;
}

export function formatGuardianStatusOutput(name: string, rawResult: unknown) {
  const result = recordValue(rawResult);
  const lines: string[] = [statusHeader(name, result)];
  const verdict = name === "guardian_status" ? statusVerdict(result) : null;
  if (verdict) addSection(lines, "Reason", [verdict.headline]);
  if (verdict?.nextAction) addSection(lines, "Next", [verdict.nextAction]);
  addSection(lines, "Repo", [textValue(result.repoRoot)]);
  addSection(lines, "Config", configLines(result));
  const scopeLines: string[] = [];
  appendOperationalScope(scopeLines, result.operationalScope);
  addSection(lines, "Operational Scope", scopeLines.slice(1).map((line) => line.replace(/^\[INFO\] /, "")));
  addSection(lines, "Clean Completion Proof", cleanCompletionProofLines(result));
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
  addSection(lines, "Terminal Recovery Plans", terminalRecoveryPlanLines(result));
  addSection(lines, "History", terminalHistoryLines(terminalSessions, result));
  if (visibleActiveSessions.length > 0) lines.push("");
  appendBoundedList({
    lines,
    heading: "Active Sessions",
    entries: visibleActiveSessions,
    limit: 12,
    format: (entry) => {
      const session = recordValue(entry);
      return `  ${textValue(session.session_id ?? session.sessionId)} ${textValue(session.status)} ${textValue(session.branch)} ${shortCommit(session.head_commit ?? session.headCommit)}\n    ${textValue(session.worktree_path ?? session.worktreePath)}\n    ${baseDistanceLine(result, session)}`;
    },
  });
  const worktrees = arrayValue(result.worktrees);
  lines.push("");
  appendBoundedList({
    lines,
    heading: "Current Worktrees",
    entries: worktrees,
    limit: 12,
    format: (entry) => {
      const worktree = recordValue(entry);
      const markers = [worktree.detached === true ? "detached" : "", worktree.bare === true ? "bare" : ""].filter(Boolean).join(",");
      return `  ${textValue(worktree.branch)} ${shortCommit(worktree.head ?? worktree.head_commit ?? worktree.headCommit)} ${textValue(worktree.path ?? worktree.worktree_path ?? worktree.worktreePath)}${markers ? ` (${markers})` : ""}`;
    },
  });
  const recoveryCandidates = recoveryCandidateEntries(result.recoveryCandidates);
  if (recoveryCandidates.length > 0) lines.push("");
  appendBoundedList({ lines, heading: "Recovery Candidates", entries: recoveryCandidates, limit: 12, format: formatRecoveryCandidate });
  addSection(lines, "Quarantine Recovery", quarantineRecoveryLines(result));
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
