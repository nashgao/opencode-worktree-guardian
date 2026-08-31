import type { GuardianConfig, GuardianGoalConfig, GuardianGoalHygieneCompletion, GuardianPullRequestMergeMethod } from "./types.ts";

export type NormalizedGuardianGoalConfig = Omit<GuardianGoalConfig, "hygieneCompletion"> & {
  readonly hygieneCompletion: GuardianGoalHygieneCompletion;
};

export type NormalizedGuardianConfig = GuardianConfig & {
  readonly goal: NormalizedGuardianGoalConfig;
  readonly pullRequestMergeMethod: GuardianPullRequestMergeMethod;
};
