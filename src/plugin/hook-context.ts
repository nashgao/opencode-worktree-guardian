import type { GuardCommandPayload, HookContext, RecordLike } from "../types.ts";
import { isRecordLike } from "../types.ts";

export function getSessionId(input: GuardCommandPayload = {}): unknown {
  return input.sessionID ?? input.sessionId;
}

export function getStringSessionId(input: GuardCommandPayload = {}): string | null {
  const sessionId = getSessionId(input);
  return typeof sessionId === "string" ? sessionId : null;
}

export function getIdleEventSessionId(input: RecordLike): string | null {
  const event = isRecordLike(input.event) ? input.event : null;
  const properties = isRecordLike(event?.properties) ? event.properties : {};
  const sessionId = properties.sessionID ?? properties.sessionId ?? event?.sessionID ?? event?.sessionId;
  return typeof sessionId === "string" ? sessionId : null;
}

function firstString(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

export function getExecutionCwd(input: GuardCommandPayload = {}, output: GuardCommandPayload = {}, context: HookContext = {}) {
  return firstString(
    output.args?.workdir,
    output.args?.cwd,
    input.args?.workdir,
    input.args?.cwd,
    input.workdir,
    input.cwd,
    context.worktree,
    context.directory,
  ) ?? process.cwd();
}
