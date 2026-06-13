import fs from "node:fs/promises";
import { getRepoRoot } from "../git.ts";
import { resolveSessionWorktree } from "../session/worktree-binding.ts";
import type { AllowDecision, GuardCommandPayload, GuardianToolResult, SessionWorktreeResult } from "../types.ts";
import { errorMessage, isMutableRecord, isRecordLike } from "../types.ts";
import { getSessionId } from "./hook-context.ts";

export function rememberSessionWorktree(cache: Map<string, string>, sessionId: unknown, result: GuardianToolResult | null) {
  const session = isRecordLike(result?.session) ? result.session : null;
  const worktreePath = session?.worktree_path;
  if (typeof sessionId === "string" && sessionId.length > 0 && result?.ok === true && typeof worktreePath === "string") cache.set(sessionId, worktreePath);
}

export async function pathExists(candidate: string | undefined) {
  if (!candidate) return false;
  return fs.access(candidate).then(() => true, () => false);
}

export async function getActualWorktree(executionCwd: string) {
  return await getRepoRoot(executionCwd);
}

export async function resolveActualWorktreeOrPath(executionCwd: string) {
  try {
    return await getActualWorktree(executionCwd);
  } catch {
    return executionCwd;
  }
}

export async function validateRecordedSessionTarget(input: GuardCommandPayload, sessionWorktree: SessionWorktreeResult, repoRoot: string | undefined, cache: Map<string, string>) {
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

export async function routeRecordedSessionCommand(input: GuardCommandPayload, output: GuardCommandPayload, sessionWorktree: SessionWorktreeResult, repoRoot: string | undefined, cache: Map<string, string>) {
  const routed = await validateRecordedSessionTarget(input, sessionWorktree, repoRoot, cache);
  const expectedWorktree = routed.expectedWorktree;
  if (typeof expectedWorktree !== "string") throw new Error(`recorded worktree is unavailable for session ${sessionWorktree.sessionId}`);
  if (!isMutableRecord(output.args)) output.args = {};
  const args = output.args;
  args.workdir = expectedWorktree;
  args.cwd = expectedWorktree;
  return {
    ...routed,
    routed: true,
    routedFrom: sessionWorktree.actualWorktree,
  };
}

export function canFallbackToNormalGit(error: unknown, normalAgentGit: AllowDecision) {
  if (normalAgentGit.allowed !== true) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /recorded worktree is (missing|unavailable)/.test(message);
}
