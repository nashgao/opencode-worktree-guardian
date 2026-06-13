import { buildPreservedRef, createRef, getCurrentBranch, getHeadCommit, getRepoRoot } from "./git.ts";
import { recordSession } from "./state.ts";
import type { GuardianToolInput, GuardianToolResult } from "./types.ts";
import { configFromInput, sessionIdFromInput } from "./session/context.ts";
import { protectedBranchReason } from "./session/worktree-binding.ts";
import { recoverableGuardianWorktreeBlocker, recoverySessionId } from "./worktree-recovery.ts";

export async function guardianPreserve(input: GuardianToolInput = {}): Promise<GuardianToolResult> {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const config = await configFromInput(input, repoRoot);
  let sessionId = sessionIdFromInput(input);

  const worktreePath = await getRepoRoot(cwd);
  const branch = await getCurrentBranch(worktreePath);
  if (!branch) throw new Error("Cannot preserve detached HEAD");
  if (!sessionId) {
    const blocker = recoverableGuardianWorktreeBlocker(repoRoot, worktreePath, branch, config);
    if (blocker) return { ok: false, status: "blocked", reason: blocker, branch, worktreePath };
  }
  const unsafeReason = protectedBranchReason(config, branch);
  if (unsafeReason) return { ok: false, status: "blocked", reason: unsafeReason, branch, worktreePath };
  const headCommit = await getHeadCommit(worktreePath);
  sessionId = sessionId ?? recoverySessionId(branch, headCommit);
  const preservedRef = buildPreservedRef(sessionId, branch, typeof input.timestamp === "string" ? input.timestamp : undefined);
  await createRef(worktreePath, preservedRef, headCommit);
  const recordedState = await recordSession(repoRoot, config, {
    session_id: sessionId,
    status: "preserved",
    branch,
    worktree_path: worktreePath,
    base_ref: `${config.remote}/${config.baseBranch}`,
    head_commit: headCommit,
    safety_refs: [preservedRef],
  }, { event: { type: "guardian_preserve", session_id: sessionId, ref: preservedRef } });
  return { ok: true, status: "preserved", session: recordedState.sessions[sessionId], preservedRef };
}
