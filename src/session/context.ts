import { loadConfig, normalizeConfig } from "../config.ts";
import type { GuardianConfig, GuardianStateRecord, GuardianToolInput } from "../types.ts";
import { isRecordLike } from "../types.ts";

export async function configFromInput(input: GuardianToolInput, repoRoot: string): Promise<GuardianConfig> {
  if (input.config === undefined || input.config === null) return (await loadConfig(repoRoot)).config;
  if (!isRecordLike(input.config)) throw new Error("config must be an object");
  return normalizeConfig(input.config);
}

export function stateFromInput(value: unknown): GuardianStateRecord | null {
  if (!isRecordLike(value)) return null;
  const sessions: GuardianStateRecord["sessions"] = {};
  if (isRecordLike(value.sessions)) {
    for (const [sessionId, session] of Object.entries(value.sessions)) {
      if (isRecordLike(session)) sessions[sessionId] = session;
    }
  }
  return {
    ...value,
    sessions,
  };
}

export function sessionIdFromInput(input: GuardianToolInput): string | null {
  const rawSessionId = input.sessionId ?? input.sessionID;
  return rawSessionId == null || rawSessionId === "" ? null : String(rawSessionId);
}

export type WorktreeCache = {
  readonly get: (key: string) => unknown;
  readonly set: (key: string, value: string) => unknown;
};

export function worktreeCache(value: unknown): WorktreeCache | null {
  if (!(value instanceof Map)) return null;
  return {
    get: (key: string) => value.get(key),
    set: (key: string, nextValue: string) => value.set(key, nextValue),
  };
}
