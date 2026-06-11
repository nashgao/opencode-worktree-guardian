import fs from "node:fs/promises";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";
import { loadConfig } from "./config.ts";
import { getCurrentBranch, getRepoRoot, listWorktrees } from "./git.ts";
import { classifyGuardCommand, classifyReadOnlyInspectionCommand, extractCommandText } from "./guards.ts";
import { getGuardianPaths, readState } from "./state.ts";
import { collectKnownWorktreePaths, guardianStart, injectInvisiblePolicy, recordLastSafeState, resolveSessionWorktree, rewriteGuardianCommand, runGuardianTool } from "./tools.ts";

export { DEFAULT_CONFIG, FINISH_MODES, loadConfig, normalizeConfig } from "./config.ts";
export { classifyGuardCommand, classifyReadOnlyInspectionCommand, extractCommandText, tokenizeCommand } from "./guards.ts";
export { guardianDeleteWorktree } from "./delete.ts";
export { guardianDone } from "./done.ts";
export { buildPreservedRef, buildSafetyRef, createSafetyRef, deleteBranch, getRepoRoot, listWorktrees, removeWorktree, runGit } from "./git.ts";
export { guardianHygieneCleanup, scanWorkspaceHygiene } from "./hygiene.ts";
export { acquireStateLock, appendEvent, getGuardianPaths, readState, recordSession, updateState, writeReportAtomic, writeStateAtomic } from "./state.ts";
export { guardianFinish } from "./finish.ts";
export { guardianRecover, guardianStatus } from "./recover.ts";
export { guardianReportHtml, renderGuardianReportHtml } from "./report.ts";
export { buildInvisiblePolicy, collectKnownWorktreePaths, guardianPreserve, guardianStart, injectInvisiblePolicy, recordLastSafeState, resolveSessionWorktree, rewriteGuardianCommand, runGuardianTool } from "./tools.ts";
export { guardianUnblockFinish } from "./unblock-finish.ts";

const SERVICE = "worktree-guardian";
const MAX_STRING_LENGTH = 160;
const SECRET_KEY_PATTERN = /(token|secret|password|passwd|authorization|cookie|api[-_]?key|credential)/i;
const z = tool.schema;

function truncate(value: string) {
  if (typeof value !== "string") return value;
  if (value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_LENGTH)}...<truncated:${value.length}>`;
}

function redactString(value: string) {
  return truncate(value)
    .replace(/(authorization:\s*)(bearer\s+)?\S+/gi, "$1$2<redacted>")
    .replace(/(token|secret|password|passwd|api[-_]?key|cookie|credential)=([^\s&]+)/gi, "$1=<redacted>");
}

function summarize(value: any, key = "") {
  if (SECRET_KEY_PATTERN.test(key)) return "<redacted>";
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      preview: value.slice(0, 5).map((entry) => summarize(entry, key)),
    };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).slice(0, 12);
    return Object.fromEntries(entries.map(([entryKey, entryValue]) => [entryKey, summarize(entryValue, entryKey)]));
  }
  return typeof value;
}

async function writeLog(client: any, event: Record<string, any>) {
  if (typeof client?.app?.log === "function") {
    await client.app.log({ body: event });
    return;
  }

  console.error(JSON.stringify(event));
}

function createEvent(message: string, input: any, output: any, context: Record<string, any>, extra: Record<string, any> = {}) {
  return {
    service: SERVICE,
    level: "info",
    message,
    directory: context.directory,
    worktree: context.worktree,
    input: summarize(input),
    output: summarize(output),
    ...summarize(extra),
  };
}

function getSessionId(input: Record<string, any> = {}) {
  return input?.sessionID ?? input?.sessionId;
}

function getExecutionCwd(input: Record<string, any> = {}, output: Record<string, any> = {}, context: Record<string, any> = {}) {
  return output?.args?.workdir ?? output?.args?.cwd ?? input?.args?.workdir ?? input?.args?.cwd ?? input?.workdir ?? input?.cwd ?? context.worktree ?? context.directory ?? process.cwd();
}


const DIRECT_FILE_MUTATION_TOOLS = new Set([
  "write",
  "edit",
  "multiedit",
  "patch",
  "apply_patch",
  "functions.apply_patch",
]);
const DIRECT_FILE_PATH_KEYS = ["filePath", "filepath", "path", "target", "filename"];

function normalizePathForCompare(candidate: string) {
  return path.resolve(candidate);
}

function isPathInside(parent: string, candidate: string) {
  const relative = path.relative(normalizePathForCompare(parent), normalizePathForCompare(candidate));
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function directFileMutationPathArg(input: Record<string, any> = {}, output: Record<string, any> = {}) {
  const toolName = String(input?.tool ?? "");
  if (!DIRECT_FILE_MUTATION_TOOLS.has(toolName)) return null;
  const args = output?.args && typeof output.args === "object" ? output.args : input?.args && typeof input.args === "object" ? input.args : null;
  if (!args) return null;
  for (const key of DIRECT_FILE_PATH_KEYS) {
    if (typeof args[key] === "string" && path.isAbsolute(args[key])) return { args, key, value: args[key] };
  }
  return null;
}

async function routeDirectFileMutation(input: Record<string, any>, output: Record<string, any>, sessionWorktree: Record<string, any> | null, repoRoot: string | undefined, cache: Map<string, string>) {
  const pathArg = directFileMutationPathArg(input, output);
  if (!pathArg) return { routed: false, blocked: false, reason: null };
  if (!repoRoot) return { routed: false, blocked: true, reason: "direct file mutation cannot be checked without a Guardian repo root" };
  if (!isPathInside(repoRoot, pathArg.value)) return { routed: false, blocked: false, reason: null };
  if (sessionWorktree?.sessionId == null) return { routed: false, blocked: false, reason: null };
  if (typeof sessionWorktree?.expectedWorktree !== "string") {
    return { routed: false, blocked: true, reason: "direct file mutation cannot be checked against a recorded Guardian worktree" };
  }
  if (isPathInside(sessionWorktree.expectedWorktree, pathArg.value)) return { routed: false, blocked: false, reason: null };

  let routedSession = sessionWorktree;
  if (routedSession.ok !== true) {
    try {
      routedSession = await validateRecordedSessionTarget(input, routedSession, repoRoot, cache);
    } catch (error: any) {
      return { routed: false, blocked: true, reason: error.message };
    }
  }

  const relative = path.relative(normalizePathForCompare(repoRoot), normalizePathForCompare(pathArg.value));
  const routedPath = path.join(routedSession.expectedWorktree, relative);
  if (!isPathInside(routedSession.expectedWorktree, routedPath)) {
    return { routed: false, blocked: true, reason: "direct file mutation path cannot be safely rewritten into the Guardian worktree" };
  }
  pathArg.args[pathArg.key] = routedPath;
  if (!output.args || typeof output.args !== "object") output.args = pathArg.args;
  return { routed: true, blocked: false, reason: null, originalPath: pathArg.value, routedPath };
}

function rememberSessionWorktree(cache: Map<string, string>, sessionId: string | undefined, result: Record<string, any> | null) {
  const worktreePath = result?.session?.worktree_path;
  if (sessionId && result?.ok === true && typeof worktreePath === "string") cache.set(sessionId, worktreePath);
}

async function pathExists(candidate: string | undefined) {
  if (!candidate) return false;
  return fs.access(candidate).then(() => true, () => false);
}

async function getActualWorktree(executionCwd: string) {
  return await getRepoRoot(executionCwd);
}

async function collectRecordedBranches(repoRoot: string, config: Record<string, any>) {
  const state = await readState(await getGuardianPaths(repoRoot), { repoRoot, config });
  const sessions = Object.values(state.sessions ?? {}) as Array<Record<string, any>>;
  return [...new Set(sessions.map((session) => session.branch).filter((branch): branch is string => typeof branch === "string" && branch.length > 0))];
}

async function collectProtectedBranchWorktrees(repoRoot: string, config: Record<string, any>) {
  const protectedBranches = Array.isArray(config.protectedBranches) ? config.protectedBranches : [];
  return (await listWorktrees(repoRoot))
    .filter((entry: any) => typeof entry.branch === "string" && protectedBranches.includes(entry.branch))
    .map((entry: any) => entry.path)
    .filter((entry: unknown): entry is string => typeof entry === "string");
}

function ensureToolArgs(output: Record<string, any> = {}) {
  if (!output.args || typeof output.args !== "object") output.args = {};
  return output.args;
}

function sortedStringArgs(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").sort((left, right) => left.localeCompare(right)) : [];
}

function normalizeOptionalToolStrings(toolArgs: Record<string, any>) {
  for (const key of ["repoRoot", "cwd", "sessionId", "branch", "targetPath", "worktreePath", "confirmToken"]) {
    if (typeof toolArgs[key] === "string" && toolArgs[key].trim() === "") delete toolArgs[key];
  }
}

function planCacheKey(name: string, toolArgs: Record<string, any>) {
  return JSON.stringify({
    name,
    sessionId: typeof toolArgs.sessionId === "string" ? toolArgs.sessionId : "",
    repoRoot: typeof toolArgs.repoRoot === "string" ? toolArgs.repoRoot : "",
    cwd: typeof toolArgs.cwd === "string" ? toolArgs.cwd : "",
    cleanupPaths: sortedStringArgs(toolArgs.cleanupPaths),
    allowCategories: sortedStringArgs(toolArgs.allowCategories),
    allowDirtyNestedGit: toolArgs.allowDirtyNestedGit === true,
    commitMessage: typeof toolArgs.commitMessage === "string" ? toolArgs.commitMessage : "",
    finishMode: typeof toolArgs.finishMode === "string" ? toolArgs.finishMode : "",
    deleteBranch: toolArgs.deleteBranch === true,
    abandonUnmerged: toolArgs.abandonUnmerged === true,
    allowIgnoredFiles: toolArgs.allowIgnoredFiles === true,
    action: typeof toolArgs.action === "string" ? toolArgs.action : "",
  });
}

function isPlaceholderConfirmToken(value: unknown) {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  return normalized === "" || normalized === "CONFIRM_DELETE";
}

function shouldUseCachedPlanToken(name: string, toolArgs: Record<string, any>) {
  if (toolArgs.mode !== "apply") return false;
  if (name === "guardian_hygiene_cleanup") return toolArgs.confirmDelete === true;
  if (name === "guardian_done" || name === "guardian_finish_workflow") return toolArgs.confirm === true || toolArgs.confirmDelete === true;
  return false;
}

function maybeInjectPlanConfirmToken(name: string, toolArgs: Record<string, any>, planCache?: Map<string, string>) {
  if (!planCache || !shouldUseCachedPlanToken(name, toolArgs)) return;
  if (typeof toolArgs.confirmToken === "string" && !isPlaceholderConfirmToken(toolArgs.confirmToken)) return;
  const cachedToken = planCache.get(planCacheKey(name, toolArgs));
  if (cachedToken) toolArgs.confirmToken = cachedToken;
}

function rememberPlanConfirmToken(name: string, toolArgs: Record<string, any>, result: Record<string, any>, planCache?: Map<string, string>) {
  if (!planCache) return;
  if (toolArgs.mode !== "plan" || result.ok !== true || result.status !== "planned" || typeof result.confirmToken !== "string") return;
  if (!["guardian_hygiene_cleanup", "guardian_done", "guardian_finish_workflow"].includes(name)) return;
  planCache.set(planCacheKey(name, toolArgs), result.confirmToken);
}

async function resolveActualWorktreeOrPath(executionCwd: string) {
  try {
    return await getActualWorktree(executionCwd);
  } catch {
    return executionCwd;
  }
}

async function validateRecordedSessionTarget(input: Record<string, any>, sessionWorktree: Record<string, any>, repoRoot: string | undefined, cache: Map<string, string>) {
  const expectedWorktree = sessionWorktree.expectedWorktree;
  if (typeof expectedWorktree !== "string" || expectedWorktree.length === 0) {
    throw new Error(`recorded worktree is unavailable for session ${sessionWorktree.sessionId}`);
  }
  if (!await pathExists(expectedWorktree)) {
    throw new Error(`recorded worktree is missing for session ${sessionWorktree.sessionId}: ${expectedWorktree}`);
  }
  const actualWorktree = await getActualWorktree(expectedWorktree);
  const routed = await resolveSessionWorktree({
    repoRoot,
    cwd: expectedWorktree,
    actualWorktree,
    sessionId: getSessionId(input),
    cache,
    validateBinding: true,
  });
  if (routed?.ok !== true) {
    const reason = routed?.reason ? `${routed.reason}: ` : "";
    throw new Error(`recorded worktree cannot be used for session ${sessionWorktree.sessionId}: ${reason}expected ${routed?.expectedWorktree ?? expectedWorktree}, actual ${routed?.actualWorktree ?? actualWorktree}`);
  }
  return { ...routed, actualWorktree };
}

async function routeRecordedSessionCommand(input: Record<string, any>, output: Record<string, any>, sessionWorktree: Record<string, any>, repoRoot: string | undefined, cache: Map<string, string>) {
  const routed = await validateRecordedSessionTarget(input, sessionWorktree, repoRoot, cache);
  const args = ensureToolArgs(output);
  args.workdir = routed.expectedWorktree;
  args.cwd = routed.expectedWorktree;
  return {
    ...routed,
    routed: true,
    routedFrom: sessionWorktree.actualWorktree,
  };
}


async function tryInvisibleStart(input: any, context: Record<string, any>, config: Record<string, any>) {
  const sessionId = input?.sessionID ?? input?.sessionId;
  if (!config.autoStart || !sessionId || !context.directory) return null;
  try {
    return await guardianStart({
      repoRoot: context.directory,
      cwd: context.worktree ?? context.directory,
      sessionId,
      taskName: input?.taskName ?? "session",
      createWorktree: context.worktree == null || context.worktree === context.directory,
      config,
    });
  } catch (error: any) {
    return { ok: false, reason: error.message };
  }
}


const READABLE_GUARDIAN_TOOLS = new Set(["guardian_status", "guardian_recover", "guardian_report_html", "guardian_hygiene", "guardian_hygiene_cleanup", "guardian_delete_worktree", "guardian_unblock_finish", "guardian_finish_workflow", "guardian_done"]);
const SESSION_WORKTREE_DEFAULT_TOOLS = new Set(["guardian_finish", "guardian_preserve"]);

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textValue(value: unknown, fallback = "-") {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function shortCommit(value: unknown) {
  const text = textValue(value);
  return text === "-" ? text : text.slice(0, 12);
}

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

function describeEntry(entry: unknown) {
  const item = recordValue(entry);
  return textValue(item.session_id ?? item.sessionId ?? item.branch ?? item.path ?? item.worktree_path ?? item.name ?? item.ref ?? item.command ?? entry, JSON.stringify(entry));
}

function formatGuardianStatusOutput(name: string, rawResult: unknown) {
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

function formatGuardianReportOutput(rawResult: unknown) {
  const result = recordValue(rawResult);
  const status = recordValue(result.status);
  const recover = recordValue(result.recover);
  const lines = [
    `${result.ok === false ? "[FAIL]" : "[GOOD]"} guardian_report_html wrote offline report`,
    `[INFO] reportPath: ${textValue(result.reportPath)}`,
    `[INFO] repoRoot: ${textValue(status.repoRoot)}`,
    `[INFO] sessions: ${arrayValue(status.sessions).length} | worktrees: ${arrayValue(status.worktrees).length} | risks: ${arrayValue(status.orphanedSessions).length + arrayValue(status.worktreesWithoutState).length + arrayValue(status.dirtyFiles).length + arrayValue(status.stashes).length} | recoveryCandidates: ${arrayValue(recover.recoveryCandidates).length}`,
  ];
  return lines.join("\n");
}

function formatGuardianHygieneOutput(rawResult: unknown) {
  const result = recordValue(rawResult);
  const summary = recordValue(result.summary);
  const findings = arrayValue(result.findings);
  const exclusions = arrayValue(result.exclusions);
  const failCount = Number(recordValue(summary.bySeverity).fail ?? 0);
  const warnCount = Number(recordValue(summary.bySeverity).warn ?? 0);
  const scanFailed = result.ok === false || summary.scanFailed === true;
  const lines = [
    `${scanFailed ? "[FAIL]" : findings.length > 0 ? "[WARN]" : "[GOOD]"} guardian_hygiene scan`,
    `[INFO] repoRoot: ${textValue(result.repoRoot)}`,
  ];
  if (scanFailed) {
    lines.push("[WARN] scan incomplete: findings and candidate counts are not trustworthy");
  } else {
    lines.push(`[INFO] findings: ${Number(summary.findingCount ?? findings.length)} | warn: ${warnCount} | fail: ${failCount} | exclusions: ${Number(summary.exclusionCount ?? exclusions.length)} | candidates: ${Number(summary.candidateCount ?? 0)}`);
  }
  const reason = textValue(result.reason, "");
  if (result.ok === false || reason) lines.push(`[FAIL] ${reason || "guardian_hygiene scan failed"}`);
  if (findings.length > 0) {
    lines.push("[WARN] top findings:");
    for (const entry of findings.slice(0, 8)) {
      const finding = recordValue(entry);
      lines.push(`  - ${textValue(finding.severity)} ${textValue(finding.category)} ${textValue(finding.path)}: ${textValue(finding.reason)}`);
    }
  }
  const suggestions = arrayValue(result.suggestedCommands);
  if (suggestions.length > 0) {
    lines.push("[INFO] suggested commands:");
    for (const command of suggestions.slice(0, 8)) lines.push(`  - ${textValue(command, String(command))}`);
  }
  return lines.join("\n");
}

function formatGuardianHygieneCleanupOutput(rawResult: unknown) {
  const result = recordValue(rawResult);
  const summary = recordValue(result.summary);
  const targets = arrayValue(result.targets);
  const removedTargets = arrayValue(result.removedTargets);
  const blockers = arrayValue(result.blockers);
  const lines = [
    `${result.ok === false ? "[FAIL]" : result.status === "planned" ? "[WARN]" : "[GOOD]"} guardian_hygiene_cleanup ${textValue(result.status)}`,
    `[INFO] approvedTargets: ${Number(summary.approvedTargetCount ?? targets.length)} | removedTargets: ${Number(summary.removedTargetCount ?? removedTargets.length)} | blockers: ${Number(summary.blockedTargetCount ?? blockers.length)} | fatal: ${Number(summary.fatalBlockerCount ?? 0)}`,
  ];
  const reason = textValue(result.reason, "");
  if (result.ok === false || reason) lines.push(`[FAIL] ${reason || "guardian_hygiene_cleanup blocked"}`);
  if (targets.length > 0) {
    lines.push("[INFO] approved targets:");
    for (const entry of targets.slice(0, 8)) {
      const target = recordValue(entry);
      lines.push(`  - ${textValue(target.category)} ${textValue(target.path)}: ${textValue(target.reason)}`);
    }
  }
  if (blockers.length > 0) {
    lines.push("[WARN] blockers:");
    for (const entry of blockers.slice(0, 8)) {
      const blocker = recordValue(entry);
      lines.push(`  - ${blocker.fatal === true ? "fatal" : "blocked"} ${textValue(blocker.path)}: ${textValue(blocker.reason)}`);
    }
  }
  return lines.join("\n");
}

function formatGuardianDeleteOutput(rawResult: unknown) {
  const result = recordValue(rawResult);
  const preflight = recordValue(result.preflight);
  const lines = [
    `${result.ok === false ? "[FAIL]" : result.status === "planned" ? "[WARN]" : "[GOOD]"} guardian_delete_worktree ${textValue(result.status)}`,
    `[INFO] mode: ${textValue(preflight.mode)} | targetKind: ${textValue(preflight.targetKind, "worktree")} | deleteBranch: ${String(preflight.deleteBranch === true)} | abandonUnmerged: ${String(preflight.abandonUnmerged === true)} | branchDeleted: ${String(result.branchDeleted === true)} | worktreeRemoved: ${String(result.worktreeRemoved === true)}`,
    `[INFO] targetPath: ${textValue(preflight.targetPath ?? result.targetPath)}`,
    `[INFO] branch: ${textValue(preflight.branch ?? result.branch)} | head: ${shortCommit(preflight.head ?? result.head)}`,
  ];
  if (preflight.ancestryProven === false || Number(preflight.unmergedCommitCount ?? 0) > 0) {
    lines.push(`[WARN] ancestryProven: ${String(preflight.ancestryProven === true)} | ancestryRef: ${textValue(preflight.ancestryRef)} | unmergedCommitCount: ${Number(preflight.unmergedCommitCount ?? 0)}`);
  }
  const reason = textValue(result.reason, "");
  if (result.ok === false || reason) lines.push(`[FAIL] ${reason || "guardian_delete_worktree blocked"}`);
  if (typeof result.confirmToken === "string") lines.push(`[WARN] confirmToken: ${result.confirmToken}`);
  if (typeof result.safetyRef === "string") lines.push(`[INFO] safetyRef: ${result.safetyRef}`);
  const blockers = arrayValue(preflight.blockers);
  if (blockers.length > 0) {
    lines.push("[WARN] blockers:");
    for (const blocker of blockers.slice(0, 8)) lines.push(`  - ${textValue(blocker, String(blocker))}`);
  }
  return lines.join("\n");
}

function formatGuardianUnblockFinishOutput(rawResult: unknown) {
  const result = recordValue(rawResult);
  const preflight = recordValue(result.preflight);
  const lines = [
    `${result.ok === false ? "[FAIL]" : result.status === "planned" ? "[WARN]" : "[GOOD]"} guardian_unblock_finish ${textValue(result.status)}`,
    `[INFO] action: ${textValue(result.action ?? preflight.action)} | sessionId: ${textValue(preflight.sessionId)} | branch: ${textValue(preflight.branch)}`,
    `[INFO] worktreePath: ${textValue(preflight.worktreePath)}`,
  ];

  const reviewArtifactPaths = arrayValue(preflight.reviewArtifactPaths);
  if (reviewArtifactPaths.length > 0) {
    lines.push(`[INFO] review artifacts: ${reviewArtifactPaths.length}`);
    for (const entry of reviewArtifactPaths.slice(0, 8)) lines.push(`  - ${textValue(entry, String(entry))}`);
  }

  const otherDirtyPaths = arrayValue(preflight.otherDirtyPaths);
  if (otherDirtyPaths.length > 0) {
    lines.push(`[WARN] other dirty paths: ${otherDirtyPaths.length}`);
    for (const entry of otherDirtyPaths.slice(0, 8)) lines.push(`  - ${textValue(entry, String(entry))}`);
  }

  const reason = textValue(result.reason, "");
  if (result.ok === false || reason) lines.push(`[FAIL] ${reason || "guardian_unblock_finish blocked"}`);
  if (typeof result.nextAction === "string") lines.push(`[INFO] nextAction: ${result.nextAction}`);
  if (typeof result.commitMessage === "string") lines.push(`[INFO] commitMessage: ${result.commitMessage}`);
  if (typeof result.commit === "string") lines.push(`[INFO] commit: ${shortCommit(result.commit)}`);
  if (typeof result.safetyRef === "string") lines.push(`[INFO] safetyRef: ${result.safetyRef}`);
  return lines.join("\n");
}

function formatGuardianFinishWorkflowOutput(rawResult: unknown) {
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

function formatGuardianDoneOutput(rawResult: unknown) {
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

function formatGuardianOutput(name: string, result: unknown) {
  if (name === "guardian_report_html") return formatGuardianReportOutput(result);
  if (name === "guardian_hygiene") return formatGuardianHygieneOutput(result);
  if (name === "guardian_hygiene_cleanup") return formatGuardianHygieneCleanupOutput(result);
  if (name === "guardian_delete_worktree") return formatGuardianDeleteOutput(result);
  if (name === "guardian_unblock_finish") return formatGuardianUnblockFinishOutput(result);
  if (name === "guardian_finish_workflow") return formatGuardianFinishWorkflowOutput(result);
  if (name === "guardian_done") return formatGuardianDoneOutput(result);
  return formatGuardianStatusOutput(name, result);
}

async function getRecordedToolWorktree(name: string, toolArgs: Record<string, any>, context: any) {
  if (!SESSION_WORKTREE_DEFAULT_TOOLS.has(name)) return null;
  if (typeof toolArgs.repoRoot !== "string" || typeof toolArgs.sessionId !== "string") return null;
  const contextCwd = typeof context?.worktree === "string" ? context.worktree : typeof context?.directory === "string" ? context.directory : toolArgs.repoRoot;
  const actualWorktree = await resolveActualWorktreeOrPath(contextCwd);
  const sessionWorktree = await resolveSessionWorktree({
    repoRoot: toolArgs.repoRoot,
    cwd: contextCwd,
    actualWorktree,
    sessionId: toolArgs.sessionId,
  });
  return typeof sessionWorktree?.expectedWorktree === "string" ? sessionWorktree.expectedWorktree : null;
}

function guardianTool(name: string, description: string, hygieneCleanupPlanCache?: Map<string, string>) {
  return tool({
    description,
    args: {
      repoRoot: z.string().optional(),
      cwd: z.string().optional(),
      sessionId: z.string().optional(),
      taskName: z.string().optional(),
      branch: z.string().optional(),
      targetPath: z.string().optional(),
      worktreePath: z.string().optional(),
      createWorktree: z.boolean().optional(),
      mode: z.enum(["plan", "apply"]).optional(),
      confirmToken: z.string().optional(),
      confirmDelete: z.boolean().optional(),
      confirm: z.boolean().optional(),
      action: z.enum(["commit-review-artifacts"]).optional(),
      commitMessage: z.string().optional(),
      deleteBranch: z.boolean().optional(),
      abandonUnmerged: z.boolean().optional(),
      allowIgnoredFiles: z.boolean().optional(),
      cleanupPaths: z.array(z.string()).optional(),
      allowCategories: z.array(z.enum(["known-cleanable", "nested-git", "suspicious"])).optional(),
      allowDirtyNestedGit: z.boolean().optional(),
      timestamp: z.string().optional(),
      finishMode: z.enum(["preserve-only", "push-branch", "create-pr", "merge-to-base"]).optional(),
      allowMergeToBase: z.boolean().optional(),
    },
    async execute(args: Record<string, any>, context: any) {
      context.metadata({ title: name });
      const toolArgs = { ...args };
      normalizeOptionalToolStrings(toolArgs);
      if (toolArgs.repoRoot == null && typeof context?.directory === "string") toolArgs.repoRoot = context.directory;
      if (toolArgs.sessionId == null && (name === "guardian_unblock_finish" || toolArgs.targetPath == null && toolArgs.branch == null)) {
        if (typeof context?.sessionID === "string") toolArgs.sessionId = context.sessionID;
        else if (typeof context?.sessionId === "string") toolArgs.sessionId = context.sessionId;
      }
      if (toolArgs.cwd == null) {
        const recordedWorktree = await getRecordedToolWorktree(name, toolArgs, context);
        if (recordedWorktree) toolArgs.cwd = recordedWorktree;
        else if (typeof context?.worktree === "string") toolArgs.cwd = context.worktree;
        else if (typeof context?.directory === "string") toolArgs.cwd = context.directory;
      }
      maybeInjectPlanConfirmToken(name, toolArgs, hygieneCleanupPlanCache);
      const result = await runGuardianTool(name, toolArgs);
      rememberPlanConfirmToken(name, toolArgs, result, hygieneCleanupPlanCache);
      return {
        title: name,
        metadata: result,
        output: READABLE_GUARDIAN_TOOLS.has(name) ? formatGuardianOutput(name, result) : JSON.stringify(result, null, 2),
      };
    },
  });
}

const WorktreeGuardianPlugin = {
  id: "opencode-worktree-guardian",
  async server({ client, directory, worktree }: Record<string, any> = {}) {
    const context = { directory, worktree };
    const activeToolCalls = new Set();
    const autoFinishedSessions = new Set();
    const sessionWorktreeCache = new Map();
    const hygieneCleanupPlanCache = new Map<string, string>();

    return {
      tool: {
        guardian_done: guardianTool("guardian_done", "Plan or apply the safest implementation-done path for this repository state.", hygieneCleanupPlanCache),
        guardian_start: guardianTool("guardian_start", "Create or attach this OpenCode session to a guardian-owned worktree.", hygieneCleanupPlanCache),
        guardian_status: guardianTool("guardian_status", "Report guardian state, worktrees, safety refs, stash inventory, and blockers without mutating the repo.", hygieneCleanupPlanCache),
        guardian_delete_worktree: guardianTool("guardian_delete_worktree", "Plan or apply safe Guardian-mediated worktree deletion with confirm-token and safety-ref gates.", hygieneCleanupPlanCache),
        guardian_hygiene_cleanup: guardianTool("guardian_hygiene_cleanup", "Plan or apply token-gated cleanup for exact approved hygiene findings using internal filesystem APIs.", hygieneCleanupPlanCache),
        guardian_unblock_finish: guardianTool("guardian_unblock_finish", "Plan or apply safe finish blocker resolution, such as committing review artifacts with confirm-token gates.", hygieneCleanupPlanCache),
        guardian_finish_workflow: guardianTool("guardian_finish_workflow", "Plan or apply an implementation-done workflow that verifies clean state and removes redundant merged worktrees and branches through Guardian gates.", hygieneCleanupPlanCache),
        guardian_finish: guardianTool("guardian_finish", "Apply the configured gated finish mode for the current guardian-owned worktree.", hygieneCleanupPlanCache),
        guardian_preserve: guardianTool("guardian_preserve", "Mark the current guardian-owned session as terminal/preserved with a safety ref.", hygieneCleanupPlanCache),
        guardian_recover: guardianTool("guardian_recover", "List recovery refs, orphaned sessions, stash inventory, and suggested recovery commands without mutation.", hygieneCleanupPlanCache),
        guardian_report_html: guardianTool("guardian_report_html", "Write a static offline HTML report for guardian sessions, worktrees, branches, risks, and recovery commands.", hygieneCleanupPlanCache),
        guardian_hygiene: guardianTool("guardian_hygiene", "Scan untracked and ignored workspace artifacts for hygiene risks without cleanup or mutation.", hygieneCleanupPlanCache),
      },

      async "experimental.chat.system.transform"(input: any, output: any) {
        let invisibleStart = null;
        try {
          const directoryExists = directory ? await fs.access(directory).then(() => true, () => false) : false;
          const { config } = directoryExists ? await loadConfig(directory) : { config: null };
          if (config) {
            injectInvisiblePolicy(output, config);
            invisibleStart = await tryInvisibleStart(input, context, config);
            rememberSessionWorktree(sessionWorktreeCache, getSessionId(input), invisibleStart);
          }
        } catch (error) {
          invisibleStart = { ok: false, reason: error.message };
        }
        await writeLog(client, createEvent("chat.system.transform", input, output, context, { invisibleStart }));
      },

      async "tool.execute.before"(input: any, output: any) {
        if (input?.callID) activeToolCalls.add(input.callID);
        const command = extractCommandText(input, output);
        const directFileMutation = directFileMutationPathArg(input, output);
        const executionCwd = getExecutionCwd(input, output, context);
        let sessionWorktree: Record<string, any> | null = null;
        try {
          const canResolveSession = Boolean(command || directFileMutation) && await pathExists(directory);
          const actualWorktree = canResolveSession ? await resolveActualWorktreeOrPath(executionCwd) : executionCwd;
          sessionWorktree = canResolveSession ? await resolveSessionWorktree({
            repoRoot: directory,
            cwd: executionCwd,
            actualWorktree,
            sessionId: getSessionId(input),
            cache: sessionWorktreeCache,
            validateBinding: true,
          }) : { ok: true, sessionId: getSessionId(input), expectedWorktree: null, actualWorktree: executionCwd, matches: true, source: "unavailable" };
        } catch (error: any) {
          sessionWorktree = { ok: false, reason: error.message, sessionId: getSessionId(input), expectedWorktree: null, actualWorktree: executionCwd };
        }
        let effectiveCwd = executionCwd;
        let knownWorktreePaths = [worktree].filter(Boolean);
        try {
          knownWorktreePaths = await collectKnownWorktreePaths({
            cwd: effectiveCwd,
            repoRoot: directory,
            currentWorktree: worktree,
          });
        } catch {}
        let guardConfig: Record<string, any> | null = null;
        let guardianBranches: string[] = [];
        let protectedBranchWorktreePaths: string[] = [];
        try {
          if (await pathExists(directory)) {
            guardConfig = (await loadConfig(directory)).config;
            guardianBranches = await collectRecordedBranches(directory, guardConfig);
            protectedBranchWorktreePaths = await collectProtectedBranchWorktrees(directory, guardConfig);
          }
        } catch {}
        let currentBranch: string | null = null;
        try {
          currentBranch = await getCurrentBranch(effectiveCwd);
        } catch {}
        let guard = classifyGuardCommand(command, {
          cwd: effectiveCwd,
          knownWorktreePaths,
          protectedBranches: guardConfig?.protectedBranches,
          branchPrefix: guardConfig?.branchPrefix,
          guardianBranches,
          protectedBranchWorktreePaths,
          currentBranch,
        });
        const readOnly = sessionWorktree?.ok === false ? classifyReadOnlyInspectionCommand(command) : { allowed: true, reason: null };
        let routed = false;
        const directFileRoute = await routeDirectFileMutation(input, output, sessionWorktree, directory, sessionWorktreeCache);
        if (directFileRoute.blocked) {
          if (input?.callID) activeToolCalls.delete(input.callID);
          await writeLog(client, createEvent("tool.execute.before", input, output, context, { guard, sessionWorktree, readOnly, routed, directFileRoute }));
          throw new Error(`Worktree Guardian blocked direct file mutation: ${directFileRoute.reason}. Use guardian_status to inspect the recorded worktree.`);
        }
        if (directFileRoute.routed) routed = true;
        if (guard.blocked) {
          if (input?.callID) activeToolCalls.delete(input.callID);
          await writeLog(client, createEvent("tool.execute.before", input, output, context, { guard, sessionWorktree, readOnly, routed }));
          throw new Error(`Worktree Guardian blocked command: ${guard.reason}. Use guardian_status or guardian_finish instead.`);
        }
        if (command && sessionWorktree?.ok === false && !readOnly.allowed) {
          try {
            sessionWorktree = await routeRecordedSessionCommand(input, output, sessionWorktree, directory, sessionWorktreeCache);
            effectiveCwd = output.args.workdir;
            routed = true;
            knownWorktreePaths = await collectKnownWorktreePaths({
              cwd: effectiveCwd,
              repoRoot: directory,
              currentWorktree: worktree,
            });
            currentBranch = await getCurrentBranch(effectiveCwd).catch(() => null);
            guard = classifyGuardCommand(command, {
              cwd: effectiveCwd,
              knownWorktreePaths,
              protectedBranches: guardConfig?.protectedBranches,
              branchPrefix: guardConfig?.branchPrefix,
              guardianBranches,
              protectedBranchWorktreePaths,
              currentBranch,
            });
          } catch (error: any) {
            if (input?.callID) activeToolCalls.delete(input.callID);
            await writeLog(client, createEvent("tool.execute.before", input, output, context, { guard, sessionWorktree, readOnly, routed, routeError: error.message }));
            throw new Error(`Worktree Guardian blocked command: ${error.message}. Use guardian_status to inspect the recorded worktree.`);
          }
        }
        await writeLog(client, createEvent("tool.execute.before", input, output, context, { guard, sessionWorktree, readOnly, routed }));
        if (command && sessionWorktree?.ok === false && (sessionWorktree.reason || !readOnly.allowed)) {
          if (input?.callID) activeToolCalls.delete(input.callID);
          throw new Error(`Worktree Guardian blocked command: session ${sessionWorktree.sessionId} is recorded for expected worktree ${sessionWorktree.expectedWorktree ?? "an unknown worktree"} but actual cwd is ${executionCwd} and actual worktree is ${sessionWorktree.actualWorktree}. Use guardian_status to inspect the recorded worktree.`);
        }
        if (guard.blocked) {
          if (input?.callID) activeToolCalls.delete(input.callID);
          throw new Error(`Worktree Guardian blocked command: ${guard.reason}. Use guardian_status or guardian_finish instead.`);
        }
      },

      async "tool.execute.after"(input: any, output: any) {
        if (input?.callID) activeToolCalls.delete(input.callID);
        let lastSafeState = null;
        try {
          const executionCwd = getExecutionCwd(input, output, context);
          const canResolveSession = await pathExists(directory);
          const actualWorktree = canResolveSession ? await getActualWorktree(executionCwd) : executionCwd;
          const sessionWorktree = canResolveSession ? await resolveSessionWorktree({
            repoRoot: directory,
            cwd: executionCwd,
            actualWorktree,
            sessionId: getSessionId(input),
            cache: sessionWorktreeCache,
          }) : null;
          if (sessionWorktree?.ok === false) {
            lastSafeState = { ok: false, reason: "session worktree mismatch", sessionWorktree };
            await writeLog(client, createEvent("tool.execute.after", input, output, context, { lastSafeState }));
            return;
          }
          lastSafeState = await recordLastSafeState({
            cwd: executionCwd,
            repoRoot: directory,
            sessionId: getSessionId(input),
            tool: input?.tool,
          });
        } catch (error) {
          lastSafeState = { ok: false, reason: error.message };
        }
        await writeLog(client, createEvent("tool.execute.after", input, output, context, { lastSafeState }));
      },

      async "command.execute.before"(input: any, output: any) {
        const rewritten = rewriteGuardianCommand(input, output);
        await writeLog(client, createEvent("command.execute.before", input, output, context, { rewritten }));
      },

      async event(input: any) {
        const event = input?.event;
        let autoFinish = null;
        if (event?.type === "session.idle") {
          const sessionId = event.properties?.sessionID ?? event.properties?.sessionId ?? event.sessionID ?? event.sessionId;
          if (sessionId && !autoFinishedSessions.has(sessionId) && activeToolCalls.size === 0 && directory) {
            try {
              const { config } = await loadConfig(directory);
              if (config.autoFinish === true) {
                const executionCwd = worktree ?? directory;
                const recordedSessionWorktree = await resolveSessionWorktree({
                  repoRoot: directory,
                  cwd: executionCwd,
                  actualWorktree: executionCwd,
                  sessionId,
                  cache: sessionWorktreeCache,
                  config,
                });
                const validationCwd = recordedSessionWorktree.expectedWorktree ?? executionCwd;
                const validationWorktree = await resolveActualWorktreeOrPath(validationCwd);
                const sessionWorktree = await resolveSessionWorktree({
                  repoRoot: directory,
                  cwd: validationCwd,
                  actualWorktree: validationWorktree,
                  sessionId,
                  cache: sessionWorktreeCache,
                  config,
                  validateBinding: true,
                });
                if (sessionWorktree?.ok !== true) {
                  autoFinish = {
                    ok: false,
                    status: "blocked",
                    reason: `recorded session cannot be auto-finished: ${sessionWorktree?.reason ?? "session worktree binding is invalid"}; rerun guardian_start with createWorktree=true`,
                    sessionWorktree,
                    suggestedCommand: "guardian_start createWorktree=true",
                  };
                } else {
                  autoFinish = await runGuardianTool("guardian_finish", {
                    repoRoot: directory,
                    cwd: sessionWorktree.expectedWorktree ?? executionCwd,
                    sessionId,
                    finishMode: config.finishMode,
                  });
                }
                if (autoFinish?.ok === true) autoFinishedSessions.add(sessionId);
              }
            } catch (error) {
              autoFinish = { ok: false, reason: error.message };
            }
          }
        }
        if (autoFinish) await writeLog(client, createEvent("event", input, {}, context, { autoFinish }));
      },
    };
  },
};

export default WorktreeGuardianPlugin;
