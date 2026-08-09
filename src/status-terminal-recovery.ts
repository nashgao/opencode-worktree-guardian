import { recoverableGuardianWorktreeBlocker } from "./worktree-recovery.ts";
import type { GitBranchEntry } from "./git.ts";
import type { GuardianConfig, GuardianSession, WorktreeEntry } from "./types.ts";
import type { TerminalRecoveryAction } from "./status-result-types.ts";
import { isTerminalSessionStatus } from "./lifecycle.ts";

const TERMINAL_RECOVERY_ACTION_LIMIT = 5;

type CanonicalWorktree = {
  readonly entry: WorktreeEntry;
  readonly canonicalPath: string;
};

type CanonicalTerminalSession = {
  readonly session: GuardianSession;
  readonly canonicalWorktreePath: string | null;
};

type TerminalRecoveryInventory = {
  readonly repoRoot: string;
  readonly config: GuardianConfig;
  readonly terminalSessions: readonly CanonicalTerminalSession[];
  readonly worktrees: readonly CanonicalWorktree[];
  readonly activeWorktreePaths: ReadonlySet<string>;
  readonly activeBranches: ReadonlySet<string>;
  readonly branchesWithoutWorktrees: readonly GitBranchEntry[];
};

export type TerminalRecoveryPlans = {
  readonly actions: readonly TerminalRecoveryAction[];
  readonly count: number;
  readonly omittedCount: number;
};

function commandValue(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : JSON.stringify(value);
}

function reattachAction(input: TerminalRecoveryInventory, terminal: CanonicalTerminalSession): TerminalRecoveryAction | null {
  const { session, canonicalWorktreePath } = terminal;
  if (!canonicalWorktreePath || typeof session.session_id !== "string" || typeof session.branch !== "string" || typeof session.head_commit !== "string" || !isTerminalSessionStatus(session.status)) return null;
  if (input.activeWorktreePaths.has(canonicalWorktreePath) || input.activeBranches.has(session.branch)) return null;
  const worktree = input.worktrees.find((candidate) => candidate.canonicalPath === canonicalWorktreePath);
  if (!worktree || worktree.entry.branch !== session.branch || worktree.entry.head !== session.head_commit) return null;
  if (recoverableGuardianWorktreeBlocker(input.repoRoot, worktree.canonicalPath, worktree.entry.branch ?? null, input.config)) return null;
  return {
    kind: "reattach",
    sessionId: session.session_id,
    status: session.status,
    branch: session.branch,
    head: session.head_commit,
    worktreePath: worktree.canonicalPath,
    command: `guardian_done cwd=${commandValue(worktree.canonicalPath)} mode=plan`,
  };
}

function cleanupAction(input: TerminalRecoveryInventory, terminal: CanonicalTerminalSession): TerminalRecoveryAction | null {
  const { session } = terminal;
  if (typeof session.session_id !== "string" || typeof session.branch !== "string" || typeof session.head_commit !== "string" || !isTerminalSessionStatus(session.status)) return null;
  if (input.activeBranches.has(session.branch)) return null;
  if (input.config.protectedBranches.includes(session.branch)) return null;
  const matchingBranch = input.branchesWithoutWorktrees.find((branch) => branch.name === session.branch && branch.commit === session.head_commit);
  if (!matchingBranch) return null;
  return {
    kind: "cleanup",
    sessionId: session.session_id,
    status: session.status,
    branch: session.branch,
    head: session.head_commit,
    command: `guardian_delete_worktree mode=plan sessionId=${commandValue(session.session_id)} deleteBranch=true`,
  };
}

function actionForTerminalSession(input: TerminalRecoveryInventory, terminal: CanonicalTerminalSession): TerminalRecoveryAction | null {
  return reattachAction(input, terminal) ?? cleanupAction(input, terminal);
}

export function terminalRecoveryPlans(input: TerminalRecoveryInventory): TerminalRecoveryPlans {
  const actionByTarget = new Map<string, TerminalRecoveryAction>();
  for (const action of input.terminalSessions
    .map((terminal) => actionForTerminalSession(input, terminal))
    .filter((action): action is TerminalRecoveryAction => action !== null)) {
    const target = action.kind === "reattach"
      ? `reattach\0${action.worktreePath ?? ""}\0${action.branch}\0${action.head}`
      : `cleanup\0${action.branch}\0${action.head}`;
    const existing = actionByTarget.get(target);
    if (!existing || action.sessionId.localeCompare(existing.sessionId) < 0) actionByTarget.set(target, action);
  }
  const allActions = [...actionByTarget.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  return {
    actions: allActions.slice(0, TERMINAL_RECOVERY_ACTION_LIMIT),
    count: allActions.length,
    omittedCount: Math.max(0, allActions.length - TERMINAL_RECOVERY_ACTION_LIMIT),
  };
}
