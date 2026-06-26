import { guardianFinishWorkflow } from "./workflow.ts";
import type { GuardianConfig } from "./types.ts";

export async function runCleanupSweep(repoRoot: string, config: GuardianConfig, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const plan = await guardianFinishWorkflow({ ...input, repoRoot, cwd: repoRoot, mode: "plan", config });
  if (plan.ok !== true) return { ok: false, status: "blocked", reason: "cleanup sweep planning blocked", plan };
  const candidates = Array.isArray(plan.candidates) ? plan.candidates : [];
  if (candidates.length === 0) return { ok: true, status: "no-op", candidateCount: 0, plan };
  if (typeof plan.confirmToken !== "string") return { ok: false, status: "blocked", reason: "cleanup sweep plan did not return a confirm token", plan };
  const applied = await guardianFinishWorkflow({ ...input, repoRoot, cwd: repoRoot, mode: "apply", confirmToken: plan.confirmToken, config });
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
