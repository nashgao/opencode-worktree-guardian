import { getCurrentBranch, getDirtyFiles, getHeadCommit, getRepoRoot } from "./git.ts";
import { isActiveSession } from "./lifecycle.ts";
import { getGuardianPaths, readState } from "./state.ts";
import { isRecordLike } from "./types.ts";
import type { GuardianConfig, GuardianSession } from "./types.ts";
import { activeFeatureSessions } from "./done-feature-sessions.ts";
import { dirtySnapshot, type DirtySnapshot } from "./done-primary-snapshot.ts";
import { samePath } from "./done-shared.ts";

export type DonePrimaryInventory = {
  readonly branch: string | null;
  readonly dirtyFiles: readonly string[];
  readonly dirtySnapshot: DirtySnapshot;
};

export type DoneSessionInventory = {
  readonly sessionId: string;
  readonly session: GuardianSession;
  readonly branch: string | null;
  readonly worktreePath: string;
  readonly head: string | null;
  readonly dirtyFiles: readonly string[];
  readonly isCurrentWorktree: boolean;
};

export type DoneDirtyTarget =
  | {
    readonly targetKind: "primary";
    readonly label: "primary";
    readonly branch: string | null;
    readonly worktreePath: string;
    readonly dirtyFiles: readonly string[];
    readonly suggestedCommand: string;
  }
  | {
    readonly targetKind: "session";
    readonly label: string;
    readonly sessionId: string;
    readonly branch: string | null;
    readonly worktreePath: string;
    readonly dirtyFiles: readonly string[];
    readonly suggestedCommand: string;
  };

export type DoneWorkInventory = {
  readonly repoRoot: string;
  readonly currentWorktree: string;
  readonly currentBranch: string | null;
  readonly baseBranch: string;
  readonly remote: string;
  readonly protectedBranches: readonly string[];
  readonly state: Awaited<ReturnType<typeof readState>>;
  readonly primary: DonePrimaryInventory;
  readonly sessions: readonly DoneSessionInventory[];
  readonly dirtyTargets: readonly DoneDirtyTarget[];
  readonly currentSessionId: string | null;
};

export type BuildDoneWorkInventoryOptions = {
  readonly repoRoot: string;
  readonly cwd: string;
  readonly config: GuardianConfig;
};

function protectedBranches(config: GuardianConfig): readonly string[] {
  return Array.isArray(config.protectedBranches) ? config.protectedBranches.filter((branch): branch is string => typeof branch === "string") : [];
}

function sessionSuggestedCommand(session: DoneSessionInventory): string {
  if (typeof session.branch === "string" && session.branch.length > 0) return `guardian_done branch=${session.branch} commitMessage=...`;
  return `guardian_done sessionId=${session.sessionId} commitMessage=...`;
}

function dirtyTargets(inventory: Omit<DoneWorkInventory, "dirtyTargets">): readonly DoneDirtyTarget[] {
  const targets: DoneDirtyTarget[] = [];
  if (inventory.primary.dirtyFiles.length > 0) {
    targets.push({
      targetKind: "primary",
      label: "primary",
      branch: inventory.primary.branch,
      worktreePath: inventory.repoRoot,
      dirtyFiles: inventory.primary.dirtyFiles,
      suggestedCommand: "guardian_done primary=true commitMessage=...",
    });
  }
  for (const session of inventory.sessions) {
    if (session.dirtyFiles.length === 0) continue;
    targets.push({
      targetKind: "session",
      label: session.branch ?? session.sessionId,
      sessionId: session.sessionId,
      branch: session.branch,
      worktreePath: session.worktreePath,
      dirtyFiles: session.dirtyFiles,
      suggestedCommand: sessionSuggestedCommand(session),
    });
  }
  return targets;
}

function activeSessionIdForWorktree(state: Awaited<ReturnType<typeof readState>>, currentWorktree: string): string | null {
  for (const [sessionId, session] of Object.entries(state.sessions ?? {})) {
    if (isRecordLike(session) && isActiveSession(session) && typeof session.worktree_path === "string" && samePath(session.worktree_path, currentWorktree)) return sessionId;
  }
  return null;
}

export async function buildDoneWorkInventory(options: BuildDoneWorkInventoryOptions): Promise<DoneWorkInventory> {
  const repoRoot = options.repoRoot;
  const currentWorktree = await getRepoRoot(options.cwd);
  const currentBranch = await getCurrentBranch(currentWorktree);
  const state = await readState(await getGuardianPaths(repoRoot), { repoRoot, config: options.config });
  const featureSessions = await activeFeatureSessions(state, repoRoot, options.config);
  const sessions: DoneSessionInventory[] = [];
  for (const featureSession of featureSessions) {
    const session = state.sessions[featureSession.session_id];
    if (!isRecordLike(session)) continue;
    const head = await getHeadCommit(featureSession.worktree_path).catch(() => featureSession.head);
    const dirtyFiles = await getDirtyFiles(featureSession.worktree_path).catch(() => [] as string[]);
    sessions.push({
      sessionId: featureSession.session_id,
      session,
      branch: featureSession.branch,
      worktreePath: featureSession.worktree_path,
      head,
      dirtyFiles,
      isCurrentWorktree: samePath(featureSession.worktree_path, currentWorktree),
    });
  }
  sessions.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  const snapshot = await dirtySnapshot(repoRoot, options.config);
  const withoutTargets = {
    repoRoot,
    currentWorktree,
    currentBranch,
    baseBranch: String(options.config.baseBranch),
    remote: String(options.config.remote),
    protectedBranches: protectedBranches(options.config),
    state,
    primary: { branch: await getCurrentBranch(repoRoot), dirtyFiles: snapshot.paths, dirtySnapshot: snapshot },
    sessions,
    currentSessionId: activeSessionIdForWorktree(state, currentWorktree),
  };
  return { ...withoutTargets, dirtyTargets: dirtyTargets(withoutTargets) };
}
