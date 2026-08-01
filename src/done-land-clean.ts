import { guardianDeleteWorktree } from "./delete-worktree.ts";
import { commitDirtySessionWork } from "./done-land-clean-commit.ts";
import type { CommitTransactionHooks } from "./done-land-clean-commit.ts";
import { classifyLandBaseTransition, createSessionLandCleanConfirmToken, deriveBatchExecutionToken, sessionLandCleanCommitMessage, sessionLandCleanPreflight } from "./done-land-clean-consent.ts";
import type { BatchLandAuthorization, SuccessfulLandCleanPreflight } from "./done-land-clean-consent.ts";
import { cleanupLandedSession, postFinishMaintenance, withMaintenanceOutcome } from "./done-land-clean-maintenance.ts";
import { planDoneHygienePreflight } from "./done-hygiene-preflight.ts";
import { fetchRemote, getRefCommit, isAncestor, pushBranchWithLease, runGit } from "./git.ts";
import { configuredRemoteAuthority } from "./git-authority.ts";
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
  readonly batchAuthorization?: BatchLandAuthorization;
  readonly commitTransactionHooks?: CommitTransactionHooks;
};

type BlockedResult = {
  readonly ok: false;
  readonly status: string;
  readonly reason: string;
  readonly [key: string]: unknown;
};

function blocked(reason: string, extra: Record<string, unknown> = {}): BlockedResult {
  return { ok: false, status: "blocked", reason, ...extra };
}

function stashInventory(preflight: SuccessfulLandCleanPreflight): Pick<SuccessfulLandCleanPreflight, "stashCount" | "stashes"> {
  return { stashCount: preflight.stashCount, stashes: preflight.stashes };
}

function tokenMatches(context: LandCleanContext, action: "already-landed-clean" | "land-and-clean", preflight: SuccessfulLandCleanPreflight, commitMessage: string) {
  const originalToken = createSessionLandCleanConfirmToken({ action, context, preflight, commitMessage });
  if (!context.batchAuthorization) return context.input.confirmToken === originalToken ? { ok: true } : { ok: false, code: "preflight-drift" as const };
  if (context.input.confirmToken !== context.batchAuthorization.originalConfirmToken) return { ok: false, code: "original-token-mismatch" as const };
  const derived = deriveBatchExecutionToken({ action, context, preflight, commitMessage }, context.batchAuthorization);
  return derived.ok ? { ok: true } : derived;
}

async function planAlreadyLandedRedundantDirtyCleanup(context: LandCleanContext, preflight: SuccessfulLandCleanPreflight, baseRef: string): Promise<Record<string, unknown>> {
  const cleanup = await guardianDeleteWorktree({
    repoRoot: context.repoRoot,
    cwd: context.repoRoot,
    mode: "plan",
    sessionId: context.sessionId,
    deleteBranch: true,
    allowIgnoredFiles: context.input.allowIgnoredFiles === true,
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
  const confirmToken = createSessionLandCleanConfirmToken({ action: "already-landed-clean", context, preflight, commitMessage: "" });
  return {
    ...preflight,
    status: "planned",
    action: "already-landed-clean",
    baseRef,
    cleanup,
    confirmToken,
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
  const token = tokenMatches(context, "already-landed-clean", preflight, "");
  if (!token.ok) return blocked("plan changed; rerun plan and review the updated session cleanup before applying", { tokenMatched: false, code: token.code });
  const cleanup = await cleanupLandedSession(context, "session commit is already reachable from the remote base branch", { allowRedundantDirtyPaths: true, ancestryBaseRef: baseRef, ignoredFiles: preflight.ignoredFiles, ignoredFileFingerprint: preflight.ignoredFileFingerprint });
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

export async function guardianDoneLandClean(context: LandCleanContext): Promise<Record<string, unknown>> {
  if (context.input.mode === "apply" && context.input.confirm !== true) {
    return blocked("guardian_done apply requires confirm=true before session preflight", {
      confirmationRequired: true,
      tokenChecked: false,
      nextAction: "guardian_done mode=apply confirm=true",
    });
  }
  let preflight = await sessionLandCleanPreflight(context, { refreshRemote: context.input.mode !== "apply" });
  if (preflight.ok !== true) return preflight;
  const baseAuthorityRef = configuredRemoteAuthority(context.config).authorityRef;
  if (hasBlockingStashInventory(context.config, preflight.stashes)) {
    return blocked("stash inventory is non-empty", { stashCount: preflight.stashCount, stashes: preflight.stashes });
  }
  const allowAdminBypass = context.input.allowAdminBypass === true;
  const message = sessionLandCleanCommitMessage(context.input);
  const action = preflight.dirtyFiles.length > 0 && !message ? "already-landed-clean" : "land-and-clean";
  if (context.input.mode === "apply") {
    const localToken = tokenMatches(context, action, preflight, message);
    if (!localToken.ok) return blocked("plan changed; rerun plan and review the updated session cleanup before applying", { tokenMatched: false, code: localToken.code });
  }
  if (preflight.dirtyFiles.length > 0 && !message) {
    await fetchRemote(context.repoRoot, preflight.remote);
    preflight = await sessionLandCleanPreflight(context, { refreshRemote: false });
    if (preflight.ok !== true) return preflight;
    if (context.input.mode === "apply") {
      const refreshedToken = tokenMatches(context, "already-landed-clean", preflight, "");
      if (!refreshedToken.ok) return blocked("plan changed; rerun plan and review the updated session cleanup before applying", { tokenMatched: false, code: refreshedToken.code });
    }
    const baseRef = preflight.baseRef;
    if (await isAncestor(context.repoRoot, preflight.head, baseAuthorityRef)) {
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
    const confirmToken = createSessionLandCleanConfirmToken({ action: "land-and-clean", context, preflight, commitMessage: message });
    return {
      ...preflight,
      status: "planned",
      action: "land-and-clean",
      adminBypass: allowAdminBypass,
      ...(message ? { commitMessage: message } : {}),
      cleanup: { deleteBranch: true, targetPath: preflight.worktreePath },
      confirmToken,
      nextAction: "guardian_done mode=apply confirm=true",
    };
  }
  await fetchRemote(context.repoRoot, preflight.remote);
  preflight = await sessionLandCleanPreflight(context, { refreshRemote: false });
  if (preflight.ok !== true) return preflight;
  const refreshedToken = tokenMatches(context, "land-and-clean", preflight, message);
  if (!refreshedToken.ok) return blocked("plan changed; rerun plan and review the updated session cleanup before applying", { tokenMatched: false, code: refreshedToken.code });

  let head = preflight.head;
  let commitSafetyRef: string | null = null;
  let commitSafetyRefDisposition: "created" | "reused" | null = null;
  if (preflight.dirtyFiles.length > 0) {
    const committed = await commitDirtySessionWork(context, preflight, message, context.commitTransactionHooks);
    if (!committed.ok) return { ...committed.result, ...stashInventory(preflight) };
    head = committed.head;
    commitSafetyRef = committed.safetyRef;
    commitSafetyRefDisposition = committed.safetyRefDisposition;
  }
  await fetchRemote(context.repoRoot, preflight.remote);
  const baseRef = preflight.baseRef;
  if (await isAncestor(context.repoRoot, head, baseAuthorityRef)) {
    const cleanup = await cleanupLandedSession(context, "session commit is already reachable from the remote base branch", { ignoredFiles: preflight.ignoredFiles, ignoredFileFingerprint: preflight.ignoredFileFingerprint });
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
      ...(commitSafetyRef ? { commit: head, commitMessage: message, commitSafetyRef, commitSafetyRefDisposition, dirtyFiles: preflight.dirtyFiles } : {}),
      baseRef,
      cleanup,
      worktreeRemoved: cleanup.worktreeRemoved === true,
      branchDeleted: cleanup.branchDeleted === true,
    }, maintenance);
  }
  await pushBranchWithLease(context.repoRoot, preflight.remote, preflight.branch, head, preflight.remoteBranchOid);
  const prResult = await getOrCreatePullRequest(context.repoRoot, preflight.branch, preflight.baseBranch, context.sessionId);
  if (!prResult.ok) return { ...prResult.result, ...stashInventory(preflight) };
  if (prResult.pr.headRefOid && prResult.pr.headRefOid !== head) {
    return blocked("open PR head does not match the session commit", { pr: prResult.pr, branch: preflight.branch, head, ...stashInventory(preflight) });
  }
  await fetchRemote(context.repoRoot, preflight.remote);
  const currentBaseRefOid = await getRefCommit(context.repoRoot, baseAuthorityRef);
  if (currentBaseRefOid !== preflight.baseRefOid) return blocked("remote base advanced after plan; refusing PR merge", { pr: prResult.pr, branch: preflight.branch, worktreePath: preflight.worktreePath, baseRef: preflight.baseRef, expectedBaseRefOid: preflight.baseRefOid, currentBaseRefOid, ...stashInventory(preflight) });
  const mergeResult = await mergePullRequest(context.repoRoot, prResult.pr, head, allowAdminBypass);
  if (!mergeResult.ok) return { ...mergeResult.result, ...stashInventory(preflight) };

  await fetchRemote(context.repoRoot, preflight.remote);
  if (!(await isAncestor(context.repoRoot, head, baseAuthorityRef))) {
    return blocked("PR merge completed but the session commit is not reachable from the remote base branch", { pr: prResult.pr, head, baseRef, ...stashInventory(preflight) });
  }
  const after = await getRefCommit(context.repoRoot, baseAuthorityRef);
  const parents = after === preflight.baseRefOid || after === head ? [] : (await runGit(context.repoRoot, ["show", "-s", "--format=%P", after])).stdout.split(" ").filter(Boolean);
  const transition = classifyLandBaseTransition({ before: preflight.baseRefOid, after, approvedHead: head, parents, approvedHeadIsAncestor: true, beforeIsAncestor: await isAncestor(context.repoRoot, preflight.baseRefOid, head) });
  if (!transition.ok) return blocked("PR merge changed the remote base outside the approved topology", { pr: prResult.pr, head, baseRef, transition });
  const cleanup = await cleanupLandedSession(context, "PR landed", { ignoredFiles: preflight.ignoredFiles, ignoredFileFingerprint: preflight.ignoredFileFingerprint });
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
    ...(commitSafetyRef ? { commit: head, commitMessage: message, commitSafetyRef, commitSafetyRefDisposition, dirtyFiles: preflight.dirtyFiles } : {}),
    baseRef,
    pr: prResult.pr,
    prCreated: prResult.created,
    adminBypass: allowAdminBypass,
    cleanup,
    worktreeRemoved: cleanup.worktreeRemoved === true,
    branchDeleted: cleanup.branchDeleted === true,
  }, maintenance);
}
