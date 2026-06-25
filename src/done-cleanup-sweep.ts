import { guardianFinishWorkflow } from "./workflow.ts";
import type { GuardianConfig } from "./types.ts";

export async function runCleanupSweep(repoRoot: string, config: GuardianConfig, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const plan = await guardianFinishWorkflow({ ...input, repoRoot, cwd: repoRoot, mode: "plan", config });
  if (plan.ok !== true) return { ok: false, status: "blocked", reason: "cleanup sweep planning blocked", plan };
  const candidates = Array.isArray(plan.candidates) ? plan.candidates : [];
  if (candidates.length === 0) return { ok: true, status: "no-op", candidateCount: 0, plan };
  if (typeof plan.confirmToken !== "string") return { ok: false, status: "blocked", reason: "cleanup sweep plan did not return a confirm token", plan };
  return {
    ok: true,
    status: "planned",
    reason: "cleanup sweep candidates require a separate guardian_finish_workflow apply confirmation",
    candidateCount: candidates.length,
    cleanedCount: 0,
    failedCount: 0,
    confirmToken: plan.confirmToken,
    plan,
    nextAction: "Review cleanupSweep.plan, then run guardian_finish_workflow mode=apply with its confirmToken if cleanup is intended.",
  };
}
