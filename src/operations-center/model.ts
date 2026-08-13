import { createHash } from "node:crypto";
import type { ActiveSessionBaseDistance, CachedBaseAuthority } from "../status-base-distance.ts";
import type { GuardianRecoverResult, GuardianStatusResult, TerminalRecoveryAction } from "../status-result-types.ts";
import type { GuardianSession, WorktreeEntry } from "../types.ts";
import { canonicalPath, computeGuardianVerdict, guardianRiskCount } from "../verdict.ts";
import type { GuardianVerdict, GuardianVerdictTone } from "../verdict.ts";
import { buildTopologyDisplayModel, type TopologyDisplayModel } from "./topology-model.ts";

export { TOPOLOGY_MODES, type TopologyMode } from "./topology-types.ts";

const ACTION_IDS = ["add", "sync", "fetch", "pull", "switch", "open", "terminal", "remove"] as const;
export type OperationsCenterActionId = typeof ACTION_IDS[number];
type WorktreeTone = GuardianVerdictTone | "neutral";

export type OperationsCenterInput = {
  readonly reportPath: string;
  readonly generatedAt: string;
  readonly status: GuardianStatusResult;
  readonly recover: GuardianRecoverResult;
};

type WorktreeOwner =
  | { readonly state: "owned"; readonly lifecycle: "active" | "terminal"; readonly sessionId: string | null; readonly status: string | null; readonly path: string }
  | { readonly state: "unowned"; readonly sessionId: null; readonly status: null };

export type OperationsCenterWorktreeState = "primary" | "active" | "terminal" | "unmanaged" | "external" | "orphaned" | "poisoned";

type WorktreeBaseDistance =
  | { readonly status: "available"; readonly baseRef: string; readonly baseAuthorityRef: string; readonly baseRefOid: string; readonly head: string; readonly ahead: number; readonly behind: number; readonly relation: "equal" | "ahead" | "behind" | "diverged"; readonly detached: boolean }
  | { readonly status: "unavailable"; readonly reason: string };

export type OperationsCenterWorktree = {
  readonly id: string;
  readonly path: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly flags: { readonly primary: boolean; readonly linked: boolean; readonly detached: boolean; readonly bare: boolean };
  readonly owner: WorktreeOwner;
  readonly state: OperationsCenterWorktreeState;
  readonly tone: WorktreeTone;
  readonly risk: { readonly orphaned: boolean; readonly poisoned: boolean; readonly external: boolean };
  readonly baseDistance: WorktreeBaseDistance;
};

export type OperationsCenterEvent = {
  readonly kind: "created" | "updated" | "superseded" | "terminal-recovery-action";
  readonly sessionId: string;
  readonly at: string | null;
  readonly action: TerminalRecoveryAction | null;
};

export type OperationsCenterModel = {
  readonly identity: { readonly repoRoot: string; readonly reportPath: string; readonly generatedAt: string };
  readonly metrics: { readonly worktreeCount: number; readonly activeSessionCount: number; readonly terminalSessionCount: number; readonly riskCount: number; readonly dirtyFileCount: number; readonly recoveryCandidateCount: number };
  readonly verdict: GuardianVerdict;
  readonly worktrees: readonly OperationsCenterWorktree[];
  readonly topology: TopologyDisplayModel & { readonly nodes: readonly { readonly id: string; readonly worktreeId: string }[] };
  readonly observedEvents: readonly OperationsCenterEvent[];
  readonly limitations: readonly { readonly code: "commit-ancestry-unverified" | "worktree-dirty-files-unavailable" | "session-timestamps-unavailable"; readonly detail: string }[];
  readonly evidence: { readonly baseAuthority: CachedBaseAuthority; readonly activeSessionBaseDistances: readonly ActiveSessionBaseDistance[]; readonly terminalRecoveryActions: readonly TerminalRecoveryAction[]; readonly recoveryCandidates: GuardianRecoverResult["recoveryCandidates"]; readonly operationalScope: GuardianStatusResult["operationalScope"] };
  readonly raw: { readonly status: GuardianStatusResult; readonly recover: GuardianRecoverResult };
  readonly actions: readonly { readonly id: OperationsCenterActionId; readonly enabled: false }[];
};

function sessionId(session: GuardianSession): string | null {
  return session.session_id ?? session.sessionId ?? null;
}

function sessionPath(session: GuardianSession): string | null {
  return session.worktree_path ?? session.worktreePath ?? null;
}

function worktreeId(worktree: WorktreeEntry): string {
  const source = `${worktree.path}\u0000${worktree.branch ?? ""}\u0000${worktree.head ?? ""}`;
  return `worktree-${createHash("sha256").update(source).digest("hex")}`;
}

function ownerFor(worktree: WorktreeEntry, sessions: readonly GuardianSession[]): WorktreeOwner {
  const worktreeKey = canonicalPath(worktree.path);
  const matching = sessions.filter((session) => {
    const candidatePath = sessionPath(session);
    return candidatePath !== null && canonicalPath(candidatePath) === worktreeKey;
  });
  const session = matching.find((candidate) => candidate.status === "active") ?? matching[0];
  if (!session) return { state: "unowned", sessionId: null, status: null };
  return { state: "owned", lifecycle: session.status === "active" ? "active" : "terminal", sessionId: sessionId(session), status: session.status ?? null, path: worktree.path };
}

function distanceFor(worktree: WorktreeEntry, distances: readonly ActiveSessionBaseDistance[]): WorktreeBaseDistance {
  const worktreeKey = canonicalPath(worktree.path);
  const distance = distances.find((candidate) => canonicalPath(candidate.worktreePath) === worktreeKey);
  if (!distance) return { status: "unavailable", reason: "not-an-active-session-worktree" };
  switch (distance.status) {
    case "available":
      return distance;
    case "unavailable":
      return { status: "unavailable", reason: distance.reason };
  }
}

function matchesOwner(sessions: readonly GuardianSession[], owner: WorktreeOwner): boolean {
  if (owner.state === "unowned") return false;
  const ownerKey = canonicalPath(owner.path);
  return sessions.some((session) => {
    const candidatePath = sessionPath(session);
    return (owner.sessionId !== null && sessionId(session) === owner.sessionId)
      || (candidatePath !== null && canonicalPath(candidatePath) === ownerKey);
  });
}

function stateFor(primary: boolean, owner: WorktreeOwner, external: boolean, orphaned: boolean, poisoned: boolean): OperationsCenterWorktreeState {
  if (poisoned) return "poisoned";
  if (orphaned) return "orphaned";
  if (external) return "external";
  if (primary) return "primary";
  switch (owner.state) {
    case "owned":
      return owner.lifecycle;
    case "unowned":
      return "unmanaged";
  }
}

function toneFor(owner: WorktreeOwner, orphaned: boolean, poisoned: boolean): WorktreeTone {
  if (orphaned || poisoned) return "bad";
  if (owner.state === "unowned") return "neutral";
  return "good";
}

function eventsFor(sessions: readonly GuardianSession[], actions: readonly TerminalRecoveryAction[]): readonly OperationsCenterEvent[] {
  const sessionEvents = sessions.flatMap((session) => {
    const id = sessionId(session);
    if (!id) return [];
    return [
      ...(session.created_at ? [{ kind: "created" as const, sessionId: id, at: session.created_at, action: null }] : []),
      ...(session.updated_at ? [{ kind: "updated" as const, sessionId: id, at: session.updated_at, action: null }] : []),
      ...(session.superseded_at ? [{ kind: "superseded" as const, sessionId: id, at: session.superseded_at, action: null }] : []),
    ];
  });
  return [...sessionEvents, ...actions.map((action) => ({ kind: "terminal-recovery-action" as const, sessionId: action.sessionId, at: null, action }))];
}

function isExternalWorktreeFailure(worktree: WorktreeEntry, candidates: GuardianStatusResult["worktreesWithoutState"]): boolean {
  const worktreeKey = canonicalPath(worktree.path);
  return candidates.some((candidate) =>
    canonicalPath(candidate.path) === worktreeKey
    && (candidate.category === "external-worktree" || candidate.category === "external-temp-worktree")
    && candidate.severity === "fail",
  );
}

export function buildOperationsCenterModel(input: OperationsCenterInput): OperationsCenterModel {
  const worktrees = input.status.worktrees.map((worktree) => {
    const owner = ownerFor(worktree, input.status.sessions);
    const external = isExternalWorktreeFailure(worktree, input.status.worktreesWithoutState);
    const orphaned = matchesOwner(input.status.orphanedSessions, owner);
    const poisoned = matchesOwner(input.status.poisonedSessions, owner);
    const primary = canonicalPath(worktree.path) === canonicalPath(input.status.repoRoot);
    return {
      id: worktreeId(worktree),
      path: worktree.path,
      branch: worktree.branch ?? null,
      head: worktree.head ?? null,
      flags: { primary, linked: !primary, detached: worktree.detached === true, bare: worktree.bare === true },
      owner,
      state: stateFor(primary, owner, external, orphaned, poisoned),
      tone: external ? "bad" : toneFor(owner, orphaned, poisoned),
      risk: { orphaned, poisoned, external },
      baseDistance: distanceFor(worktree, input.status.activeSessionBaseDistances),
    };
  });
  const observedEvents = eventsFor(input.status.sessions, input.status.terminalRecoveryActions);
  const topology = buildTopologyDisplayModel({ worktrees, observedEvents });
  return {
    identity: { repoRoot: input.status.repoRoot, reportPath: input.reportPath, generatedAt: input.generatedAt },
    metrics: { worktreeCount: worktrees.length, activeSessionCount: input.status.activeSessions.length, terminalSessionCount: input.status.terminalSessions.length, riskCount: guardianRiskCount(input.status), dirtyFileCount: input.status.dirtyFiles.length, recoveryCandidateCount: input.recover.recoveryCandidates.reflog.length + input.recover.recoveryCandidates.unreachable.length },
    verdict: computeGuardianVerdict(input.status),
    worktrees,
    topology: { ...topology, nodes: worktrees.map((worktree) => ({ id: worktree.id, worktreeId: worktree.id })) },
    observedEvents,
    limitations: [
      { code: "commit-ancestry-unverified", detail: "No commit-parent or branch-point facts were supplied for cross-worktree topology edges." },
      { code: "worktree-dirty-files-unavailable", detail: "Dirty-file inventory is repository-wide and cannot be attributed to individual worktrees." },
      ...(observedEvents.length === 0 ? [{ code: "session-timestamps-unavailable" as const, detail: "No session timestamps or terminal-recovery actions were supplied." }] : []),
    ],
    evidence: { baseAuthority: input.status.baseAuthority, activeSessionBaseDistances: input.status.activeSessionBaseDistances, terminalRecoveryActions: input.status.terminalRecoveryActions, recoveryCandidates: input.recover.recoveryCandidates, operationalScope: input.status.operationalScope },
    raw: { status: input.status, recover: input.recover },
    actions: ACTION_IDS.map((id) => ({ id, enabled: false })),
  };
}
