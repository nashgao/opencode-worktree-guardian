import fs from "node:fs/promises";
import { tool } from "@opencode-ai/plugin";
import { loadConfig } from "./config.ts";
import { getCurrentBranch } from "./git.ts";
import { classifyGuardCommand, classifyReadOnlyInspectionCommand, extractCommandText } from "./guards.ts";
import { collectKnownWorktreePaths, guardianStart, injectInvisiblePolicy, recordLastSafeState, resolveSessionWorktree, rewriteGuardianCommand, runGuardianTool } from "./tools.ts";

export { DEFAULT_CONFIG, FINISH_MODES, loadConfig, normalizeConfig } from "./config.ts";
export { classifyGuardCommand, classifyReadOnlyInspectionCommand, extractCommandText, tokenizeCommand } from "./guards.ts";
export { buildPreservedRef, buildSafetyRef, createSafetyRef, getRepoRoot, listWorktrees, runGit } from "./git.ts";
export { acquireStateLock, appendEvent, getGuardianPaths, readState, recordSession, updateState, writeReportAtomic, writeStateAtomic } from "./state.ts";
export { guardianFinish } from "./finish.ts";
export { guardianRecover, guardianStatus } from "./recover.ts";
export { guardianReportHtml, renderGuardianReportHtml } from "./report.ts";
export { buildInvisiblePolicy, collectKnownWorktreePaths, guardianPreserve, guardianStart, injectInvisiblePolicy, recordLastSafeState, resolveSessionWorktree, rewriteGuardianCommand, runGuardianTool } from "./tools.ts";

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
  return output?.args?.cwd ?? input?.args?.cwd ?? input?.cwd ?? context.worktree ?? context.directory ?? process.cwd();
}

function rememberSessionWorktree(cache: Map<string, string>, sessionId: string | undefined, result: Record<string, any> | null) {
  const worktreePath = result?.session?.worktree_path;
  if (sessionId && result?.ok === true && typeof worktreePath === "string") cache.set(sessionId, worktreePath);
}

async function pathExists(candidate: string | undefined) {
  if (!candidate) return false;
  return fs.access(candidate).then(() => true, () => false);
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


const READABLE_GUARDIAN_TOOLS = new Set(["guardian_status", "guardian_recover", "guardian_report_html"]);

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

  const sessions = arrayValue(result.sessions);
  lines.push(`[INFO] sessions: ${sessions.length}`);
  for (const entry of sessions.slice(0, 12)) {
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

function formatGuardianOutput(name: string, result: unknown) {
  if (name === "guardian_report_html") return formatGuardianReportOutput(result);
  return formatGuardianStatusOutput(name, result);
}

function guardianTool(name: string, description: string) {
  return tool({
    description,
    args: {
      repoRoot: z.string().optional(),
      cwd: z.string().optional(),
      sessionId: z.string().optional(),
      taskName: z.string().optional(),
      branch: z.string().optional(),
      worktreePath: z.string().optional(),
      createWorktree: z.boolean().optional(),
      finishMode: z.enum(["preserve-only", "push-branch", "create-pr", "merge-to-base"]).optional(),
      allowMergeToBase: z.boolean().optional(),
    },
    async execute(args: Record<string, any>, context: any) {
      context.metadata({ title: name });
      const result = await runGuardianTool(name, args);
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

    return {
      tool: {
        guardian_start: guardianTool("guardian_start", "Create or attach this OpenCode session to a guardian-owned worktree."),
        guardian_status: guardianTool("guardian_status", "Report guardian state, worktrees, safety refs, stash inventory, and blockers without mutating the repo."),
        guardian_finish: guardianTool("guardian_finish", "Apply the configured gated finish mode for the current guardian-owned worktree."),
        guardian_preserve: guardianTool("guardian_preserve", "Mark the current guardian-owned worktree as intentionally preserved."),
        guardian_recover: guardianTool("guardian_recover", "List recovery refs, orphaned sessions, stash inventory, and suggested recovery commands without mutation."),
        guardian_report_html: guardianTool("guardian_report_html", "Write a static offline HTML report for guardian sessions, worktrees, branches, risks, and recovery commands."),
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
        const executionCwd = getExecutionCwd(input, output, context);
        let sessionWorktree: Record<string, any> | null = null;
        try {
          const canResolveSession = Boolean(command) && await pathExists(directory);
          sessionWorktree = canResolveSession ? await resolveSessionWorktree({
            repoRoot: directory,
            cwd: executionCwd,
            actualWorktree: executionCwd,
            sessionId: getSessionId(input),
            cache: sessionWorktreeCache,
          }) : { ok: true, sessionId: getSessionId(input), expectedWorktree: null, actualWorktree: executionCwd, matches: true, source: "unavailable" };
        } catch (error: any) {
          sessionWorktree = { ok: false, reason: error.message, sessionId: getSessionId(input), expectedWorktree: null, actualWorktree: executionCwd };
        }
        let knownWorktreePaths = [worktree].filter(Boolean);
        try {
          knownWorktreePaths = await collectKnownWorktreePaths({
            cwd: executionCwd,
            repoRoot: directory,
            currentWorktree: worktree,
          });
        } catch {}
        let guardConfig: Record<string, any> | null = null;
        try {
          if (await pathExists(directory)) guardConfig = (await loadConfig(directory)).config;
        } catch {}
        let currentBranch: string | null = null;
        try {
          currentBranch = await getCurrentBranch(executionCwd);
        } catch {}
        const guard = classifyGuardCommand(command, {
          cwd: executionCwd,
          knownWorktreePaths,
          protectedBranches: guardConfig?.protectedBranches,
          branchPrefix: guardConfig?.branchPrefix,
          currentBranch,
        });
        const readOnly = sessionWorktree?.ok === false ? classifyReadOnlyInspectionCommand(command) : { allowed: true, reason: null };
        await writeLog(client, createEvent("tool.execute.before", input, output, context, { guard, sessionWorktree, readOnly }));
        if (command && sessionWorktree?.ok === false && (sessionWorktree.reason || !readOnly.allowed)) {
          if (input?.callID) activeToolCalls.delete(input.callID);
          throw new Error(`Worktree Guardian blocked command: session ${sessionWorktree.sessionId} is recorded for expected worktree ${sessionWorktree.expectedWorktree ?? "an unknown worktree"} but actual cwd is ${executionCwd} and actual worktree is ${sessionWorktree.actualWorktree}. Use guardian_status or start OpenCode in the recorded worktree.`);
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
          const sessionWorktree = canResolveSession ? await resolveSessionWorktree({
            repoRoot: directory,
            cwd: executionCwd,
            actualWorktree: executionCwd,
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
                const sessionWorktree = await resolveSessionWorktree({
                  repoRoot: directory,
                  cwd: executionCwd,
                  actualWorktree: executionCwd,
                  sessionId,
                  cache: sessionWorktreeCache,
                  config,
                });
                autoFinish = await runGuardianTool("guardian_finish", {
                  repoRoot: directory,
                  cwd: sessionWorktree.expectedWorktree ?? executionCwd,
                  sessionId,
                  finishMode: config.finishMode,
                });
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
