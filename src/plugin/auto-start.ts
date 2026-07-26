import path from "node:path";
import { guardianStart } from "../start.ts";
import type { GuardCommandPayload, GuardianConfig, GuardianToolResult, HookContext, SessionWorktreeResult } from "../types.ts";
import { errorMessage } from "../types.ts";
import { directFileMutationPathArg } from "./direct-file-routing.ts";
import { getSessionId } from "./hook-context.ts";
import { rememberSessionWorktree, resolveActualWorktreeOrPath } from "./session-routing.ts";
import { resolveSessionWorktree } from "../session/worktree-binding.ts";

type LazyStartRequest = {
  readonly input: GuardCommandPayload;
  readonly output: GuardCommandPayload;
  readonly context: HookContext;
  readonly config: GuardianConfig | null;
  readonly sessionWorktree: SessionWorktreeResult | null;
  readonly command: unknown;
  readonly readOnly: { readonly allowed: boolean };
  readonly guardBlocked: boolean;
  readonly executionCwd: string;
  readonly cache: Map<string, string>;
};

function isPathInside(parent: string, candidate: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function directFileMutationTargetsRepo(input: GuardCommandPayload, output: GuardCommandPayload, repoRoot: string | undefined, executionCwd: string) {
  const pathArg = directFileMutationPathArg(input, output, executionCwd);
  return Boolean(pathArg && repoRoot && isPathInside(repoRoot, pathArg.value));
}

export async function tryInvisibleStart(input: GuardCommandPayload, context: HookContext, config: GuardianConfig): Promise<GuardianToolResult | null> {
  const sessionId = getSessionId(input);
  if (!config.autoStart || config.autoStartMode !== "eager" || !sessionId || !context.directory) return null;
  try {
    return await guardianStart({
      repoRoot: context.directory,
      cwd: context.worktree ?? context.directory,
      sessionId,
      taskName: input.taskName ?? "session",
      createWorktree: context.worktree == null || context.worktree === context.directory,
      config,
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { ok: false, reason: errorMessage(error) };
  }
}

export async function tryLazyStart(request: LazyStartRequest) {
  const sessionId = getSessionId(request.input);
  const shouldStart = request.config?.autoStart === true
    && request.config.autoStartMode === "lazy"
    && !request.guardBlocked
    && Boolean(sessionId)
    && Boolean(request.context.directory)
    && request.sessionWorktree?.terminal !== true
    && typeof request.sessionWorktree?.expectedWorktree !== "string"
    && (directFileMutationTargetsRepo(request.input, request.output, request.context.directory, request.executionCwd) || Boolean(typeof request.command === "string" && request.command.length > 0 && !request.readOnly.allowed));
  if (!shouldStart || !sessionId || !request.context.directory) return null;

  const result = await guardianStart({
    repoRoot: request.context.directory,
    cwd: request.executionCwd,
    sessionId,
    taskName: request.input.taskName ?? "session",
    createWorktree: true,
    config: request.config,
  });
  rememberSessionWorktree(request.cache, sessionId, result);
  if (result.ok !== true) return { result, sessionWorktree: request.sessionWorktree };

  const actualWorktree = await resolveActualWorktreeOrPath(request.executionCwd);
  const resolved = await resolveSessionWorktree({
    repoRoot: request.context.directory,
    cwd: request.executionCwd,
    actualWorktree,
    sessionId,
    cache: request.cache,
    validateBinding: true,
  });
  return { result, sessionWorktree: resolved };
}
