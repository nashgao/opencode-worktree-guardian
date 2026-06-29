import { guardianFinish } from "./finish.ts";
import { getHeadCommit } from "./git.ts";
import { recordSession } from "./state.ts";
import type { GuardianConfig, MutableRecord } from "./types.ts";
import { blocked } from "./done-shared.ts";
import { recoverableGuardianWorktreeBlocker, recoverySessionId } from "./worktree-recovery.ts";

export async function reattachCurrentGuardianWorktree(repoRoot: string, currentWorktree: string, currentBranch: string | null, config: GuardianConfig, requestedSessionId: string | null, input: Record<string, unknown>): Promise<MutableRecord> {
  const blocker = recoverableGuardianWorktreeBlocker(repoRoot, currentWorktree, currentBranch, config);
  if (blocker) return blocked(blocker, { lane: "missing-session-lane", currentBranch, currentWorktree });
  if (!currentBranch) return blocked("detached HEAD cannot be reattached by guardian_done", { lane: "missing-session-lane", currentWorktree });

  const headCommit = await getHeadCommit(currentWorktree);
  const sessionId = requestedSessionId ?? recoverySessionId(currentBranch, headCommit);
  const mode = input.mode === "apply" ? "apply" : "plan";
  if (mode === "plan") {
    const result = await guardianFinish({ ...input, mode, repoRoot, cwd: currentWorktree, sessionId, config });
    return {
      ...result,
      action: "reattach-and-finish",
      lane: "session-finish",
      reattached: true,
      sessionId,
      branch: currentBranch,
      worktree: currentWorktree,
      commit: headCommit,
      nextAction: "guardian_done mode=apply confirm=true",
    };
  }
  if (input.confirm !== true) {
    return blocked("guardian_done reattach apply requires confirm=true", {
      lane: "session-finish",
      nextAction: "guardian_done mode=apply confirm=true",
    });
  }
  await recordSession(repoRoot, config, {
    session_id: sessionId,
    status: "active",
    branch: currentBranch,
    worktree_path: currentWorktree,
    base_ref: `${String(config.remote)}/${String(config.baseBranch)}`,
    head_commit: headCommit,
    safety_refs: [],
  }, { event: { type: "guardian_done_reattach", session_id: sessionId } });
  const result = await guardianFinish({ ...input, mode, repoRoot, cwd: currentWorktree, sessionId, config });
  return { ...result, lane: "session-finish", reattached: true };
}
