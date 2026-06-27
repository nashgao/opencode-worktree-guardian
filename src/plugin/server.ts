import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.ts";
import { getCurrentBranch } from "../git.ts";
import { classifyGuardCommand, classifyNormalAgentGitCommand, classifyReadOnlyInspectionCommand, extractCommandText } from "../guards.ts";
import { guardianStart } from "../start.ts";
import { collectKnownWorktreePaths, resolveSessionWorktree } from "../session/worktree-binding.ts";
import { recordLastSafeState } from "../session/last-safe-state.ts";
import { runGuardianTool } from "../tool-registry.ts";
import type { GuardCommandPayload, GuardianConfig, GuardianToolInput, GuardianToolResult, HookContext, PlanTokenCache, PluginServerOptions, RecordLike, SessionWorktreeResult } from "../types.ts";
import { errorMessage, isRecordLike } from "../types.ts";
import { routeDirectFileMutation, directFileMutationPathArg } from "./direct-file-routing.ts";
import { writeLog, createEvent } from "./event-log.ts";
import { collectGuardContext } from "./guard-context.ts";
import { getExecutionCwd, getIdleEventSessionId, getSessionId, getStringSessionId } from "./hook-context.ts";
import { injectInvisiblePolicy } from "./invisible-policy.ts";
import { guardianTool } from "./native-tool.ts";
import { rewriteGuardianCommand } from "./slash-commands.ts";
import { canFallbackToNormalGit, getActualWorktree, pathExists, rememberSessionWorktree, resolveActualWorktreeOrPath, routeRecordedSessionCommand } from "./session-routing.ts";

async function tryInvisibleStart(input: GuardCommandPayload, context: HookContext, config: GuardianConfig) {
  const sessionId = getSessionId(input);
  if (!config.autoStart || config.autoStartMode !== "eager" || !sessionId || !context.directory) return null;
  try {
    return await guardianStart({
      repoRoot: context.directory,
      cwd: context.worktree ?? context.directory,
      sessionId,
      taskName: input?.taskName ?? "session",
      createWorktree: context.worktree == null || context.worktree === context.directory,
      config,
    });
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

function isPathInside(parent: string, candidate: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function directFileMutationTargetsRepo(input: GuardCommandPayload, output: GuardCommandPayload, repoRoot: string | undefined) {
  const pathArg = directFileMutationPathArg(input, output);
  return Boolean(pathArg && repoRoot && isPathInside(repoRoot, pathArg.value));
}

async function tryLazyStart(input: GuardCommandPayload, output: GuardCommandPayload, context: HookContext, config: GuardianConfig | null, sessionWorktree: SessionWorktreeResult | null, command: unknown, readOnly: { readonly allowed: boolean }, guardBlocked: boolean, executionCwd: string, cache: Map<string, string>) {
  const sessionId = getSessionId(input);
  const shouldStart = config?.autoStart === true
    && config.autoStartMode === "lazy"
    && !guardBlocked
    && Boolean(sessionId)
    && Boolean(context.directory)
    && sessionWorktree?.terminal !== true
    && typeof sessionWorktree?.expectedWorktree !== "string"
    && (directFileMutationTargetsRepo(input, output, context.directory) || Boolean(typeof command === "string" && command.length > 0 && !readOnly.allowed));
  if (!shouldStart || !sessionId || !context.directory) return null;

  const result = await guardianStart({
    repoRoot: context.directory,
    cwd: executionCwd,
    sessionId,
    taskName: input.taskName ?? "session",
    createWorktree: true,
    config,
  });
  rememberSessionWorktree(cache, sessionId, result);
  if (result.ok !== true) return { result, sessionWorktree };

  const actualWorktree = await resolveActualWorktreeOrPath(executionCwd);
  const resolved = await resolveSessionWorktree({
    repoRoot: context.directory,
    cwd: executionCwd,
    actualWorktree,
    sessionId,
    cache,
    validateBinding: true,
  });
  return { result, sessionWorktree: resolved };
}

function createTools(planCache: PlanTokenCache) {
  return {
    guardian_done: guardianTool("guardian_done", "Plan or apply the safest implementation-done path for this repository state. Pass all=true to finish every active Guardian session in one gated plan/apply pass.", planCache),
    guardian_start: guardianTool("guardian_start", "Create or attach this OpenCode session to a guardian-owned worktree.", planCache),
    guardian_status: guardianTool("guardian_status", "Report guardian state, worktrees, safety refs, stash inventory, and blockers without mutating the repo.", planCache),
    guardian_delete_paths: guardianTool("guardian_delete_paths", "Plan or apply exact path deletion with confirm-token, fingerprint, tracked-file, recursive, and protected-root gates.", planCache),
    guardian_delete_worktree: guardianTool("guardian_delete_worktree", "Plan or apply safe Guardian-mediated worktree deletion with confirm-token and safety-ref gates.", planCache),
    guardian_unblock_finish: guardianTool("guardian_unblock_finish", "Plan or apply safe finish blocker resolution, such as committing review artifacts with confirm-token gates.", planCache),
    guardian_finish_workflow: guardianTool("guardian_finish_workflow", "Plan or apply an implementation-done workflow that verifies clean state and removes redundant merged worktrees and branches through Guardian gates.", planCache),
    guardian_finish: guardianTool("guardian_finish", "Apply the configured gated finish mode for the current Guardian worktree.", planCache),
    guardian_preserve: guardianTool("guardian_preserve", "Mark the current Guardian worktree as terminal/preserved with a safety ref.", planCache),
    guardian_project_status: guardianTool("guardian_project_status", "Read project roadmap, milestone, plan, and ULW evidence into a static project intelligence snapshot.", planCache),
    guardian_recover: guardianTool("guardian_recover", "List recovery refs, orphaned sessions, stash inventory, and suggested recovery commands without mutation.", planCache),
    guardian_report_html: guardianTool("guardian_report_html", "Write a static offline HTML report for guardian sessions, worktrees, branches, risks, and recovery commands.", planCache),
    guardian_hygiene: guardianTool("guardian_hygiene", "Scan, plan, or apply token-gated cleanup for workspace hygiene findings.", planCache),
    guardian_gc: guardianTool("guardian_gc", "Plan or apply record-only Guardian state cleanup of stale terminal, poisoned, and orphaned session records.", planCache),
  };
}

async function resolveHookSessionWorktree(input: GuardCommandPayload, output: GuardCommandPayload, context: HookContext, pluginDirectory: string | undefined, sessionWorktreeCache: Map<string, string>) {
  const command = extractCommandText(input, output);
  const directFileMutation = directFileMutationPathArg(input, output);
  const executionCwd = getExecutionCwd(input, output, context);
  let sessionWorktree: SessionWorktreeResult | null = null;
  try {
    const canResolveSession = Boolean(command || directFileMutation) && pluginDirectory !== undefined && await pathExists(pluginDirectory);
    const actualWorktree = canResolveSession ? await resolveActualWorktreeOrPath(executionCwd) : executionCwd;
    sessionWorktree = canResolveSession ? await resolveSessionWorktree({
      repoRoot: context.directory,
      cwd: executionCwd,
      actualWorktree,
      sessionId: getStringSessionId(input),
      cache: sessionWorktreeCache,
      validateBinding: true,
    }) : { ok: true, sessionId: getStringSessionId(input), expectedWorktree: null, actualWorktree: executionCwd, matches: true, source: "unavailable" };
  } catch (error) {
    sessionWorktree = { ok: false, reason: errorMessage(error), sessionId: getStringSessionId(input), expectedWorktree: null, actualWorktree: executionCwd };
  }
  return { command, executionCwd, sessionWorktree };
}

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
          invisibleStart = { ok: false, reason: errorMessage(error) };
        }
        await writeLog(client, createEvent("chat.system.transform", input, output, context, { invisibleStart }));
      },

      async "tool.execute.before"(input: GuardCommandPayload, output: GuardCommandPayload) {
        if (input.callID) activeToolCalls.add(input.callID);
        const { command, executionCwd, sessionWorktree: initialSessionWorktree } = await resolveHookSessionWorktree(input, output, context, pluginDirectory, sessionWorktreeCache);
        let sessionWorktree = initialSessionWorktree;
        let effectiveCwd = executionCwd;
        let knownWorktreePaths = typeof worktree === "string" ? [worktree] : [];
        try {
          knownWorktreePaths = await collectKnownWorktreePaths({ cwd: effectiveCwd, repoRoot: directory, currentWorktree: worktree });
        } catch {}
        const guardContext = await collectGuardContext({ pluginDirectory, effectiveCwd });
        let guard = classifyGuardCommand(command, {
          cwd: effectiveCwd,
          repoRoot: directory,
          knownWorktreePaths,
          protectedBranches: guardContext.guardConfig?.protectedBranches,
          branchPrefix: guardContext.guardConfig?.branchPrefix,
          guardianBranches: guardContext.guardianBranches,
          protectedBranchWorktreePaths: guardContext.protectedBranchWorktreePaths,
          currentBranch: guardContext.currentBranch,
        });
        const readOnly = classifyReadOnlyInspectionCommand(command);
        const normalAgentGit = classifyNormalAgentGitCommand(command, {
          cwd: effectiveCwd,
          protectedBranches: guardContext.guardConfig?.protectedBranches,
          branchPrefix: guardContext.guardConfig?.branchPrefix,
          guardianBranches: guardContext.guardianBranches,
          protectedBranchWorktreePaths: guardContext.protectedBranchWorktreePaths,
          currentBranch: guardContext.currentBranch,
        });
        let routed = false;
        const lazyStart = await tryLazyStart(input, output, context, guardContext.guardConfig, sessionWorktree, command, readOnly, guard.blocked, effectiveCwd, sessionWorktreeCache);
        if (lazyStart?.result.ok === false) {
          if (input.callID) activeToolCalls.delete(input.callID);
          await writeLog(client, createEvent("tool.execute.before", input, output, context, { guard, sessionWorktree, readOnly, normalAgentGit, routed, lazyStart: lazyStart.result }));
          throw new Error(`Worktree Guardian blocked command: lazy auto-start failed: ${lazyStart.result.reason ?? "unknown reason"}. Use guardian_status to inspect the recorded worktree.`);
        }
        if (lazyStart?.sessionWorktree) sessionWorktree = lazyStart.sessionWorktree;
        const directFileRoute = await routeDirectFileMutation(input, output, sessionWorktree, directory, sessionWorktreeCache);
        if (directFileRoute.blocked) {
          if (input.callID) activeToolCalls.delete(input.callID);
          await writeLog(client, createEvent("tool.execute.before", input, output, context, { guard, sessionWorktree, readOnly, normalAgentGit, routed, directFileRoute }));
          throw new Error(`Worktree Guardian blocked direct file mutation: ${directFileRoute.reason}. Use guardian_status to inspect the recorded worktree.`);
        }
        if (directFileRoute.routed) routed = true;
        if (guard.blocked) {
          if (input.callID) activeToolCalls.delete(input.callID);
          await writeLog(client, createEvent("tool.execute.before", input, output, context, { guard, sessionWorktree, readOnly, normalAgentGit, routed }));
          throw new Error(`Worktree Guardian blocked command: ${guard.reason}. Use guardian_status or guardian_finish instead.`);
        }
        if (command && sessionWorktree?.ok === false && !readOnly.allowed) {
          try {
            sessionWorktree = await routeRecordedSessionCommand(input, output, sessionWorktree, directory, sessionWorktreeCache);
            effectiveCwd = typeof output.args?.workdir === "string" ? output.args.workdir : effectiveCwd;
            routed = true;
            knownWorktreePaths = await collectKnownWorktreePaths({ cwd: effectiveCwd, repoRoot: directory, currentWorktree: worktree });
            const currentBranch = await getCurrentBranch(effectiveCwd).catch(() => null);
            guard = classifyGuardCommand(command, {
              cwd: effectiveCwd,
              repoRoot: directory,
              knownWorktreePaths,
              protectedBranches: guardContext.guardConfig?.protectedBranches,
              branchPrefix: guardContext.guardConfig?.branchPrefix,
              guardianBranches: guardContext.guardianBranches,
              protectedBranchWorktreePaths: guardContext.protectedBranchWorktreePaths,
              currentBranch,
            });
          } catch (error) {
            await writeLog(client, createEvent("tool.execute.before", input, output, context, { guard, sessionWorktree, readOnly, normalAgentGit, routed, routeError: errorMessage(error) }));
            if (!canFallbackToNormalGit(error, normalAgentGit)) {
              if (input.callID) activeToolCalls.delete(input.callID);
              throw new Error(`Worktree Guardian blocked command: ${errorMessage(error)}. Use guardian_status to inspect the recorded worktree.`);
            }
          }
        }
        await writeLog(client, createEvent("tool.execute.before", input, output, context, { guard, sessionWorktree, readOnly, normalAgentGit, routed }));
        if (command && sessionWorktree?.ok === false && !normalAgentGit.allowed && (sessionWorktree.reason || !readOnly.allowed)) {
          if (input.callID) activeToolCalls.delete(input.callID);
          throw new Error(`Worktree Guardian blocked command: session ${sessionWorktree.sessionId} is recorded for expected worktree ${sessionWorktree.expectedWorktree ?? "an unknown worktree"} but actual cwd is ${executionCwd} and actual worktree is ${sessionWorktree.actualWorktree}. Use guardian_status to inspect the recorded worktree.`);
        }
        if (guard.blocked) {
          if (input.callID) activeToolCalls.delete(input.callID);
          throw new Error(`Worktree Guardian blocked command: ${guard.reason}. Use guardian_status or guardian_finish instead.`);
        }
      },

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
