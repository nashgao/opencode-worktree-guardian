import path from "node:path";
import { loadConfig } from "./config.ts";
import { createSafetyRef, fetchRemote, getCurrentBranch, getDirtyFiles, getHeadCommit, getRepoRoot, isAncestor, listStashes, pushBranch, runGit } from "./git.ts";
import { getGuardianPaths, readState, recordSession } from "./state.ts";

function snapshotPreflight(preflight: Record<string, any>): Record<string, any> {
  return { ...preflight, blockers: [...(preflight.blockers ?? [])] };
}

function withFinishReport(result: Record<string, any>, preflight: Record<string, any>, reportDetails: Record<string, any> = {}) {
  const preflightSnapshot = snapshotPreflight(preflight);
  return {
    ...result,
    preflight: preflightSnapshot,
    report: {
      action: reportDetails.action ?? result.status,
      sessionId: preflightSnapshot.sessionId,
      sessionRecorded: preflightSnapshot.sessionRecorded,
      sessionOwnedWorktree: preflightSnapshot.sessionOwnedWorktree,
      currentWorktree: preflightSnapshot.currentWorktree,
      sessionWorktree: preflightSnapshot.sessionWorktree,
      currentBranch: preflightSnapshot.currentBranch,
      sessionBranch: preflightSnapshot.sessionBranch,
      branchProtected: preflightSnapshot.branchProtected,
      dirtyFileCount: preflightSnapshot.dirtyFileCount,
      stashCount: preflightSnapshot.stashCount,
      safetyRef: preflightSnapshot.safetyRef ?? result.safetyRef ?? null,
      remote: preflightSnapshot.remote,
      baseBranch: preflightSnapshot.baseBranch,
      mode: preflightSnapshot.mode,
      blockers: preflightSnapshot.blockers,
      suggestedCommand: result.suggestedCommand,
      ...reportDetails,
    },
  };
}

function blocked(reason: string, details: Record<string, any> = {}, preflight?: Record<string, any>, reportDetails: Record<string, any> = {}) {
  const result = { ok: false, status: "blocked", reason, ...details };
  if (!preflight) return result;
  preflight.blockers = [...(preflight.blockers ?? []), reason];
  return withFinishReport(result, preflight, { action: "blocked", ...reportDetails });
}

function samePath(a: string, b: string) {
  return path.resolve(a) === path.resolve(b);
}

function errorMessage(error: unknown) {
  if (typeof error === "object" && error !== null) {
    const details = error as Record<string, unknown>;
    if (typeof details.gitStderr === "string" && details.gitStderr.length > 0) return details.gitStderr;
    if (typeof details.message === "string" && details.message.length > 0) return details.message;
  }
  return String(error);
}

export async function guardianFinish(input: Record<string, any> = {}): Promise<Record<string, any>> {
  const cwd = input.cwd ?? input.repoRoot ?? process.cwd();
  const repoRoot = input.repoRoot ?? await getRepoRoot(cwd);
  const { config } = input.config ? { config: input.config } : await loadConfig(repoRoot);
  const mode = input.finishMode ?? config.finishMode;
  const sessionId = input.sessionId;
  const preflight: Record<string, any> = {
    sessionId: sessionId ?? null,
    sessionRecorded: false,
    sessionOwnedWorktree: false,
    currentWorktree: null,
    sessionWorktree: null,
    currentBranch: null,
    sessionBranch: null,
    branchProtected: null,
    protectedBranches: config.protectedBranches,
    dirtyFiles: [],
    dirtyFileCount: 0,
    stashCount: 0,
    safetyRef: null,
    remote: config.remote,
    baseBranch: config.baseBranch,
    mode,
    blockers: [],
  };
  if (!sessionId) return blocked("sessionId is required", {}, preflight);

  const paths = await getGuardianPaths(repoRoot);
  const state = input.state ?? await readState(paths, { repoRoot, config });
  const session = state.sessions?.[sessionId];
  preflight.sessionRecorded = Boolean(session);
  if (!session) return blocked("current session is not recorded in guardian state", { sessionId }, preflight);
  preflight.sessionWorktree = session.worktree_path;
  preflight.sessionBranch = session.branch;

  const currentWorktree = await getRepoRoot(cwd);
  preflight.currentWorktree = currentWorktree;
  preflight.sessionOwnedWorktree = samePath(session.worktree_path, currentWorktree);
  if (!preflight.sessionOwnedWorktree) {
    return blocked("current session does not own this worktree", { sessionWorktree: session.worktree_path, currentWorktree }, preflight);
  }

  const branch = await getCurrentBranch(currentWorktree);
  preflight.currentBranch = branch;
  if (!branch) return blocked("detached HEAD cannot be finished safely", { worktree: currentWorktree }, preflight);
  preflight.branchProtected = config.protectedBranches.includes(branch);
  if (branch !== session.branch) return blocked("current branch does not match recorded session branch", { branch, sessionBranch: session.branch }, preflight);
  if (preflight.branchProtected) return blocked("protected branches cannot be finished by guardian", { branch }, preflight);

  const dirtyFiles = await getDirtyFiles(currentWorktree);
  preflight.dirtyFiles = dirtyFiles;
  preflight.dirtyFileCount = dirtyFiles.length;
  if (dirtyFiles.length) return blocked("worktree has uncommitted changes", { dirtyFiles, worktree: currentWorktree }, preflight);

  const stashes = await listStashes(currentWorktree);
  preflight.stashCount = stashes.length;
  if (stashes.length && !config.allowStashIfUnrelated) {
    return blocked("stash inventory is non-empty", {
      stashes,
      suggestedCommands: ["git stash list", "git stash show -p stash@{0}"],
    }, preflight, { action: "inspect-stashes", suggestedCommands: ["git stash list", "git stash show -p stash@{0}"] });
  }

  const commit = await getHeadCommit(currentWorktree);
  preflight.commit = commit;
  const existingSafetyRefs = Array.isArray(session.safety_refs) ? session.safety_refs.filter((ref: unknown) => typeof ref === "string") : [];
  const existingSafetyRef = existingSafetyRefs[existingSafetyRefs.length - 1];
  if (mode === "preserve-only" && session.status === "preserved" && existingSafetyRef) {
    preflight.safetyRef = existingSafetyRef;
    return withFinishReport({ ok: true, status: "preserved", mode, branch, worktree: currentWorktree, commit, safetyRef: existingSafetyRef, idempotent: true }, preflight, { action: "already-preserved" });
  }
  const safetyRef = await createSafetyRef(currentWorktree, { sessionId, branch, commit, timestamp: input.timestamp });
  preflight.safetyRef = safetyRef;
  await recordSession(repoRoot, config, {
    ...session,
    session_id: sessionId,
    status: mode === "preserve-only" ? "preserved" : session.status,
    head_commit: commit,
    safety_refs: [...(session.safety_refs ?? []), safetyRef],
  }, { event: { type: "safety_ref_created", session_id: sessionId, ref: safetyRef } });

  if (mode === "preserve-only") {
    return withFinishReport({ ok: true, status: "preserved", mode, branch, worktree: currentWorktree, commit, safetyRef }, preflight, { action: "preserved" });
  }

  if (mode === "push-branch" || mode === "create-pr") {
    try {
      await pushBranch(currentWorktree, config.remote, branch);
    } catch (error) {
      return blocked("push failed", { safetyRef, branch, error: errorMessage(error) }, preflight);
    }
    const result: Record<string, any> = { ok: true, status: mode === "push-branch" ? "pushed" : "pr-suggested", mode, branch, safetyRef };
    if (mode === "create-pr") {
      result.suggestedCommand = `gh pr create --base ${config.baseBranch} --head ${branch}`;
      result.note = "No native GitHub integration is wired; branch was pushed and a PR command is suggested.";
    }
    return withFinishReport(result, preflight, { action: mode === "push-branch" ? "pushed" : "pushed-and-suggested-pr" });
  }

  if (mode === "merge-to-base") {
    if (input.allowMergeToBase !== true) {
      return blocked("merge-to-base requires explicit allowMergeToBase=true", { safetyRef, branch }, preflight, { action: "requires-explicit-merge-approval" });
    }
    await runGit(repoRoot, ["checkout", config.baseBranch]);
    await runGit(repoRoot, ["merge", "--ff-only", branch]);
    await runGit(repoRoot, ["push", config.remote, config.baseBranch]);
    await fetchRemote(repoRoot, config.remote);
    const proven = await isAncestor(repoRoot, commit, `${config.remote}/${config.baseBranch}`);
    if (!proven) return blocked("merged commit is not proven reachable from remote base", { safetyRef, commit }, preflight);

    const shouldCleanup = config.autoCleanup === true || input.allowCleanup === true;
    if (!shouldCleanup) {
      return withFinishReport({ ok: true, status: "merged", mode, branch, commit, safetyRef, cleaned: false }, preflight, { action: "merged-without-cleanup" });
    }
    if (samePath(currentWorktree, repoRoot)) {
      return blocked("refusing to remove the primary/current repo worktree", { safetyRef, commit, branch }, preflight);
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
    return withFinishReport({ ok: true, status: "finished", mode, branch, commit, safetyRef, cleaned: true }, preflight, { action: "merged-and-cleaned" });
  }

  return blocked(`unsupported finish mode: ${mode}`, { safetyRef }, preflight);
}
