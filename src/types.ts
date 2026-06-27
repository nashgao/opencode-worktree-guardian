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

export type GuardianToolInput = MutableRecord;
export type GuardianToolResult = MutableRecord & {
  ok?: boolean;
  status?: string | RecordLike;
  reason?: string;
  session?: GuardianSession;
  sessions?: readonly GuardianSession[];
  activeSessions?: readonly GuardianSession[];
  terminalSessions?: readonly GuardianSession[];
  worktrees?: readonly WorktreeEntry[];
  preflight?: MutableRecord;
  previous?: MutableRecord & {
    branch?: string;
    worktree_path?: string;
    reason?: string;
  };
  report?: MutableRecord;
  summary?: MutableRecord;
  confirmToken?: string;
  repoRoot?: string;
  safetyRefs?: readonly unknown[];
};

export type SessionWorktreeResult = {
  readonly ok: boolean;
  readonly sessionId?: string | null;
  readonly expectedWorktree?: string | null;
  readonly actualWorktree?: string | null;
  readonly matches?: boolean;
  readonly source?: string;
  readonly terminal?: boolean;
  readonly status?: string;
  readonly reason?: string;
  readonly [key: string]: unknown;
};

export type GuardOptions = {
  readonly cwd?: string;
  readonly knownWorktreePaths?: readonly string[];
  readonly protectedBranches?: readonly string[];
  readonly branchPrefix?: string | null;
  readonly guardianBranches?: readonly string[];
  readonly protectedBranchWorktreePaths?: readonly string[];
  readonly currentBranch?: string | null;
  readonly inheritedEnvAssignments?: readonly string[];
  readonly [key: string]: unknown;
};

export type GuardCommandPayload = MutableRecord & {
  args?: MutableRecord & {
    command?: unknown;
    cwd?: unknown;
    workdir?: unknown;
  };
  parts?: readonly { readonly type: string; readonly text: string }[];
  system?: unknown;
  command?: unknown;
  code?: unknown;
  tool?: unknown;
  callID?: unknown;
  sessionID?: unknown;
  sessionId?: unknown;
};

export type GuardDecision = {
  readonly blocked: boolean;
  readonly reason: string | null;
  readonly command: string;
  readonly tokens?: readonly string[];
  readonly segment?: readonly string[];
};

export type AllowDecision = {
  readonly allowed: boolean;
  readonly reason: string | null;
};

export type HookContext = {
  readonly directory?: string;
  readonly worktree?: string;
  readonly sessionID?: string;
  readonly sessionId?: string;
  readonly metadata?: (metadata: { readonly title?: string; readonly metadata?: RecordLike }) => void;
  readonly [key: string]: unknown;
};

export type PluginClient = {
  readonly app?: {
    readonly log?: (event: { readonly body: RecordLike }) => Promise<void> | void;
  };
};

export type PluginServerOptions = {
  readonly client?: PluginClient;
  readonly directory?: string;
  readonly worktree?: string;
};

export type ToolExecutionPayload = MutableRecord & {
  args?: MutableRecord;
  parts?: readonly { readonly type: string; readonly text: string }[];
  system?: unknown;
  command?: unknown;
  tool?: unknown;
  callID?: unknown;
  sessionID?: unknown;
  sessionId?: unknown;
};

export const GUARDIAN_TOOL_NAMES = [
  "guardian_delete_paths",
  "guardian_delete_worktree",
  "guardian_done",
  "guardian_finish",
  "guardian_finish_workflow",
  "guardian_gc",
  "guardian_hygiene",
  "guardian_preserve",
  "guardian_project_status",
  "guardian_recover",
  "guardian_report_html",
  "guardian_start",
  "guardian_status",
  "guardian_unblock_finish",
] as const;

export type GuardianToolName = typeof GUARDIAN_TOOL_NAMES[number];

export type GuardianPluginMetadata = {
  readonly id: string;
};

export type GuardianNativeToolReturn = {
  readonly title: GuardianToolName;
  readonly metadata: GuardianToolResult;
  readonly output: string;
};

export type PlanTokenCache = Map<string, string>;

export type PlanCacheToolArgs = MutableRecord & {
  mode?: unknown;
  sessionId?: unknown;
  repoRoot?: unknown;
  cwd?: unknown;
  paths?: unknown;
  cleanupPaths?: unknown;
  allowCategories?: unknown;
  allowTracked?: unknown;
  allowRecursive?: unknown;
  projectRoots?: unknown;
  writeReport?: unknown;
  allowDirtyNestedGit?: unknown;
  commitMessage?: unknown;
  finishMode?: unknown;
  deleteBranch?: unknown;
  abandonUnmerged?: unknown;
  allowIgnoredFiles?: unknown;
  allowRedundantDirtyPaths?: unknown;
  action?: unknown;
  confirm?: unknown;
  confirmDelete?: unknown;
  confirmToken?: unknown;
  branch?: unknown;
  targetPath?: unknown;
  worktreePath?: unknown;
};

export function isRecordLike(value: unknown): value is RecordLike {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isMutableRecord(value: unknown): value is MutableRecord {
  return isRecordLike(value);
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function isGuardianToolName(value: string): value is GuardianToolName {
  return GUARDIAN_TOOL_NAMES.some((toolName) => toolName === value);
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
