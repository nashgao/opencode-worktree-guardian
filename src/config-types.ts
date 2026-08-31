export type GuardianFinishMode = "preserve-only" | "push-branch" | "create-pr" | "merge-to-base";
export type GuardianAutoStartMode = "eager" | "lazy";
export type GuardianCommandInterceptionMode = "audit" | "strict";
export type GuardianPullRequestMergeMethod = "merge" | "squash";
export type GuardianGoalHygieneCompletion = "authorized-cleanup" | "no-unprotected-findings" | "no-unprotected-residue";

export type GuardianGoalConfig = {
  readonly commitDirty: boolean;
  readonly landToBase: boolean;
  readonly pushBase: boolean;
  readonly cleanupWorktrees: boolean;
  readonly cleanupBranches: boolean;
  readonly cleanupHygiene: boolean;
  readonly hygieneCompletion?: GuardianGoalHygieneCompletion;
  readonly quarantineSessionResidue: boolean;
};

export type GuardianConfig = {
  readonly remote: string;
  readonly baseBranch: string;
  readonly worktreeRoot: string;
  readonly branchPrefix: string;
  readonly finishMode: GuardianFinishMode;
  readonly pullRequestMergeMethod?: GuardianPullRequestMergeMethod;
  readonly commandInterceptionMode: GuardianCommandInterceptionMode;
  readonly autoStart: boolean;
  readonly autoStartMode: GuardianAutoStartMode;
  readonly autoFinish: boolean;
  readonly autoCleanup: boolean;
  readonly safetyRefRetentionDays: number;
  readonly requireEmptyStashInventory: boolean;
  readonly allowBaseWorktreePreserveReset: boolean;
  readonly allowDirtyPaths: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly protectedBranches: readonly string[];
  readonly trustedUpstreamRemotes: readonly string[];
  readonly goal: GuardianGoalConfig;
  readonly lockTimeoutMs: number;
  readonly [key: string]: unknown;
};

export type ConfigFileSystem = {
  readonly readFile: (path: string, encoding: "utf8") => Promise<string>;
};

export type LoadConfigOptions = {
  readonly fs?: ConfigFileSystem;
  readonly configPath?: string;
};

export type LoadedGuardianConfig = {
  readonly config: GuardianConfig;
  readonly path: string;
  readonly loaded: boolean;
};
