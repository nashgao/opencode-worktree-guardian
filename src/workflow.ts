import path from "node:path";
import { expandWorktreeRoot, loadConfig } from "./config.ts";
import { guardianDeleteWorktree } from "./delete.ts";
import { fetchRemote, getCurrentBranch, getDirtyFiles, getRefCommit, getRepoRoot, listStashes } from "./git.ts";
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

export async function guardianFinishWorkflow(input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const { config } = input.config && typeof input.config === "object" ? { config: input.config as Record<string, unknown> } : await loadConfig(repoRoot);
  const mode = input.mode ?? "plan";
  const baseRef = `${String(config.remote)}/${String(config.baseBranch)}`;
  const guardianRoot = path.resolve(repoRoot, expandWorktreeRoot(String(config.worktreeRoot), repoRoot));
  const preflight: Record<string, unknown> = {
    repoRoot: path.resolve(repoRoot),
    mode,
    remote: config.remote,
    baseBranch: config.baseBranch,
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
    await fetchRemote(repoRoot, String(config.remote));
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
    const discovered = await discoverCandidates(repoRoot, cwd, config, preflight, input.allowIgnoredFiles === true);
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
  if (blockers.length > 0) return blocked("cleanup blockers must be resolved before apply", { candidates, blockers }, preflight);
  const confirmToken = createWorkflowToken(preflight, candidates);
  if (mode === "plan") return { ok: true, status: "planned", confirmToken, preflight, candidates, blockers };
  if (input.confirmToken !== confirmToken) return blocked("confirm token mismatch; re-run mode=plan and use the returned confirmToken", { tokenMatched: false, candidates, blockers }, preflight);

  const results = [];
  for (const candidate of candidates) {
    const targetKind = typeof candidate.targetKind === "string" ? candidate.targetKind : undefined;
    const targetPath = targetKind === "worktree" && typeof candidate.targetPath === "string" ? candidate.targetPath : undefined;
    const branch = targetKind !== "worktree" && typeof candidate.branch === "string" ? candidate.branch : undefined;
    const plan = await guardianDeleteWorktree({ repoRoot, cwd: repoRoot, mode: "plan", targetPath, branch, deleteBranch: true, allowIgnoredFiles: input.allowIgnoredFiles === true, config });
    if (!plan.ok) {
      results.push({ ...candidateTokenMaterial(candidate), ok: false, status: "blocked", reason: plan.reason });
      continue;
    }
    const apply = await guardianDeleteWorktree({ repoRoot, cwd: repoRoot, mode: "apply", targetPath, branch, deleteBranch: true, allowIgnoredFiles: input.allowIgnoredFiles === true, confirmToken: plan.confirmToken, config });
    results.push({ ...candidateTokenMaterial(candidate), ok: apply.ok, status: apply.status, reason: apply.reason, worktreeRemoved: apply.worktreeRemoved, branchDeleted: apply.branchDeleted, safetyRef: apply.safetyRef });
  }

  const failedResults = results.filter((result) => result.ok !== true);
  return { ok: failedResults.length === 0, status: failedResults.length === 0 ? "cleaned" : "partial", preflight, candidates, blockers, results };
}
