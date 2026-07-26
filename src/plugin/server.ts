import fs from "node:fs/promises";
import { loadConfig } from "../config.ts";
import { resolveSessionWorktree } from "../session/worktree-binding.ts";
import { recordLastSafeState } from "../session/last-safe-state.ts";
import { runGuardianTool } from "../tool-registry.ts";
import type { GuardCommandPayload, GuardianToolInput, GuardianToolResult, PlanTokenCache, PluginServerOptions, RecordLike } from "../types.ts";
import { errorMessage, isRecordLike } from "../types.ts";
import { writeLog, createEvent } from "./event-log.ts";
import { tryInvisibleStart } from "./auto-start.ts";
import { createToolExecuteBefore } from "./command-interception.ts";
import { getExecutionCwd, getIdleEventSessionId, getSessionId, getStringSessionId } from "./hook-context.ts";
import { injectInvisiblePolicy } from "./invisible-policy.ts";
import { rewriteGuardianCommand } from "./slash-commands.ts";
import { getActualWorktree, pathExists, rememberSessionWorktree, resolveActualWorktreeOrPath } from "./session-routing.ts";
import { createTools } from "./tool-definitions.ts";

const WorktreeGuardianPlugin = {
  id: "opencode-worktree-guardian",
  async server({ client, directory, worktree }: PluginServerOptions = {}) {
    const context = { directory, worktree };
    const pluginDirectory = typeof directory === "string" ? directory : undefined;
    const activeToolCalls = new Set<unknown>();
    const autoFinishedSessions = new Set<unknown>();
    const sessionWorktreeCache = new Map<string, string>();
    const planCache: PlanTokenCache = new Map();

    return {
      tool: createTools(planCache),

      async "experimental.chat.system.transform"(input: GuardCommandPayload, output: GuardianToolInput) {
        let invisibleStart: GuardianToolResult | null = null;
        try {
          const directoryExists = pluginDirectory ? await fs.access(pluginDirectory).then(() => true, () => false) : false;
          const { config } = directoryExists && pluginDirectory ? await loadConfig(pluginDirectory) : { config: null };
          if (config) {
            injectInvisiblePolicy(output, config);
            invisibleStart = await tryInvisibleStart(input, context, config);
            rememberSessionWorktree(sessionWorktreeCache, getSessionId(input), invisibleStart);
          }
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          invisibleStart = { ok: false, reason: errorMessage(error) };
        }
        await writeLog(client, createEvent("chat.system.transform", input, output, context, { invisibleStart }));
      },

      "tool.execute.before": createToolExecuteBefore({ client, directory, worktree, activeToolCalls, sessionWorktreeCache }),

      async "tool.execute.after"(input: GuardCommandPayload, output: GuardCommandPayload) {
        if (input.callID) activeToolCalls.delete(input.callID);
        let lastSafeState: GuardianToolResult | null = null;
        try {
          const executionCwd = getExecutionCwd(input, output, context);
          const canResolveSession = await pathExists(directory);
          const actualWorktree = canResolveSession ? await getActualWorktree(executionCwd) : executionCwd;
          const sessionWorktree = canResolveSession ? await resolveSessionWorktree({
            repoRoot: directory,
            cwd: executionCwd,
            actualWorktree,
            sessionId: getStringSessionId(input),
            cache: sessionWorktreeCache,
          }) : null;
          if (sessionWorktree?.ok === false) {
            lastSafeState = { ok: false, reason: "session worktree mismatch", sessionWorktree };
            await writeLog(client, createEvent("tool.execute.after", input, output, context, { lastSafeState }));
            return;
          }
          lastSafeState = await recordLastSafeState({ cwd: executionCwd, repoRoot: directory, sessionId: getStringSessionId(input), tool: input.tool });
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          lastSafeState = { ok: false, reason: errorMessage(error) };
        }
        await writeLog(client, createEvent("tool.execute.after", input, output, context, { lastSafeState }));
      },

      async "command.execute.before"(input: GuardCommandPayload, output: GuardCommandPayload) {
        const rewritten = rewriteGuardianCommand(input, output);
        await writeLog(client, createEvent("command.execute.before", input, output, context, { rewritten }));
      },

      async event(input: RecordLike) {
        const event = isRecordLike(input.event) ? input.event : null;
        let autoFinish: GuardianToolResult | null = null;
        if (event?.type === "session.idle") {
          const sessionId = getIdleEventSessionId(input);
          if (sessionId && !autoFinishedSessions.has(sessionId) && activeToolCalls.size === 0 && directory) {
            try {
              const { config } = await loadConfig(directory);
              if (config.autoFinish === true) {
                const executionCwd = worktree ?? directory;
                const recordedSessionWorktree = await resolveSessionWorktree({ repoRoot: directory, cwd: executionCwd, actualWorktree: executionCwd, sessionId, cache: sessionWorktreeCache, config });
                const validationCwd = recordedSessionWorktree.expectedWorktree ?? executionCwd;
                const validationWorktree = await resolveActualWorktreeOrPath(validationCwd);
                const sessionWorktree = await resolveSessionWorktree({ repoRoot: directory, cwd: validationCwd, actualWorktree: validationWorktree, sessionId, cache: sessionWorktreeCache, config, validateBinding: true });
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
              if (!(error instanceof Error)) throw error;
              autoFinish = { ok: false, reason: errorMessage(error) };
            }
          }
        }
        if (autoFinish) await writeLog(client, createEvent("event", input, {}, context, { autoFinish }));
      },
    };
  },
};

export default WorktreeGuardianPlugin;
