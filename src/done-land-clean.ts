import { guardianDeleteWorktree } from "./delete-worktree.ts";
import { createSafetyRef, fetchRemote, getCurrentBranch, getDirtyFiles, getHeadCommit, isAncestor, pushBranch, runGit } from "./git.ts";
import { getOrCreatePullRequest, mergePullRequest } from "./done-github-pr.ts";
import type { GuardianConfig, GuardianSession } from "./types.ts";
import { errorMessage } from "./types.ts";

type LandCleanContext = {
  readonly input: Record<string, unknown>;
  readonly repoRoot: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly session: GuardianSession;
  readonly config: GuardianConfig;
};

type BlockedResult = {
  readonly ok: false;
  readonly status: string;
  readonly reason: string;
  readonly [key: string]: unknown;
};

type LandCleanPreflight =
  | BlockedResult
  | {
      readonly ok: true;
      readonly branch: string;
      readonly worktreePath: string;
      readonly head: string;
      readonly dirtyFiles: readonly string[];
      readonly remote: string;
      readonly baseBranch: string;
    };

function blocked(reason: string, extra: Record<string, unknown> = {}): BlockedResult {
  return { ok: false, status: "blocked", reason, ...extra };
}

function sessionBranch(session: GuardianSession): string | null {
  return typeof session.branch === "string" && session.branch.length > 0 ? session.branch : null;
}

function commitMessage(input: Record<string, unknown>): string {
  return typeof input.commitMessage === "string" ? input.commitMessage.trim() : "";
}

async function landCleanPreflight(context: LandCleanContext): Promise<LandCleanPreflight> {
  const branch = sessionBranch(context.session) ?? await getCurrentBranch(context.cwd);
  if (!branch) return blocked("Guardian session has no branch to land", { sessionId: context.sessionId });
  const worktreePath = typeof context.session.worktree_path === "string" ? context.session.worktree_path : context.cwd;
  const head = await getHeadCommit(context.cwd);
  const dirtyFiles = await getDirtyFiles(context.cwd);
  return {
    ok: true,
    branch,
    worktreePath,
    head,
    dirtyFiles,
    remote: context.config.remote,
    baseBranch: context.config.baseBranch,
  };
}

async function commitDirtySessionWork(context: LandCleanContext, preflight: Extract<LandCleanPreflight, { readonly ok: true }>, message: string): Promise<{ readonly ok: true; readonly head: string; readonly safetyRef: string } | { readonly ok: false; readonly result: Record<string, unknown> }> {
  const safetyRef = await createSafetyRef(context.repoRoot, {
    sessionId: context.sessionId,
    branch: preflight.branch,
    commit: preflight.head,
    timestamp: context.input.timestamp,
  });
  try {
    await runGit(context.cwd, ["add", "--all", "--", ...preflight.dirtyFiles]);
    await runGit(context.cwd, ["commit", "-m", message]);
  } catch (error) {
    return { ok: false, result: blocked("commit failed", { branch: preflight.branch, dirtyFiles: preflight.dirtyFiles, safetyRef, error: errorMessage(error) }) };
  }
  return { ok: true, head: await getHeadCommit(context.cwd), safetyRef };
}

export async function guardianDoneLandClean(context: LandCleanContext): Promise<Record<string, unknown>> {
  const preflight = await landCleanPreflight(context);
  if (preflight.ok !== true) return preflight;
  const allowAdminBypass = context.input.allowAdminBypass === true;
  const message = commitMessage(context.input);
  if (preflight.dirtyFiles.length > 0 && !message) {
    return blocked("commitMessage is required for dirty session work", {
      branch: preflight.branch,
      worktreePath: preflight.worktreePath,
      dirtyFiles: preflight.dirtyFiles,
    });
  }
  if (context.input.mode !== "apply") {
    return {
      ...preflight,
      status: "planned",
      action: "land-and-clean",
      adminBypass: allowAdminBypass,
      ...(message ? { commitMessage: message } : {}),
      cleanup: { deleteBranch: true, targetPath: preflight.worktreePath },
      nextAction: "guardian_done mode=apply confirm=true",
    };
  }
  if (context.input.confirm !== true) {
    return blocked("guardian_done apply requires confirm=true before merging PR and cleaning the session", {
      action: "land-and-clean",
      branch: preflight.branch,
      worktreePath: preflight.worktreePath,
    });
  }

  let head = preflight.head;
  let commitSafetyRef: string | null = null;
  if (preflight.dirtyFiles.length > 0) {
    const committed = await commitDirtySessionWork(context, preflight, message);
    if (!committed.ok) return committed.result;
    head = committed.head;
    commitSafetyRef = committed.safetyRef;
  }
  await pushBranch(context.repoRoot, preflight.remote, preflight.branch);
  const prResult = await getOrCreatePullRequest(context.repoRoot, preflight.branch, preflight.baseBranch, context.sessionId);
  if (!prResult.ok) return prResult.result;
  if (prResult.pr.headRefOid && prResult.pr.headRefOid !== head) {
    return blocked("open PR head does not match the session commit", { pr: prResult.pr, branch: preflight.branch, head });
  }
  const mergeResult = await mergePullRequest(context.repoRoot, prResult.pr, head, allowAdminBypass);
  if (!mergeResult.ok) return mergeResult.result;

  await fetchRemote(context.repoRoot, preflight.remote);
  const baseRef = `${preflight.remote}/${preflight.baseBranch}`;
  if (!(await isAncestor(context.repoRoot, head, baseRef))) {
    return blocked("PR merge completed but the session commit is not reachable from the remote base branch", { pr: prResult.pr, head, baseRef });
  }
  const cleanupPlan = await guardianDeleteWorktree({
    repoRoot: context.repoRoot,
    cwd: context.repoRoot,
    mode: "plan",
    sessionId: context.sessionId,
    deleteBranch: true,
    timestamp: context.input.timestamp,
    config: context.config,
  });
  if (cleanupPlan.ok !== true || typeof cleanupPlan.confirmToken !== "string") {
    return { ok: false, status: "cleanup-blocked", reason: "PR landed but stale worktree cleanup could not be planned", pr: prResult.pr, cleanup: cleanupPlan };
  }
  const cleanup = await guardianDeleteWorktree({
    repoRoot: context.repoRoot,
    cwd: context.repoRoot,
    mode: "apply",
    sessionId: context.sessionId,
    deleteBranch: true,
    confirmToken: cleanupPlan.confirmToken,
    timestamp: context.input.timestamp,
    config: context.config,
  });
  if (cleanup.ok !== true) return { ok: false, status: "cleanup-blocked", reason: "PR landed but stale worktree cleanup failed", pr: prResult.pr, cleanup };
  return {
    ok: true,
    status: "landed-and-cleaned",
    action: "land-and-clean",
    branch: preflight.branch,
    head,
    ...(commitSafetyRef ? { commit: head, commitMessage: message, commitSafetyRef, dirtyFiles: preflight.dirtyFiles } : {}),
    baseRef,
    pr: prResult.pr,
    prCreated: prResult.created,
    adminBypass: allowAdminBypass,
    cleanup,
    worktreeRemoved: cleanup.worktreeRemoved === true,
    branchDeleted: cleanup.branchDeleted === true,
  };
}
