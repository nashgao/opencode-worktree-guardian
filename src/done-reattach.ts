import path from "node:path";
import { expandWorktreeRoot } from "./config.ts";
import { guardianFinish } from "./finish.ts";
import { getHeadCommit } from "./git.ts";
import { recordSession } from "./state.ts";
import type { GuardianConfig, MutableRecord } from "./types.ts";
import { blocked, isInside } from "./done-shared.ts";

export async function reattachCurrentGuardianWorktree(repoRoot: string, currentWorktree: string, currentBranch: string | null, config: GuardianConfig, sessionId: string, input: Record<string, unknown>): Promise<MutableRecord> {
  const guardianRoot = path.resolve(repoRoot, expandWorktreeRoot(String(config.worktreeRoot), repoRoot));
  if (!isInside(currentWorktree, guardianRoot)) {
    return blocked("no active Guardian lane is recorded for this session; run guardian_status for recovery details", { lane: "missing-session-lane" });
  }
  if (!currentBranch) return blocked("detached HEAD cannot be reattached by guardian_done", { lane: "missing-session-lane", currentWorktree });
  const protectedBranches = Array.isArray(config.protectedBranches) ? config.protectedBranches : [];
  if (protectedBranches.includes(currentBranch)) {
    return blocked("protected branches cannot be reattached as Guardian-owned worktrees", { lane: "missing-session-lane", currentBranch, currentWorktree });
  }

  const headCommit = await getHeadCommit(currentWorktree);
  await recordSession(repoRoot, config, {
    session_id: sessionId,
    status: "active",
    branch: currentBranch,
    worktree_path: currentWorktree,
    base_ref: `${String(config.remote)}/${String(config.baseBranch)}`,
    head_commit: headCommit,
    safety_refs: [],
  }, { event: { type: "guardian_done_reattach", session_id: sessionId } });
  const result = await guardianFinish({ ...input, repoRoot, cwd: currentWorktree, sessionId, config });
  return { ...result, lane: "session-finish", reattached: true };
}
