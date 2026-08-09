import type { GuardianConfig, GuardianGoalConfig, GuardianGoalHygieneCompletion } from "./types.ts";

export type NormalizedGuardianGoalConfig = Omit<GuardianGoalConfig, "hygieneCompletion"> & {
  readonly hygieneCompletion: GuardianGoalHygieneCompletion;
};

export type NormalizedGuardianConfig = GuardianConfig & {
  readonly goal: NormalizedGuardianGoalConfig;
};
