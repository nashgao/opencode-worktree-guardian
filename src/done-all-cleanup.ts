import crypto from "node:crypto";
import path from "node:path";
import { fetchRemote, getRefCommit, isAncestor, runGit } from "./git.ts";
import { classifyLandBaseTransition } from "./done-land-clean-consent.ts";
import { candidateTokenMaterial } from "./workflow-candidates.ts";
import { normalizeAllowedRemoteBranches } from "./final-postflight.ts";
import { isRecordLike } from "./types.ts";
import type { GuardianConfig, GuardianPullRequestMergeMethod } from "./types.ts";

export type DoneAllTokenPlan = {
  readonly session_id: string;
  readonly branch: string | null;
  readonly worktree_path: string;
  readonly head: string | null;
  readonly dirtyFileCount: number;
  readonly disposition: string;
  readonly finishConfirmToken?: string;
};

type DoneAllTokenInput = {
  readonly repoRoot: string;
  readonly config: GuardianConfig;
  readonly baseRef: string;
  readonly baseRefOid: string | null;
  readonly protectedBranches: readonly string[];
  readonly plans: readonly DoneAllTokenPlan[];
  readonly cleanupPlan: Record<string, unknown>;
  readonly allowIgnoredFiles: boolean;
  readonly allowAdminBypass: boolean;
  readonly allowedRemoteBranches: readonly string[];
};

type CleanupSweepInput = {
  readonly cleanupPlan: Record<string, unknown>;
  readonly cleanupCandidates: number;
  readonly cleanupRetirementCandidates: number;
  readonly cleanupApplyWorkCount: number;
  readonly cleanupBlockers: number;
  readonly cleanupApply: Record<string, unknown> | null;
};

export async function observeBaseTransition(repoRoot: string, baseAuthorityRef: string, remote: string, before: string, approvedHead: string, pullRequestMergeMethod: GuardianPullRequestMergeMethod) {
  await fetchRemote(repoRoot, remote);
  const after = await getRefCommit(repoRoot, baseAuthorityRef);
  const parents = after === before || after === approvedHead ? [] : (await runGit(repoRoot, ["show", "-s", "--format=%P", after])).stdout.split(" ").filter(Boolean);
  const approvedTree = (await runGit(repoRoot, ["show", "-s", "--format=%T", approvedHead])).stdout;
  const afterTree = after === approvedHead ? approvedTree : (await runGit(repoRoot, ["show", "-s", "--format=%T", after])).stdout;
  const approvedHeadIsAncestor = await isAncestor(repoRoot, approvedHead, baseAuthorityRef);
  const approvedTreeMatches = approvedTree === afterTree;
  const transition = classifyLandBaseTransition({ before, after, approvedHead, parents, approvedHeadIsAncestor, beforeIsAncestor: await isAncestor(repoRoot, before, after), approvedTreeMatches, pullRequestMergeMethod });
  return { ...transition, before, after, parents, approvedTreeMatches, pullRequestMergeMethod };
}

function cleanupPlanTokenMaterial(cleanupPlan: Record<string, unknown>): Record<string, unknown> {
  const candidates = Array.isArray(cleanupPlan.candidates) ? cleanupPlan.candidates.filter((candidate): candidate is Record<string, unknown> => isRecordLike(candidate)) : [];
  const blockers = Array.isArray(cleanupPlan.blockers) ? cleanupPlan.blockers.filter((blocker): blocker is Record<string, unknown> => isRecordLike(blocker)) : [];
  return {
    ok: cleanupPlan.ok === true,
    status: typeof cleanupPlan.status === "string" ? cleanupPlan.status : null,
    confirmToken: typeof cleanupPlan.confirmToken === "string" ? cleanupPlan.confirmToken : null,
    candidates: candidates.map(candidateTokenMaterial),
    reservationRetirementCandidates: recordArrayField(cleanupPlan, "reservationRetirementCandidates").map(candidateTokenMaterial),
    blockers: blockers.map((blocker) => ({
      kind: blocker.kind ?? null,
      targetPath: blocker.targetPath ?? null,
      branch: blocker.branch ?? null,
      head: blocker.head ?? null,
      targetKind: blocker.targetKind ?? null,
      remote: blocker.remote ?? null,
      remoteBranch: blocker.remoteBranch ?? null,
      reason: blocker.reason ?? null,
    })),
  };
}

export function createDoneAllConfirmToken(input: DoneAllTokenInput): string {
  const material = {
    operation: "guardian_done_all/v1",
    repoRoot: path.resolve(input.repoRoot),
    remote: input.config.remote,
    baseBranch: input.config.baseBranch,
    baseRef: input.baseRef,
    baseRefOid: input.baseRefOid,
    allowIgnoredFiles: input.allowIgnoredFiles,
    allowAdminBypass: input.allowAdminBypass,
    allowedRemoteBranches: normalizeAllowedRemoteBranches(input.allowedRemoteBranches),
    protectedBranches: [...input.protectedBranches].sort(),
    sessions: input.plans.map((plan) => ({
      session_id: plan.session_id,
      branch: plan.branch,
      worktree_path: path.resolve(plan.worktree_path),
      head: plan.head,
      dirtyFileCount: plan.dirtyFileCount,
      disposition: plan.disposition,
      finishConfirmToken: plan.finishConfirmToken ?? null,
    })),
    cleanupPlan: cleanupPlanTokenMaterial(input.cleanupPlan),
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

function numberField(record: Record<string, unknown>, key: string): number {
  return typeof record[key] === "number" ? record[key] : 0;
}

function remainingKey(entry: Record<string, unknown>): string {
  return ["kind", "targetKind", "targetPath", "branch", "head", "remote", "remoteBranch", "reason"]
    .map((key) => `${key}:${String(entry[key] ?? "")}`)
    .join("\0");
}

function recordArrayField(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => isRecordLike(entry)) : [];
}

function uniqueRemaining(entries: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const unique: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const key = remainingKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

export function preSessionCleanupSweep(input: CleanupSweepInput): Record<string, unknown> {
  if (input.cleanupApply) {
    const cleanupApplyResults = Array.isArray(input.cleanupApply.results) ? input.cleanupApply.results : [];
    return {
      ok: input.cleanupApply.ok === true,
      status: input.cleanupApply.status === "cleaned" ? "cleaned" : "partial",
      reason: input.cleanupApply.ok === true ? undefined : "cleanup sweep applied safe candidates with remaining blockers",
      candidateCount: input.cleanupCandidates,
      retirementCandidateCount: input.cleanupRetirementCandidates,
      applyWorkCount: input.cleanupApplyWorkCount,
      cleanedCount: cleanupApplyResults.filter((result) => isRecordLike(result) && result.ok === true).length,
      failedCount: cleanupApplyResults.filter((result) => !isRecordLike(result) || result.ok !== true).length,
      retiredCount: recordArrayField(input.cleanupApply, "reservationRetirementResults").filter((result) => result.status === "retired").length,
      retirementFailedCount: recordArrayField(input.cleanupApply, "reservationRetirementResults").filter((result) => result.status !== "retired").length,
      plan: input.cleanupPlan,
      apply: input.cleanupApply,
      remaining: input.cleanupApply.remaining ?? input.cleanupApply.blockers ?? [],
    };
  }
  if (input.cleanupApplyWorkCount > 0) return { ok: false, status: "blocked", reason: "cleanup plan has work but no apply token", candidateCount: input.cleanupCandidates, retirementCandidateCount: input.cleanupRetirementCandidates, applyWorkCount: input.cleanupApplyWorkCount, plan: input.cleanupPlan };
  if (input.cleanupBlockers > 0 || input.cleanupPlan.ok !== true) return { ok: false, status: "partial", reason: "cleanup blockers remain", candidateCount: 0, retirementCandidateCount: 0, applyWorkCount: 0, plan: input.cleanupPlan, remaining: input.cleanupPlan.blockers ?? [] };
  return { ok: true, status: "no-op", candidateCount: 0, retirementCandidateCount: 0, applyWorkCount: 0, plan: input.cleanupPlan };
}

export function combineCleanupSweeps(preSession: Record<string, unknown>, postSession: Record<string, unknown>): Record<string, unknown> {
  const candidateCount = numberField(preSession, "candidateCount") + numberField(postSession, "candidateCount");
  const retirementCandidateCount = numberField(preSession, "retirementCandidateCount") + numberField(postSession, "retirementCandidateCount");
  const applyWorkCount = numberField(preSession, "applyWorkCount") + numberField(postSession, "applyWorkCount");
  const ok = preSession.ok === true && postSession.ok === true;
  return {
    ok,
    status: ok ? applyWorkCount === 0 ? "no-op" : "cleaned" : "partial",
    reason: ok ? undefined : "cleanup sweep applied safe candidates with remaining blockers",
    candidateCount,
    retirementCandidateCount,
    applyWorkCount,
    cleanedCount: numberField(preSession, "cleanedCount") + numberField(postSession, "cleanedCount"),
    failedCount: numberField(preSession, "failedCount") + numberField(postSession, "failedCount"),
    retiredCount: numberField(preSession, "retiredCount") + numberField(postSession, "retiredCount"),
    retirementFailedCount: numberField(preSession, "retirementFailedCount") + numberField(postSession, "retirementFailedCount"),
    preSession,
    postSession,
    remaining: uniqueRemaining([...recordArrayField(preSession, "remaining"), ...recordArrayField(postSession, "remaining")]),
  };
}
