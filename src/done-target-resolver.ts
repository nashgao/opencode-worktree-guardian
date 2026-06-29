import type { GuardianSession } from "./types.ts";
import type { DoneDirtyTarget, DoneSessionInventory, DoneWorkInventory } from "./done-work-inventory.ts";

export type DoneTargetDecision =
  | { readonly kind: "session-finish"; readonly sessionId: string; readonly session: GuardianSession; readonly worktreePath: string; readonly branch: string | null; readonly selectedTarget?: DoneDirtyTarget }
  | { readonly kind: "primary-main-publish"; readonly explicit: boolean; readonly selectedTarget?: DoneDirtyTarget }
  | { readonly kind: "done-all" }
  | { readonly kind: "cleanup-only" }
  | { readonly kind: "reattach" }
  | { readonly kind: "primary-rescue-recommended" }
  | { readonly kind: "needs-selection"; readonly ok: false; readonly status: "needs-selection"; readonly lane: "select-target"; readonly reason: string; readonly candidates: readonly DoneDirtyTarget[]; readonly suggestedCommands: readonly string[] }
  | { readonly kind: "blocked"; readonly ok: false; readonly status: "blocked"; readonly lane: string; readonly reason: string; readonly branch?: string; readonly availableSessions?: readonly DoneSessionInventory[]; readonly suggestedCommands?: readonly string[] };

export type ResolveDoneTargetOptions = {
  readonly input: Record<string, unknown>;
  readonly inventory: DoneWorkInventory;
};

function requestedSessionId(input: Record<string, unknown>): string | null {
  return typeof input.sessionId === "string" && input.sessionId.trim().length > 0 ? input.sessionId.trim() : null;
}

function requestedBranch(input: Record<string, unknown>): string | null {
  return typeof input.branch === "string" && input.branch.trim().length > 0 ? input.branch.trim() : null;
}

function featureSessionCommands(sessions: readonly DoneSessionInventory[]): readonly string[] {
  return sessions
    .filter((session) => typeof session.branch === "string" && session.branch.length > 0)
    .map((session) => `guardian_done branch=${session.branch}`);
}

function sessionDecision(session: DoneSessionInventory, selectedTarget?: DoneDirtyTarget): DoneTargetDecision {
  return {
    kind: "session-finish",
    sessionId: session.sessionId,
    session: session.session,
    worktreePath: session.worktreePath,
    branch: session.branch,
    ...(selectedTarget ? { selectedTarget } : {}),
  };
}

function primaryTarget(inventory: DoneWorkInventory): DoneDirtyTarget | undefined {
  return inventory.dirtyTargets.find((target) => target.targetKind === "primary");
}

function sessionTarget(inventory: DoneWorkInventory, sessionId: string): DoneDirtyTarget | undefined {
  return inventory.dirtyTargets.find((target) => target.targetKind === "session" && target.sessionId === sessionId);
}

export function resolveDoneTarget(options: ResolveDoneTargetOptions): DoneTargetDecision {
  const { input, inventory } = options;
  const sessionId = requestedSessionId(input);
  const branch = requestedBranch(input);
  if (input.all === true) return { kind: "done-all" };
  if (input.primary === true) return { kind: "primary-main-publish", explicit: true, selectedTarget: primaryTarget(inventory) };

  if (branch && !sessionId) {
    const branchSession = inventory.sessions.find((session) => session.branch === branch);
    if (!branchSession) {
      return {
        kind: "blocked",
        ok: false,
        status: "blocked",
        lane: "branch-not-found",
        reason: `no active Guardian session owns branch ${branch}`,
        branch,
        availableSessions: inventory.sessions,
        suggestedCommands: featureSessionCommands(inventory.sessions),
      };
    }
    return sessionDecision(branchSession, sessionTarget(inventory, branchSession.sessionId));
  }

  if (sessionId) {
    const session = inventory.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (session) return sessionDecision(session, sessionTarget(inventory, session.sessionId));
  }

  if (inventory.currentSessionId) {
    const currentSession = inventory.sessions.find((session) => session.sessionId === inventory.currentSessionId);
    if (currentSession) return sessionDecision(currentSession, sessionTarget(inventory, currentSession.sessionId));
  }

  if (inventory.dirtyTargets.length === 1) {
    const [target] = inventory.dirtyTargets;
    if (target.targetKind === "primary") return { kind: "primary-main-publish", explicit: false, selectedTarget: target };
    const session = inventory.sessions.find((candidate) => candidate.sessionId === target.sessionId);
    if (session) return sessionDecision(session, target);
  }

  if (inventory.dirtyTargets.length > 1) {
    return {
      kind: "needs-selection",
      ok: false,
      status: "needs-selection",
      lane: "select-target",
      reason: "multiple dirty implementation targets require an explicit guardian_done target",
      candidates: inventory.dirtyTargets,
      suggestedCommands: inventory.dirtyTargets.map((target) => target.suggestedCommand),
    };
  }

  if (inventory.sessions.length > 0) return { kind: "done-all" };
  if (inventory.currentWorktree !== inventory.repoRoot) return { kind: "reattach" };
  if (inventory.currentBranch && inventory.protectedBranches.includes(inventory.currentBranch) && inventory.currentBranch !== inventory.baseBranch) return { kind: "primary-rescue-recommended" };
  return { kind: "cleanup-only" };
}
