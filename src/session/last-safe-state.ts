import { getCurrentBranch, getHeadCommit, getRepoRoot } from "../git.ts";
import { isTerminalSession } from "../lifecycle.ts";
import { getGuardianPaths, readState } from "../state.ts";
import type { GuardianToolInput, GuardianToolResult } from "../types.ts";
import { isRecordLike } from "../types.ts";
import { configFromInput, sessionIdFromInput } from "./context.ts";
import { protectedBranchReason, recordActiveSession } from "./worktree-binding.ts";

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
  if (existing && isTerminalSession(existing)) return { ok: true, status: "skipped", reason: `session ${sessionId} is terminal (${String(existing.status)})`, session: existing };
  const worktreePath = await getRepoRoot(cwd);
  const branch = await getCurrentBranch(worktreePath);
  if (!branch) return { ok: false, reason: "detached HEAD" };
  const unsafeReason = protectedBranchReason(config, branch);
  if (unsafeReason) return { ok: false, reason: unsafeReason, branch, worktreePath };
  await getHeadCommit(worktreePath);
  return recordActiveSession({ repoRoot, config, sessionId, worktreePath, branch, eventType: "last_safe_state", tool: input.tool });
}
