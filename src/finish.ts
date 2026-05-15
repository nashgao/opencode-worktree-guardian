import path from "node:path";
import { loadConfig } from "./config.ts";
import { createSafetyRef, fetchRemote, getCurrentBranch, getDirtyFiles, getHeadCommit, getRepoRoot, isAncestor, listStashes, pushBranch, runGit } from "./git.ts";
import { getGuardianPaths, readState, recordSession } from "./state.ts";

function blocked(reason: string, details: Record<string, any> = {}) {
  return { ok: false, status: "blocked", reason, ...details };
}

function samePath(a: string, b: string) {
  return path.resolve(a) === path.resolve(b);
}

export async function guardianFinish(input: Record<string, any> = {}): Promise<Record<string, any>> {
  const cwd = input.cwd ?? input.repoRoot ?? process.cwd();
  const repoRoot = input.repoRoot ?? await getRepoRoot(cwd);
  const { config } = input.config ? { config: input.config } : await loadConfig(repoRoot);
  const mode = input.finishMode ?? config.finishMode;
  const sessionId = input.sessionId;
  if (!sessionId) return blocked("sessionId is required");

  const paths = await getGuardianPaths(repoRoot);
  const state = input.state ?? await readState(paths, { repoRoot, config });
  const session = state.sessions?.[sessionId];
  if (!session) return blocked("current session is not recorded in guardian state", { sessionId });

  const currentWorktree = await getRepoRoot(cwd);
  if (!samePath(session.worktree_path, currentWorktree)) {
    return blocked("current session does not own this worktree", { sessionWorktree: session.worktree_path, currentWorktree });
  }

  const branch = await getCurrentBranch(currentWorktree);
  if (!branch) return blocked("detached HEAD cannot be finished safely", { worktree: currentWorktree });
  if (branch !== session.branch) return blocked("current branch does not match recorded session branch", { branch, sessionBranch: session.branch });
  if (config.protectedBranches.includes(branch)) return blocked("protected branches cannot be finished by guardian", { branch });

  const dirtyFiles = await getDirtyFiles(currentWorktree);
  if (dirtyFiles.length) return blocked("worktree has uncommitted changes", { dirtyFiles, worktree: currentWorktree });

  const stashes = await listStashes(currentWorktree);
  if (stashes.length && !config.allowStashIfUnrelated) {
    return blocked("stash inventory is non-empty", {
      stashes,
      suggestedCommands: ["git stash list", "git stash show -p stash@{0}"],
    });
  }

  const commit = await getHeadCommit(currentWorktree);
  const safetyRef = await createSafetyRef(currentWorktree, { sessionId, branch, commit, timestamp: input.timestamp });
  await recordSession(repoRoot, config, {
    ...session,
    session_id: sessionId,
    status: mode === "preserve-only" ? "preserved" : session.status,
    head_commit: commit,
    safety_refs: [...(session.safety_refs ?? []), safetyRef],
  }, { event: { type: "safety_ref_created", session_id: sessionId, ref: safetyRef } });

  if (mode === "preserve-only") {
    return { ok: true, status: "preserved", mode, branch, worktree: currentWorktree, commit, safetyRef };
  }

  if (mode === "push-branch" || mode === "create-pr") {
    await pushBranch(currentWorktree, config.remote, branch);
    const result: Record<string, any> = { ok: true, status: mode === "push-branch" ? "pushed" : "pr-suggested", mode, branch, safetyRef };
    if (mode === "create-pr") {
      result.suggestedCommand = `gh pr create --base ${config.baseBranch} --head ${branch}`;
      result.note = "No native GitHub integration is wired; branch was pushed and a PR command is suggested.";
    }
    return result;
  }

  if (mode === "merge-to-base") {
    if (input.allowMergeToBase !== true) {
      return blocked("merge-to-base requires explicit allowMergeToBase=true", { safetyRef, branch });
    }
    await runGit(repoRoot, ["checkout", config.baseBranch]);
    await runGit(repoRoot, ["merge", "--ff-only", branch]);
    await runGit(repoRoot, ["push", config.remote, config.baseBranch]);
    await fetchRemote(repoRoot, config.remote);
    const proven = await isAncestor(repoRoot, commit, `${config.remote}/${config.baseBranch}`);
    if (!proven) return blocked("merged commit is not proven reachable from remote base", { safetyRef, commit });

    const shouldCleanup = config.autoCleanup === true || input.allowCleanup === true;
    if (!shouldCleanup) {
      return { ok: true, status: "merged", mode, branch, commit, safetyRef, cleaned: false };
    }
    if (samePath(currentWorktree, repoRoot)) {
      return blocked("refusing to remove the primary/current repo worktree", { safetyRef, commit, branch });
    }

    await runGit(repoRoot, ["worktree", "remove", currentWorktree]);
    await runGit(repoRoot, ["branch", "-d", branch]);
    await recordSession(repoRoot, config, {
      ...session,
      session_id: sessionId,
      status: "finished",
      head_commit: commit,
      safety_refs: [...(session.safety_refs ?? []), safetyRef],
    }, { event: { type: "guardian_finish", session_id: sessionId, ref: safetyRef } });
    return { ok: true, status: "finished", mode, branch, commit, safetyRef, cleaned: true };
  }

  return blocked(`unsupported finish mode: ${mode}`, { safetyRef });
}
