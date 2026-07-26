import { classifyReadOnlyInspectionCommand, extractCommandText } from "../guards.ts";
import { resolveSessionWorktree } from "../session/worktree-binding.ts";
import type { GuardCommandPayload, HookContext, PluginClient, SessionWorktreeResult } from "../types.ts";
import { errorMessage } from "../types.ts";
import { tryLazyStart } from "./auto-start.ts";
import { directFileMutationPathArg, routeDirectFileMutation } from "./direct-file-routing.ts";
import { createEvent, writeLog } from "./event-log.ts";
import { evaluateGuardCommand } from "./guard-evaluation.ts";
import { getExecutionCwd, getStringSessionId } from "./hook-context.ts";
import { canFallbackToNormalGit, pathExists, resolveActualWorktreeOrPath, routeRecordedSessionCommand } from "./session-routing.ts";

export type ToolExecuteBeforeDependencies = {
  readonly client: PluginClient | undefined;
  readonly directory: string | undefined;
  readonly worktree: string | undefined;
  readonly activeToolCalls: Set<unknown>;
  readonly sessionWorktreeCache: Map<string, string>;
};

async function resolveHookSessionWorktree(input: GuardCommandPayload, output: GuardCommandPayload, context: HookContext, pluginDirectory: string | undefined, sessionWorktreeCache: Map<string, string>) {
  const command = extractCommandText(input, output);
  const executionCwd = getExecutionCwd(input, output, context);
  const directFileMutation = directFileMutationPathArg(input, output, executionCwd);
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
    if (!(error instanceof Error)) throw error;
    sessionWorktree = { ok: false, reason: errorMessage(error), sessionId: getStringSessionId(input), expectedWorktree: null, actualWorktree: executionCwd };
  }
  return { command, executionCwd, sessionWorktree };
}

export function createToolExecuteBefore(dependencies: ToolExecuteBeforeDependencies) {
  const { client, directory, worktree, activeToolCalls, sessionWorktreeCache } = dependencies;
  const context = { directory, worktree };
  const pluginDirectory = typeof directory === "string" ? directory : undefined;

  return async function toolExecuteBefore(input: GuardCommandPayload, output: GuardCommandPayload) {
    if (input.callID) activeToolCalls.add(input.callID);
    const { command, executionCwd, sessionWorktree: initialSessionWorktree } = await resolveHookSessionWorktree(input, output, context, pluginDirectory, sessionWorktreeCache);
    let sessionWorktree = initialSessionWorktree;
    let effectiveCwd = executionCwd;
    let evaluation = await evaluateGuardCommand({ command: typeof command === "string" ? command : "", cwd: effectiveCwd, currentWorktree: worktree, fallbackRepoRoot: directory, fallbackKnownWorktreePaths: typeof worktree === "string" ? [worktree] : [] });
    let guard = evaluation.guard;
    const readOnly = classifyReadOnlyInspectionCommand(command);
    let normalAgentGit = evaluation.normalAgentGit;
    let routed = false;
    const lazyStart = await tryLazyStart({
      input,
      output,
      context,
       config: evaluation.config,
      sessionWorktree,
      command,
      readOnly,
       guardBlocked: evaluation.enforcedGuard.blocked,
      executionCwd: effectiveCwd,
      cache: sessionWorktreeCache,
    });
    if (lazyStart?.result.ok === false) {
       if (evaluation.strictMode && input.callID) activeToolCalls.delete(input.callID);
       await writeLog(client, createEvent("tool.execute.before", input, output, context, { guard, sessionWorktree, readOnly, normalAgentGit, routed, lazyStart: lazyStart.result, ...(evaluation.auditOnly ? { auditOnly: true } : {}) }));
       if (!evaluation.strictMode) return;
      throw new Error(`Worktree Guardian blocked command: lazy auto-start failed: ${lazyStart.result.reason ?? "unknown reason"}. Use guardian_status to inspect the recorded worktree.`);
    }
    if (lazyStart?.sessionWorktree) sessionWorktree = lazyStart.sessionWorktree;
    const directFileRoute = await routeDirectFileMutation(input, output, sessionWorktree, directory, effectiveCwd, sessionWorktreeCache);
    if (directFileRoute.blocked) {
       if (evaluation.strictMode && input.callID) activeToolCalls.delete(input.callID);
       await writeLog(client, createEvent("tool.execute.before", input, output, context, { guard, sessionWorktree, readOnly, normalAgentGit, routed, directFileRoute, ...(!evaluation.strictMode ? { auditOnly: true } : {}) }));
       if (!evaluation.strictMode) return;
      throw new Error(`Worktree Guardian blocked direct file mutation: ${directFileRoute.reason}. Use guardian_status to inspect the recorded worktree.`);
    }
    if (directFileRoute.routed) routed = true;
    if (evaluation.enforcedGuard.blocked) {
      if (input.callID) activeToolCalls.delete(input.callID);
      await writeLog(client, createEvent("tool.execute.before", input, output, context, { guard, sessionWorktree, readOnly, normalAgentGit, routed }));
      throw new Error(`Worktree Guardian blocked command: ${guard.reason}. Use guardian_status or guardian_finish instead.`);
    }
    if (command && sessionWorktree?.ok === false && !readOnly.allowed) {
      try {
        sessionWorktree = await routeRecordedSessionCommand(input, output, sessionWorktree, directory, sessionWorktreeCache);
        effectiveCwd = typeof output.args?.workdir === "string" ? output.args.workdir : effectiveCwd;
        routed = true;
         evaluation = await evaluateGuardCommand({ command: typeof command === "string" ? command : "", cwd: effectiveCwd, currentWorktree: worktree, fallbackRepoRoot: directory, fallbackKnownWorktreePaths: typeof worktree === "string" ? [worktree] : [] });
         guard = evaluation.guard;
         normalAgentGit = evaluation.normalAgentGit;
      } catch (error) {
        if (!(error instanceof Error)) throw error;
         await writeLog(client, createEvent("tool.execute.before", input, output, context, { guard, sessionWorktree, readOnly, normalAgentGit, routed, routeError: errorMessage(error), ...(!evaluation.strictMode ? { auditOnly: true } : {}) }));
         if (evaluation.strictMode && !canFallbackToNormalGit(error, normalAgentGit)) {
          if (input.callID) activeToolCalls.delete(input.callID);
          throw new Error(`Worktree Guardian blocked command: ${errorMessage(error)}. Use guardian_status to inspect the recorded worktree.`);
        }
      }
    }
    const sessionMismatchBlocked = Boolean(command && sessionWorktree?.ok === false && !normalAgentGit.allowed && (sessionWorktree.reason || !readOnly.allowed));
    await writeLog(client, createEvent("tool.execute.before", input, output, context, { guard, sessionWorktree, readOnly, normalAgentGit, routed, ...((evaluation.auditOnly || (sessionMismatchBlocked && !evaluation.strictMode)) ? { auditOnly: true } : {}) }));
    if (sessionMismatchBlocked && evaluation.strictMode) {
      if (input.callID) activeToolCalls.delete(input.callID);
      throw new Error(`Worktree Guardian blocked command: session ${sessionWorktree.sessionId} is recorded for expected worktree ${sessionWorktree.expectedWorktree ?? "an unknown worktree"} but actual cwd is ${executionCwd} and actual worktree is ${sessionWorktree.actualWorktree}. Use guardian_status to inspect the recorded worktree.`);
    }
    if (evaluation.enforcedGuard.blocked) {
      if (input.callID) activeToolCalls.delete(input.callID);
      throw new Error(`Worktree Guardian blocked command: ${guard.reason}. Use guardian_status or guardian_finish instead.`);
    }
  };
}
