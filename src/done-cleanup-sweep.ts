import { guardianFinishWorkflow } from "./workflow.ts";
import type { FinalPostflightCommit } from "./final-postflight.ts";
import { isRecordLike } from "./types.ts";
import type { GuardianConfig } from "./types.ts";

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => isRecordLike(entry)) : [];
}

function cleanupCommitSource(result: Record<string, unknown>): string {
  if (typeof result.remote === "string" && typeof result.remoteBranch === "string") return `${result.remote}/${result.remoteBranch}`;
  return typeof result.branch === "string" ? result.branch : "cleanup-sweep";
}

function cleanupPostflightCommit(result: Record<string, unknown>): FinalPostflightCommit | null {
  if (result.ok !== true || typeof result.head !== "string") return null;
  if (result.branchDeleted !== true && result.worktreeRemoved !== true && result.remoteBranchDeleted !== true) return null;
  if (result.abandonUnmerged === true) {
    return {
      commit: result.head,
      source: cleanupCommitSource(result),
      reason: "cleanup sweep intentionally abandoned an unmerged Guardian-owned branch",
      discardConfirmed: true,
      discardEvidence: {
        safetyRef: result.safetyRef,
        unmergedCommits: result.unmergedCommits,
      },
    };
  }
  return {
    commit: result.head,
    source: cleanupCommitSource(result),
    reason: "cleanup sweep deleted a branch or worktree that must be present on final base",
  };
}

export function finalPostflightCommitsFromCleanupSweep(cleanupSweep: Record<string, unknown>): FinalPostflightCommit[] {
  const commits: FinalPostflightCommit[] = [];
  const seen = new Set<string>();
  const visit = (record: Record<string, unknown>): void => {
    for (const result of recordArray(record.results)) {
      const commit = cleanupPostflightCommit(result);
      if (!commit || seen.has(commit.commit)) continue;
      seen.add(commit.commit);
      commits.push(commit);
    }
    for (const key of ["apply", "preSession", "postSession"] as const) {
      const child = record[key];
      if (isRecordLike(child)) visit(child);
    }
  };
  visit(cleanupSweep);
  return commits;
}

export async function runCleanupSweep(repoRoot: string, config: GuardianConfig, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const plan = await guardianFinishWorkflow({ ...input, repoRoot, cwd: repoRoot, mode: "plan", config, skipFinalPostflight: true, abandonUnmerged: true });
  if (plan.ok !== true) return { ok: false, status: "blocked", reason: "cleanup sweep planning blocked", plan };
  const candidates = Array.isArray(plan.candidates) ? plan.candidates : [];
  if (candidates.length === 0) return { ok: true, status: "no-op", candidateCount: 0, plan };
  if (typeof plan.confirmToken !== "string") return { ok: false, status: "blocked", reason: "cleanup sweep plan did not return a confirm token", plan };
  const applied = await guardianFinishWorkflow({ ...input, repoRoot, cwd: repoRoot, mode: "apply", confirmToken: plan.confirmToken, config, skipFinalPostflight: true, abandonUnmerged: true });
  const results = Array.isArray(applied.results) ? applied.results : [];
  const cleanedCount = results.filter((result) => result && typeof result === "object" && (result as { ok?: unknown }).ok === true).length;
  const failedCount = results.length - cleanedCount;
  return {
    ok: applied.ok === true,
    status: applied.status === "cleaned" ? "cleaned" : "partial",
    reason: applied.ok === true ? undefined : "cleanup sweep applied safe candidates with remaining blockers",
    candidateCount: candidates.length,
    cleanedCount,
    failedCount,
    plan,
    apply: applied,
    remaining: applied.remaining ?? applied.blockers ?? [],
  };
}
