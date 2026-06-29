import path from "node:path";
import { expandWorktreeRoot, loadConfig } from "./config.ts";
import { configForResolvedBase, resolveBaseRef } from "./done-base-ref.ts";
import { syncLocalBase } from "./done-main-sync.ts";
import { guardianDeleteWorktree } from "./delete.ts";
import { createSafetyRef, deleteRemoteBranch, fetchRemotePrune, getCurrentBranch, getDirtyFiles, getRefCommit, getRepoRoot, listStashes } from "./git.ts";
import { runFinalCleanupPostflight } from "./final-postflight.ts";
import { isRecordLike } from "./types.ts";
import { candidateTokenMaterial, createWorkflowToken, discoverCandidates, isGuardianWorktreeStatusPath, MAX_WORKFLOW_CLEANUP_CANDIDATES } from "./workflow-candidates.ts";

function blocked(reason: string, details: Record<string, unknown> = {}, preflight?: Record<string, unknown>): Record<string, unknown> {
  if (preflight) addPreflightBlocker(preflight, reason);
  return { ok: false, status: "blocked", reason, ...details, ...(preflight ? { preflight } : {}) };
}

function preflightBlockers(preflight: Record<string, unknown>): string[] {
  const blockers = preflight.blockers;
  if (!Array.isArray(blockers)) return [];
  return blockers.filter((blocker): blocker is string => typeof blocker === "string");
}

function addPreflightBlocker(preflight: Record<string, unknown>, reason: string): void {
  const blockers = preflightBlockers(preflight);
  if (blockers.includes(reason)) return;
  preflight.blockers = [...blockers, reason];
}

function plannedCleanupAllowances(candidates: readonly Record<string, unknown>[]): Record<string, string[]> {
  const localBranches = new Set<string>();
  const worktreeBranches = new Set<string>();
  const remoteBranches = new Set<string>();
  for (const candidate of candidates) {
    const targetKind = typeof candidate.targetKind === "string" ? candidate.targetKind : "";
    const branch = typeof candidate.branch === "string" ? candidate.branch : "";
    if (targetKind === "remote-branch") {
      const remoteBranch = typeof candidate.remoteBranch === "string" ? candidate.remoteBranch : branch;
      if (remoteBranch.length > 0) remoteBranches.add(remoteBranch);
      continue;
    }
    if (branch.length > 0) localBranches.add(branch);
    if (targetKind === "worktree" && branch.length > 0) worktreeBranches.add(branch);
  }
  return {
    allowedLocalBranches: [...localBranches],
    allowedWorktreeBranches: [...worktreeBranches],
    allowedRemoteBranches: [...remoteBranches],
  };
}

export async function guardianFinishWorkflow(input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const { config } = input.config && typeof input.config === "object" ? { config: input.config as Record<string, unknown> } : await loadConfig(repoRoot);
  const mode = input.mode ?? "plan";
  const resolvedBase = await resolveBaseRef(repoRoot, config);
  const effectiveConfig = configForResolvedBase(config, resolvedBase);
  const baseRef = resolvedBase.baseRef;
  const guardianRoot = path.resolve(repoRoot, expandWorktreeRoot(String(config.worktreeRoot), repoRoot));
  const preflight: Record<string, unknown> = {
    repoRoot: path.resolve(repoRoot),
    mode,
    remote: config.remote,
    baseBranch: config.baseBranch,
    effectiveRemote: resolvedBase.remote,
    effectiveBaseBranch: resolvedBase.remoteBranch,
    baseRefSource: resolvedBase.source,
    configuredBaseRef: resolvedBase.configuredBaseRef,
    baseRef,
    baseRefOid: null,
    baseRefFetched: false,
    currentBranch: null,
    dirtyFiles: [],
    dirtyFileCount: 0,
    stashCount: 0,
    blockerCount: 0,
    maxCandidateCount: MAX_WORKFLOW_CLEANUP_CANDIDATES,
    blockers: [],
  };

  if (mode !== "plan" && mode !== "apply") {
    preflight.candidateScanStatus = "skipped";
    preflight.candidateScanSkippedReason = "invalid-mode";
    return blocked("mode must be plan or apply", { mode }, preflight);
  }

  try {
    await fetchRemotePrune(repoRoot, resolvedBase.remote);
    preflight.baseRefFetched = true;
    preflight.baseRefOid = await getRefCommit(repoRoot, baseRef);
  } catch (error) {
    preflight.candidateScanStatus = "skipped";
    preflight.candidateScanSkippedReason = "base-unavailable";
    return blocked("remote base ref could not be fetched or resolved", { baseRef, error: error instanceof Error ? error.message : String(error) }, preflight);
  }

  preflight.currentBranch = await getCurrentBranch(repoRoot);
  const dirtyFiles = await getDirtyFiles(repoRoot);
  const blockingDirtyFiles = dirtyFiles.filter((file) => !isGuardianWorktreeStatusPath(repoRoot, guardianRoot, file));
  const ignoredGuardianWorktreeFiles = dirtyFiles.filter((file) => isGuardianWorktreeStatusPath(repoRoot, guardianRoot, file));
  preflight.dirtyFiles = dirtyFiles;
  preflight.dirtyFileCount = dirtyFiles.length;
  preflight.blockingDirtyFiles = blockingDirtyFiles;
  preflight.blockingDirtyFileCount = blockingDirtyFiles.length;
  preflight.ignoredGuardianWorktreeFiles = ignoredGuardianWorktreeFiles;
  preflight.ignoredGuardianWorktreeFileCount = ignoredGuardianWorktreeFiles.length;
  const dirtyPrimaryReason = "primary worktree has uncommitted changes; commit implemented code before finish workflow cleanup";
  if (blockingDirtyFiles.length > 0) addPreflightBlocker(preflight, dirtyPrimaryReason);

  const stashes = await listStashes(repoRoot);
  preflight.stashCount = stashes.length;
  if (stashes.length > 0 && config.allowStashIfUnrelated !== true) {
    preflight.candidateScanStatus = "skipped";
    preflight.candidateScanSkippedReason = "stash-blocker";
    return blocked("stash inventory is non-empty", { stashes }, preflight);
  }

  let candidates: Record<string, unknown>[];
  let blockers: Record<string, unknown>[];
  try {
    const excludedBranches = Array.isArray(input.excludeBranches) ? input.excludeBranches.filter((branch): branch is string => typeof branch === "string") : [];
    preflight.excludedBranches = excludedBranches;
    const discovered = await discoverCandidates(repoRoot, cwd, effectiveConfig, preflight, input.allowIgnoredFiles === true, excludedBranches, input.abandonUnmerged === true);
    candidates = discovered.candidates;
    blockers = discovered.blockers;
    preflight.candidateScanStatus = "completed";
  } catch (error) {
    preflight.candidateScanStatus = "failed";
    preflight.candidateScanFailedReason = "candidate-discovery-failed";
    preflight.candidateDiscoveryError = error instanceof Error ? error.message : String(error);
    return blocked("candidate discovery failed; cleanup inventory is incomplete", { candidates: [], blockers: [] }, preflight);
  }

  if (preflightBlockers(preflight).length > 0) return blocked(dirtyPrimaryReason, { dirtyFiles: blockingDirtyFiles, candidates, blockers }, preflight);
  const hardBlocker = blockers.find((blocker) => blocker.kind === "candidate-bound");
  if (hardBlocker) return blocked("cleanup candidate count exceeds bounded automation limit", { candidates, blockers }, preflight);
  if (blockers.length > 0 && candidates.length === 0) {
    return blocked("cleanup blockers must be resolved before apply", { candidates, blockers }, preflight);
  }
  const confirmToken = createWorkflowToken(preflight, candidates);
  if (mode === "plan") {
    const finalPostflight = input.skipFinalPostflight === true
      ? { ok: true, status: "skipped", reason: "internal cleanup sweep skips final postflight" }
      : await runFinalCleanupPostflight({ repoRoot, config, plannedBaseSync: candidates.length > 0, ...plannedCleanupAllowances(candidates) });
    const remaining = finalPostflight.ok === true ? blockers : [...blockers, { kind: "final-postflight", status: "blocked", reason: finalPostflight.reason ?? "final cleanup postflight failed", finalPostflight }];
    return { ok: true, status: remaining.length > 0 ? "planned-partial" : "planned", confirmToken, preflight, candidates, blockers, remaining, finalPostflight };
  }
  if (input.confirmToken !== confirmToken) return blocked("confirm token mismatch; re-run mode=plan and use the returned confirmToken", { tokenMatched: false, candidates, blockers }, preflight);

  const applyBlockers = [...blockers];
  let baseSync: Record<string, unknown> | undefined;
  if (candidates.length > 0) {
    baseSync = await syncLocalBase(repoRoot, config);
    if (baseSync.ok !== true) {
      applyBlockers.push({
        kind: "base-sync",
        status: "blocked",
        reason: typeof baseSync.reason === "string" ? baseSync.reason : "local base could not be fast-forwarded before cleanup",
        baseSync,
      });
    }
  }

  const results: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    const targetKind = typeof candidate.targetKind === "string" ? candidate.targetKind : undefined;
    if (targetKind === "remote-branch") {
      const remote = typeof candidate.remote === "string" ? candidate.remote : String(effectiveConfig.remote);
      const remoteBranch = typeof candidate.remoteBranch === "string" ? candidate.remoteBranch : typeof candidate.branch === "string" ? candidate.branch : "";
      const head = typeof candidate.head === "string" ? candidate.head : "";
      if (!remoteBranch || !head) {
        results.push({ ...candidateTokenMaterial(candidate), ok: false, status: "blocked", reason: "remote branch cleanup candidate is incomplete" });
        continue;
      }
      try {
        const safetyRef = await createSafetyRef(repoRoot, { sessionId: "remote-branch-cleanup", branch: `${remote}/${remoteBranch}`, commit: head, timestamp: input.timestamp });
        await deleteRemoteBranch(repoRoot, remote, remoteBranch, head);
        results.push({ ...candidateTokenMaterial(candidate), ok: true, status: "deleted", remote, remoteBranch, branch: remoteBranch, head, remoteBranchDeleted: true, safetyRef });
      } catch (error) {
        results.push({ ...candidateTokenMaterial(candidate), ok: false, status: "blocked", remote, remoteBranch, branch: remoteBranch, head, reason: error instanceof Error ? error.message : String(error) });
      }
      continue;
    }
    const targetPath = targetKind === "worktree" && typeof candidate.targetPath === "string" ? candidate.targetPath : undefined;
    const branch = targetKind !== "worktree" && typeof candidate.branch === "string" ? candidate.branch : undefined;
    const abandonUnmerged = candidate.abandonUnmerged === true;
    const plan = await guardianDeleteWorktree({ repoRoot, cwd: repoRoot, mode: "plan", targetPath, branch, deleteBranch: true, allowMergedGuardianBranch: !abandonUnmerged, ancestryBaseRef: baseRef, allowIgnoredFiles: input.allowIgnoredFiles === true, abandonUnmerged, config: effectiveConfig });
    if (!plan.ok) {
      results.push({ ...candidateTokenMaterial(candidate), ok: false, status: "blocked", reason: plan.reason });
      continue;
    }
    const apply = await guardianDeleteWorktree({ repoRoot, cwd: repoRoot, mode: "apply", targetPath, branch, deleteBranch: true, allowMergedGuardianBranch: !abandonUnmerged, ancestryBaseRef: baseRef, allowIgnoredFiles: input.allowIgnoredFiles === true, abandonUnmerged, confirmToken: plan.confirmToken, config: effectiveConfig });
    const applyPreflight = isRecordLike(apply.preflight) ? apply.preflight : {};
    results.push({ ...candidateTokenMaterial(candidate), ok: apply.ok, status: apply.status, reason: apply.reason, worktreeRemoved: apply.worktreeRemoved, branchDeleted: apply.branchDeleted, safetyRef: apply.safetyRef, abandonUnmerged: apply.abandonUnmerged, unmergedCommits: applyPreflight.unmergedCommits });
  }

  const failedResults = results.filter((result) => result.ok !== true);
  const remaining = [...applyBlockers, ...failedResults];
  const requiredCommits = results
    .filter((result) => result.ok === true && typeof result.head === "string")
    .map((result) => ({
      commit: String(result.head),
      source: typeof result.branch === "string" ? result.branch : "cleanup-candidate",
      reason: result.abandonUnmerged === true ? "cleanup intentionally abandoned an unmerged Guardian-owned branch" : "cleanup deleted a branch or worktree that must be present on final base",
      ...(result.abandonUnmerged === true
        ? {
          discardConfirmed: true,
          discardEvidence: {
            safetyRef: result.safetyRef,
            unmergedCommits: result.unmergedCommits,
          },
        }
        : {}),
    }));
  const finalPostflight = input.skipFinalPostflight === true ? { ok: true, status: "skipped", reason: "internal cleanup sweep skips final postflight" } : await runFinalCleanupPostflight({ repoRoot, config, requiredCommits });
  const postflightRemaining = finalPostflight.ok === true ? [] : [{ kind: "final-postflight", status: "blocked", reason: finalPostflight.reason ?? "final cleanup postflight failed", finalPostflight }];
  const allRemaining = [...remaining, ...postflightRemaining];
  const ok = failedResults.length === 0 && applyBlockers.length === 0 && finalPostflight.ok === true;
  return { ok, status: ok ? "cleaned" : "partial", ...(ok ? {} : { reason: "safe cleanup completed with remaining blockers" }), preflight, candidates, blockers, remaining: allRemaining, results, finalPostflight, ...(baseSync ? { baseSync } : {}) };
}
