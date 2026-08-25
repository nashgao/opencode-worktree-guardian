import type { CleanCompletionPlan } from "./clean-completion.ts";
import { planCleanCompletion } from "./clean-completion.ts";
import { buildDirtySessionDoneIntent } from "./done-intent.ts";
import { goalTokenValue } from "./goal-confirm-token.ts";
import { executeQuarantine } from "./quarantine-execute.ts";
import { getGuardianPaths, readState } from "./state.ts";
import type { GuardianConfig, GuardianToolInput, GuardianToolResult } from "./types.ts";

export type GoalCleanCompletionStep = {
  readonly tool: "guardian_clean_completion";
  readonly ok: boolean;
  readonly status: string;
  readonly reason?: string;
  readonly result?: GuardianToolResult;
};

type GoalCleanCompletionContext = {
  readonly repoRoot: string;
  readonly cwd: string;
  readonly cleanCompletion?: CleanCompletionPlan;
};

type GoalCleanCompletionPlanInput = {
  readonly request: GuardianToolInput;
  readonly repoRoot: string;
  readonly cwd: string;
  readonly config: GuardianConfig;
};

async function resolveCleanCompletionSession(repoRoot: string, config: GuardianConfig, sessionId: unknown) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const paths = await getGuardianPaths(repoRoot);
  const state = await readState(paths, { repoRoot, config });
  return state.sessions[sessionId] ?? null;
}

export async function planGoalCleanCompletion(input: GoalCleanCompletionPlanInput): Promise<CleanCompletionPlan | undefined> {
  const { request, repoRoot, cwd, config } = input;
  if (!config.goal.quarantineSessionResidue) return undefined;
  const session = await resolveCleanCompletionSession(repoRoot, config, request.sessionId);
  if (!session) return { applicable: false, finalProof: { status: "not-applicable", reason: "no session resolved for quarantine session residue check", candidates: [] }, incompleteOperationCount: 0 };
  return planCleanCompletion({ repoRoot, cwd, config, session });
}

export function goalCleanCompletionBlockReason(plan: CleanCompletionPlan): string | null {
  if (!plan.applicable) return plan.finalProof.reason ?? "clean-completion proof is not applicable";
  if (plan.finalProof.status !== "stable") return plan.finalProof.reason ?? "clean-completion proof is unstable";
  const blocked = plan.finalProof.candidates.find((candidate) => candidate.disposition === "block");
  return blocked?.reason ? `clean-completion candidate blocked: ${blocked.relativePath}: ${blocked.reason}` : null;
}

export function plannedGoalCleanCompletionStep(plan: CleanCompletionPlan): GoalCleanCompletionStep {
  const reason = goalCleanCompletionBlockReason(plan);
  return reason
    ? { tool: "guardian_clean_completion", ok: false, status: "blocked", reason }
    : { tool: "guardian_clean_completion", ok: true, status: "planned" };
}

export async function applyGoalCleanCompletion(input: GuardianToolInput, plan: GoalCleanCompletionContext, config: GuardianConfig): Promise<GoalCleanCompletionStep> {
  if (!plan.cleanCompletion) return { tool: "guardian_clean_completion", ok: true, status: "skipped", reason: "quarantineSessionResidue=false" };
  const session = await resolveCleanCompletionSession(plan.repoRoot, config, input.sessionId);
  if (!session) return { tool: "guardian_clean_completion", ok: false, status: "blocked", reason: "clean-completion session is unavailable" };
  const fresh = await planCleanCompletion({ repoRoot: plan.repoRoot, cwd: plan.cwd, config, session });
  if (JSON.stringify(goalTokenValue(fresh)) !== JSON.stringify(goalTokenValue(plan.cleanCompletion))) {
    return { tool: "guardian_clean_completion", ok: false, status: "blocked", reason: "clean-completion plan changed; re-run mode=plan" };
  }
  const reason = goalCleanCompletionBlockReason(fresh);
  if (reason) return { tool: "guardian_clean_completion", ok: false, status: "blocked", reason };
  const manifestDigest = session.provenance?.manifest?.digest;
  if (typeof manifestDigest !== "string" || manifestDigest.length === 0) {
    return { tool: "guardian_clean_completion", ok: false, status: "blocked", reason: "clean-completion session manifest is unavailable" };
  }
  const worktreePath = typeof session.worktree_path === "string" ? session.worktree_path : plan.cwd;
  const intent = await buildDirtySessionDoneIntent({ cwd: worktreePath, worktreePath });
  const quarantined: string[] = [];
  try {
    for (const candidate of fresh.finalProof.candidates) {
      if (candidate.disposition !== "quarantine") continue;
      await executeQuarantine({
        paths: await getGuardianPaths(plan.repoRoot),
        repoRoot: plan.repoRoot,
        config,
        session,
        relativePath: candidate.relativePath,
        manifestDigest,
        doneIntentDigest: intent.digest,
      });
      quarantined.push(candidate.relativePath);
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { tool: "guardian_clean_completion", ok: false, status: "blocked", reason: error.message };
  }
  return { tool: "guardian_clean_completion", ok: true, status: "applied", result: { ok: true, status: "quarantined", quarantinedPaths: quarantined, cleanCompletion: fresh } };
}
