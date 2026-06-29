import type { GuardianSession, MutableRecord, RecordLike, WorktreeEntry } from "./types.ts";

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
  primary?: unknown;
  branch?: unknown;
  targetPath?: unknown;
  worktreePath?: unknown;
};

export function isGuardianToolName(value: string): value is GuardianToolName {
  return GUARDIAN_TOOL_NAMES.some((toolName) => toolName === value);
}
