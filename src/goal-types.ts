import type { CleanCompletionPlan } from "./clean-completion.ts";
import type { GoalHygienePostcondition } from "./goal-hygiene-types.ts";
import type { GoalStep, GoalTool } from "./goal-steps.ts";
import type { NormalizedGuardianGoalConfig } from "./normalized-config.ts";

export type GoalBlocker = {
  readonly tool: GoalTool | "guardian_goal";
  readonly reason: string;
};

export type GoalPlan = {
  readonly ok: boolean;
  readonly complete: null;
  readonly status: "planned" | "planned-partial" | "blocked";
  readonly lane: "goal";
  readonly repoRoot: string;
  readonly cwd: string;
  readonly intentionalPaths: readonly string[];
  readonly goal: NormalizedGuardianGoalConfig;
  readonly steps: readonly GoalStep[];
  readonly blockers: readonly GoalBlocker[];
  readonly hygienePostcondition: GoalHygienePostcondition;
  readonly cleanCompletion?: CleanCompletionPlan;
  readonly confirmToken?: string;
  readonly nextAction?: string;
  readonly reason?: string;
};
