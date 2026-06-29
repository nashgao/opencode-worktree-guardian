export type RecordLike = Record<string, unknown>;

export type MutableRecord = {
  [key: string]: unknown;
};

export type GuardianFinishMode = "preserve-only" | "push-branch" | "create-pr" | "merge-to-base";
export type GuardianAutoStartMode = "eager" | "lazy";

export type GuardianConfig = {
  readonly remote: string;
  readonly baseBranch: string;
  readonly worktreeRoot: string;
  readonly branchPrefix: string;
  readonly finishMode: GuardianFinishMode;
  readonly autoStart: boolean;
  readonly autoStartMode: GuardianAutoStartMode;
  readonly autoFinish: boolean;
  readonly autoCleanup: boolean;
  readonly safetyRefRetentionDays: number;
  readonly allowStashIfUnrelated: boolean;
  readonly allowBaseWorktreePreserveReset: boolean;
  readonly allowDirtyPaths: readonly string[];
  readonly protectedBranches: readonly string[];
  readonly trustedUpstreamRemotes: readonly string[];
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

export type GuardianPaths = {
  readonly dir: string;
  readonly statePath: string;
  readonly eventsPath: string;
  readonly reportPath: string;
  readonly lockPath: string;
};

export type GuardianSessionStatus =
  | "active"
  | "deleted"
  | "abandoned"
  | "finished"
  | "preserved"
  | "superseded"
  | string;

export type GuardianSession = {
  readonly session_id?: string;
  readonly sessionId?: string;
  readonly status?: GuardianSessionStatus;
  readonly branch?: string;
  readonly worktree_path?: string;
  readonly worktreePath?: string;
  readonly base_ref?: string;
  readonly head_commit?: string;
  readonly safety_refs?: readonly string[];
  readonly deleted_worktree_path?: string;
  readonly deleted_branch?: string | null;
  readonly abandoned_branch?: string;
  readonly branch_only_delete?: boolean;
  readonly superseded_by?: string;
  readonly superseded_at?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly state_version?: number;
  readonly [key: string]: unknown;
};

export type GuardianState = {
  schema_version: string;
  state_version: number;
  repo_root: string;
  base_branch: string;
  remote: string;
  finish_mode: string;
  worktree_root: string;
  sessions: Record<string, GuardianSession>;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
};

export type GuardianStateRecord = MutableRecord & {
  schema_version?: unknown;
  state_version?: number;
  sessions: Record<string, GuardianSession>;
};

export type WorktreeEntry = {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly detached?: boolean;
  readonly bare?: boolean;
  readonly [key: string]: unknown;
};

export type {
  AllowDecision,
  GuardCommandPayload,
  GuardDecision,
  GuardianNativeToolReturn,
  GuardianPluginMetadata,
  GuardianToolInput,
  GuardianToolName,
  GuardianToolResult,
  GuardOptions,
  HookContext,
  PlanCacheToolArgs,
  PlanTokenCache,
  PluginClient,
  PluginServerOptions,
  SessionWorktreeResult,
  ToolExecutionPayload,
} from "./tool-types.ts";
export { GUARDIAN_TOOL_NAMES, isGuardianToolName } from "./tool-types.ts";

export function isRecordLike(value: unknown): value is RecordLike {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isMutableRecord(value: unknown): value is MutableRecord {
  return isRecordLike(value);
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function errorCode(error: unknown): string | undefined {
  return isRecordLike(error) && typeof error.code === "string" ? error.code : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type GitCommandOutput = { readonly stdout: string; readonly stderr: string };

export type GitCommandMetadata = {
  readonly gitArgs: readonly string[];
  readonly gitStdout: string;
  readonly gitStderr: string;
  readonly gitExitCode?: number;
  readonly gitSignal?: string;
};

export type GitCommandFailure = Error & GitCommandMetadata;

function textFromOutput(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Buffer.isBuffer(value)) return value.toString("utf8").trim();
  return "";
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function gitMetadataFromError(args: readonly string[], error: unknown, fallback: GitCommandOutput = { stdout: "", stderr: "" }): GitCommandMetadata {
  if (!isRecordLike(error)) {
    return { gitArgs: [...args], gitStdout: fallback.stdout, gitStderr: fallback.stderr };
  }
  const code = typeof error.code === "number" ? error.code : undefined;
  const signal = typeof error.signal === "string" ? error.signal : undefined;
  return {
    gitArgs: [...args],
    gitStdout: textFromOutput(error.stdout) || fallback.stdout,
    gitStderr: textFromOutput(error.stderr) || fallback.stderr,
    ...(code === undefined ? {} : { gitExitCode: code }),
    ...(signal === undefined ? {} : { gitSignal: signal }),
  };
}

export function withGitMetadata(error: unknown, metadata: GitCommandMetadata): GitCommandFailure {
  return Object.assign(toError(error), metadata);
}
