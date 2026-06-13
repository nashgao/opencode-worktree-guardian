import path from "node:path";
import { getRepoRoot } from "../git.ts";
import { isTerminalSession } from "../lifecycle.ts";
import { checkpointSession, getGuardianPaths, readState } from "../state.ts";
import type { GuardianToolInput, GuardianToolResult } from "../types.ts";
import { isRecordLike } from "../types.ts";
import { configFromInput, sessionIdFromInput } from "./context.ts";

function isSameOrInside(candidate: string, root: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative));
}

// The last-safe-state checkpoint refreshes recovery metadata for an already-owned
// Guardian worktree. It never establishes or repoints a binding; that is guardian_start's
// job. In particular it must never bind a session to the primary worktree or a protected
// branch, which validate/status treat as poisoned.
export async function recordLastSafeState(input: GuardianToolInput = {}): Promise<GuardianToolResult> {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const config = await configFromInput(input, repoRoot);
  const sessionId = sessionIdFromInput(input);
  if (!sessionId) return { ok: false, reason: "sessionId is required" };
  const guardianPaths = await getGuardianPaths(repoRoot);
  const state = await readState(guardianPaths, { repoRoot, config });
  const rawExisting = state.sessions?.[sessionId];
  const existing = isRecordLike(rawExisting) ? rawExisting : undefined;
  if (!existing) return { ok: true, status: "skipped", reason: `session ${sessionId} is not recorded` };
  if (isTerminalSession(existing)) return { ok: true, status: "skipped", reason: `session ${sessionId} is terminal (${String(existing.status)})`, session: existing };
  if (existing.status !== "active") return { ok: true, status: "skipped", reason: `session ${sessionId} is not active`, session: existing };
  const recordedWorktree = typeof existing.worktree_path === "string" ? existing.worktree_path : null;
  if (!recordedWorktree) return { ok: true, status: "skipped", reason: `session ${sessionId} has no recorded worktree`, session: existing };
  if (path.resolve(recordedWorktree) === path.resolve(repoRoot)) {
    return { ok: true, status: "skipped", reason: `session ${sessionId} is recorded on the primary repository worktree; rerun guardian_start with createWorktree=true`, session: existing };
  }
  const protectedBranches = Array.isArray(config.protectedBranches) ? config.protectedBranches : [];
  if (typeof existing.branch === "string" && protectedBranches.includes(existing.branch)) {
    return { ok: true, status: "skipped", reason: `session ${sessionId} branch is protected`, session: existing };
  }
  const actualWorktree = await getRepoRoot(cwd).catch(() => cwd);
  if (!isSameOrInside(actualWorktree, recordedWorktree)) {
    return { ok: true, status: "skipped", reason: `tool executed outside the recorded worktree for session ${sessionId}`, session: existing };
  }
  const recordedState = await checkpointSession(repoRoot, config, sessionId, {
    expectedWorktreePath: recordedWorktree,
    event: { type: "last_safe_state", session_id: sessionId, tool: input.tool },
  });
  return { ok: true, status: "checkpointed", session: recordedState.sessions[sessionId], stateVersion: recordedState.state_version };
}
