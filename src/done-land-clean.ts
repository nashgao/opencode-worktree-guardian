import { guardianDeleteWorktree } from "./delete-worktree.ts";
import { commitDirtySessionWork } from "./done-land-clean-commit.ts";
import { cleanupLandedSession, postFinishMaintenance, withMaintenanceOutcome } from "./done-land-clean-maintenance.ts";
import { planDoneHygienePreflight } from "./done-hygiene-preflight.ts";
import { fetchRemote, getCurrentBranch, getDirtyFiles, getHeadCommit, isAncestor, listStashes, pushBranch } from "./git.ts";
import type { GitStashEntry } from "./git.ts";
import { getOrCreatePullRequest, mergePullRequest } from "./done-github-pr.ts";
import { hasBlockingStashInventory } from "./stash-policy.ts";
import type { GuardianConfig, GuardianSession } from "./types.ts";

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
      readonly stashCount: number;
      readonly stashes: readonly GitStashEntry[];
      readonly remote: string;
      readonly baseBranch: string;
    };

type SuccessfulLandCleanPreflight = Extract<LandCleanPreflight, { readonly ok: true }>;

function blocked(reason: string, extra: Record<string, unknown> = {}): BlockedResult {
  return { ok: false, status: "blocked", reason, ...extra };
}

function sessionBranch(session: GuardianSession): string | null {
  return typeof session.branch === "string" && session.branch.length > 0 ? session.branch : null;
}

function commitMessage(input: Record<string, unknown>): string {
  return typeof input.commitMessage === "string" ? input.commitMessage.trim() : "";
}

function stashInventory(preflight: SuccessfulLandCleanPreflight): Pick<SuccessfulLandCleanPreflight, "stashCount" | "stashes"> {
  return { stashCount: preflight.stashCount, stashes: preflight.stashes };
}

async function planAlreadyLandedRedundantDirtyCleanup(context: LandCleanContext, preflight: SuccessfulLandCleanPreflight, baseRef: string): Promise<Record<string, unknown>> {
  const cleanup = await guardianDeleteWorktree({
    repoRoot: context.repoRoot,
    cwd: context.repoRoot,
    mode: "plan",
    sessionId: context.sessionId,
    deleteBranch: true,
    allowRedundantDirtyPaths: true,
    ancestryBaseRef: baseRef,
    timestamp: context.input.timestamp,
    config: context.config,
  });
  if (cleanup.ok !== true || typeof cleanup.confirmToken !== "string") {
    return blocked("already-landed dirty session work could not be proven redundant; commitMessage is required to preserve it", {
      branch: preflight.branch,
      worktreePath: preflight.worktreePath,
      dirtyFiles: preflight.dirtyFiles,
      ...stashInventory(preflight),
      baseRef,
      cleanup,
    });
  }
  return {
    ...preflight,
    status: "planned",
    action: "already-landed-clean",
    baseRef,
    cleanup,
    nextAction: "guardian_done mode=apply confirm=true",
  };
}

async function applyAlreadyLandedRedundantDirtyCleanup(context: LandCleanContext, preflight: SuccessfulLandCleanPreflight, baseRef: string): Promise<Record<string, unknown>> {
  if (context.input.confirm !== true) {
    return blocked("guardian_done apply requires confirm=true before cleaning the already-landed dirty session", {
      action: "already-landed-clean",
      branch: preflight.branch,
      worktreePath: preflight.worktreePath,
      dirtyFiles: preflight.dirtyFiles,
      ...stashInventory(preflight),
      baseRef,
    });
  }
  const cleanup = await cleanupLandedSession(context, "session commit is already reachable from the remote base branch", { allowRedundantDirtyPaths: true, ancestryBaseRef: baseRef });
  if (cleanup.ok !== true) return { ...cleanup, ...stashInventory(preflight) };
  const maintenance = await postFinishMaintenance(context, [{ commit: preflight.head, source: preflight.branch, reason: "landed session commit must be present on final base" }]);
  return withMaintenanceOutcome({
    ok: true,
    status: "already-landed-and-cleaned",
    action: "already-landed-clean",
    branch: preflight.branch,
    head: preflight.head,
    dirtyFiles: preflight.dirtyFiles,
    stashCount: preflight.stashCount,
    stashes: preflight.stashes,
    baseRef,
    cleanup,
    worktreeRemoved: cleanup.worktreeRemoved === true,
    branchDeleted: cleanup.branchDeleted === true,
  }, maintenance);
}

async function landCleanPreflight(context: LandCleanContext): Promise<LandCleanPreflight> {
  const branch = sessionBranch(context.session) ?? await getCurrentBranch(context.cwd);
  if (!branch) return blocked("Guardian session has no branch to land", { sessionId: context.sessionId });
  const worktreePath = typeof context.session.worktree_path === "string" ? context.session.worktree_path : context.cwd;
  const head = await getHeadCommit(context.cwd);
  const dirtyFiles = await getDirtyFiles(context.cwd);
  const stashes = await listStashes(context.repoRoot);
  return {
    ok: true,
    branch,
    worktreePath,
    head,
    dirtyFiles,
    stashCount: stashes.length,
    stashes,
    remote: context.config.remote,
    baseBranch: context.config.baseBranch,
  };
}

export async function guardianDoneLandClean(context: LandCleanContext): Promise<Record<string, unknown>> {
  const preflight = await landCleanPreflight(context);
  if (preflight.ok !== true) return preflight;
  if (hasBlockingStashInventory(context.config, preflight.stashes)) {
    return blocked("stash inventory is non-empty", { stashCount: preflight.stashCount, stashes: preflight.stashes });
  }
  const allowAdminBypass = context.input.allowAdminBypass === true;
  const message = commitMessage(context.input);
  if (preflight.dirtyFiles.length > 0 && !message) {
    await fetchRemote(context.repoRoot, preflight.remote);
    const baseRef = `${preflight.remote}/${preflight.baseBranch}`;
    if (await isAncestor(context.repoRoot, preflight.head, baseRef)) {
      if (context.input.mode !== "apply") return planAlreadyLandedRedundantDirtyCleanup(context, preflight, baseRef);
      return applyAlreadyLandedRedundantDirtyCleanup(context, preflight, baseRef);
    }
    const hygienePreflight = await planDoneHygienePreflight({ cwd: context.cwd, config: context.config }, preflight.dirtyFiles);
    if (hygienePreflight !== null) {
      return {
        ...hygienePreflight,
        branch: preflight.branch,
        worktreePath: preflight.worktreePath,
        head: preflight.head,
        ...stashInventory(preflight),
        baseRef,
      };
    }
    return blocked("commitMessage is required for dirty session work", {
      branch: preflight.branch,
      worktreePath: preflight.worktreePath,
      dirtyFiles: preflight.dirtyFiles,
      ...stashInventory(preflight),
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
      ...stashInventory(preflight),
    });
  }

  let head = preflight.head;
  let commitSafetyRef: string | null = null;
  if (preflight.dirtyFiles.length > 0) {
    const committed = await commitDirtySessionWork(context, preflight, message);
    if (!committed.ok) return { ...committed.result, ...stashInventory(preflight) };
    head = committed.head;
    commitSafetyRef = committed.safetyRef;
  }
  await fetchRemote(context.repoRoot, preflight.remote);
  const baseRef = `${preflight.remote}/${preflight.baseBranch}`;
  if (await isAncestor(context.repoRoot, head, baseRef)) {
    const cleanup = await cleanupLandedSession(context, "session commit is already reachable from the remote base branch");
    if (cleanup.ok !== true) return { ...cleanup, ...stashInventory(preflight) };
    const maintenance = await postFinishMaintenance(context, [{ commit: head, source: preflight.branch, reason: "landed session commit must be present on final base" }]);
    return withMaintenanceOutcome({
      ok: true,
      status: "already-landed-and-cleaned",
      action: "already-landed-clean",
      branch: preflight.branch,
      head,
      stashCount: preflight.stashCount,
      stashes: preflight.stashes,
      ...(commitSafetyRef ? { commit: head, commitMessage: message, commitSafetyRef, dirtyFiles: preflight.dirtyFiles } : {}),
      baseRef,
      cleanup,
      worktreeRemoved: cleanup.worktreeRemoved === true,
      branchDeleted: cleanup.branchDeleted === true,
    }, maintenance);
  }
  await pushBranch(context.repoRoot, preflight.remote, preflight.branch);
  const prResult = await getOrCreatePullRequest(context.repoRoot, preflight.branch, preflight.baseBranch, context.sessionId);
  if (!prResult.ok) return { ...prResult.result, ...stashInventory(preflight) };
  if (prResult.pr.headRefOid && prResult.pr.headRefOid !== head) {
    return blocked("open PR head does not match the session commit", { pr: prResult.pr, branch: preflight.branch, head, ...stashInventory(preflight) });
  }
  const mergeResult = await mergePullRequest(context.repoRoot, prResult.pr, head, allowAdminBypass);
  if (!mergeResult.ok) return { ...mergeResult.result, ...stashInventory(preflight) };

  await fetchRemote(context.repoRoot, preflight.remote);
  if (!(await isAncestor(context.repoRoot, head, baseRef))) {
    return blocked("PR merge completed but the session commit is not reachable from the remote base branch", { pr: prResult.pr, head, baseRef, ...stashInventory(preflight) });
  }
  const cleanup = await cleanupLandedSession(context, "PR landed");
  if (cleanup.ok !== true) return { ...cleanup, pr: prResult.pr, ...stashInventory(preflight) };
  const maintenance = await postFinishMaintenance(context, [{ commit: head, source: preflight.branch, reason: "landed session commit must be present on final base" }]);
  return withMaintenanceOutcome({
    ok: true,
    status: "landed-and-cleaned",
    action: "land-and-clean",
    branch: preflight.branch,
    head,
    stashCount: preflight.stashCount,
    stashes: preflight.stashes,
    ...(commitSafetyRef ? { commit: head, commitMessage: message, commitSafetyRef, dirtyFiles: preflight.dirtyFiles } : {}),
    baseRef,
    pr: prResult.pr,
    prCreated: prResult.created,
    adminBypass: allowAdminBypass,
    cleanup,
    worktreeRemoved: cleanup.worktreeRemoved === true,
    branchDeleted: cleanup.branchDeleted === true,
  }, maintenance);
}
