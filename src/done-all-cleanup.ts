import crypto from "node:crypto";
import path from "node:path";
import { candidateTokenMaterial } from "./workflow-candidates.ts";
import { isRecordLike } from "./types.ts";
import type { GuardianConfig } from "./types.ts";

export type DoneAllTokenPlan = {
  readonly session_id: string;
  readonly branch: string | null;
  readonly worktree_path: string;
  readonly head: string | null;
  readonly dirtyFileCount: number;
  readonly disposition: string;
};

type DoneAllTokenInput = {
  readonly repoRoot: string;
  readonly config: GuardianConfig;
  readonly baseRef: string;
  readonly baseRefOid: string | null;
  readonly protectedBranches: readonly string[];
  readonly plans: readonly DoneAllTokenPlan[];
  readonly cleanupPlan: Record<string, unknown>;
};

type CleanupSweepInput = {
  readonly cleanupPlan: Record<string, unknown>;
  readonly cleanupCandidates: number;
  readonly cleanupBlockers: number;
  readonly cleanupApply: Record<string, unknown> | null;
};

function cleanupPlanTokenMaterial(cleanupPlan: Record<string, unknown>): Record<string, unknown> {
  const candidates = Array.isArray(cleanupPlan.candidates) ? cleanupPlan.candidates.filter((candidate): candidate is Record<string, unknown> => isRecordLike(candidate)) : [];
  const blockers = Array.isArray(cleanupPlan.blockers) ? cleanupPlan.blockers.filter((blocker): blocker is Record<string, unknown> => isRecordLike(blocker)) : [];
  return {
    ok: cleanupPlan.ok === true,
    status: typeof cleanupPlan.status === "string" ? cleanupPlan.status : null,
    confirmToken: typeof cleanupPlan.confirmToken === "string" ? cleanupPlan.confirmToken : null,
    candidates: candidates.map(candidateTokenMaterial),
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
    protectedBranches: [...input.protectedBranches].sort(),
    sessions: input.plans.map((plan) => ({
      session_id: plan.session_id,
      branch: plan.branch,
      worktree_path: path.resolve(plan.worktree_path),
      head: plan.head,
      dirtyFileCount: plan.dirtyFileCount,
      disposition: plan.disposition,
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
      cleanedCount: cleanupApplyResults.filter((result) => isRecordLike(result) && result.ok === true).length,
      failedCount: cleanupApplyResults.filter((result) => !isRecordLike(result) || result.ok !== true).length,
      plan: input.cleanupPlan,
      apply: input.cleanupApply,
      remaining: input.cleanupApply.remaining ?? input.cleanupApply.blockers ?? [],
    };
  }
  if (input.cleanupCandidates > 0) return { ok: false, status: "blocked", reason: "cleanup plan has candidates but no apply token", candidateCount: input.cleanupCandidates, plan: input.cleanupPlan };
  if (input.cleanupBlockers > 0 || input.cleanupPlan.ok !== true) return { ok: false, status: "partial", reason: "cleanup blockers remain", candidateCount: 0, plan: input.cleanupPlan, remaining: input.cleanupPlan.blockers ?? [] };
  return { ok: true, status: "no-op", candidateCount: 0, plan: input.cleanupPlan };
}

export function combineCleanupSweeps(preSession: Record<string, unknown>, postSession: Record<string, unknown>): Record<string, unknown> {
  const candidateCount = numberField(preSession, "candidateCount") + numberField(postSession, "candidateCount");
  const ok = preSession.ok === true && postSession.ok === true;
  return {
    ok,
    status: ok ? candidateCount === 0 ? "no-op" : "cleaned" : "partial",
    reason: ok ? undefined : "cleanup sweep applied safe candidates with remaining blockers",
    candidateCount,
    cleanedCount: numberField(preSession, "cleanedCount") + numberField(postSession, "cleanedCount"),
    failedCount: numberField(preSession, "failedCount") + numberField(postSession, "failedCount"),
    preSession,
    postSession,
    remaining: uniqueRemaining([...recordArrayField(preSession, "remaining"), ...recordArrayField(postSession, "remaining")]),
  };
}
