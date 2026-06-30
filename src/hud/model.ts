import path from "node:path";
import type { GitBranchEntry, GitRefEntry, GitStashEntry } from "../git.ts";
import type { GuardianSession, WorktreeEntry } from "../types.ts";
import { computeGuardianVerdict, type GuardianVerdict } from "../verdict.ts";

export type HudTone = "good" | "warn" | "bad" | "neutral";

export type HudMetric = {
  readonly label: string;
  readonly value: number;
  readonly tone: HudTone;
};

export type HudWorktreeSession = {
  readonly sessionId: string;
  readonly status: string;
  readonly safetyRefCount: number;
};

export type HudWorktree = {
  readonly path: string;
  readonly relPath: string;
  readonly branch: string;
  readonly head: string;
  readonly isPrimary: boolean;
  readonly markers: readonly string[];
  readonly flags: readonly string[];
  readonly session: HudWorktreeSession | null;
  readonly tone: HudTone;
};

export type HudRisk = {
  readonly severity: "fail" | "warn";
  readonly label: string;
  readonly detail: string;
};

export type HudLifecycleBucket = {
  readonly status: string;
  readonly count: number;
};

export type HudBranchWithoutWorktree = {
  readonly name: string;
  readonly head: string;
};

export type HudModel = {
  readonly repoRoot: string;
  readonly generatedAt: string;
  readonly metrics: readonly HudMetric[];
  readonly worktrees: readonly HudWorktree[];
  readonly branchesWithoutWorktree: readonly HudBranchWithoutWorktree[];
  readonly lifecycle: readonly HudLifecycleBucket[];
  readonly risks: readonly HudRisk[];
  readonly safetyRefTotal: number;
  readonly verdict: GuardianVerdict;
};

type AnnotatedWorktree = WorktreeEntry & {
  readonly category?: string;
  readonly severity?: string;
  readonly reason?: string;
};

// Structural subset of guardianStatus()/guardianRecover() output that the HUD
// consumes. Keeping it structural lets `buildHudModel(await guardianStatus(...))`
// typecheck without importing recover.ts's internal result type, and lets tests
// build fixtures directly.
export type HudStatusInput = {
  readonly repoRoot: string;
  readonly worktrees: readonly WorktreeEntry[];
  readonly sessions: readonly GuardianSession[];
  readonly activeSessions: readonly GuardianSession[];
  readonly terminalSessions: readonly GuardianSession[];
  readonly orphanedSessions: readonly GuardianSession[];
  readonly poisonedSessions?: readonly GuardianSession[];
  readonly stateBranchesWithoutWorktrees?: readonly string[];
  readonly worktreesWithoutState: readonly AnnotatedWorktree[];
  readonly branchesWithoutWorktrees: readonly GitBranchEntry[];
  readonly safetyRefs: readonly GitRefEntry[];
  readonly stashes: readonly GitStashEntry[];
  readonly dirtyFiles: readonly string[];
  readonly hygiene?: {
    readonly summary?: {
      readonly findingCount?: number;
      readonly bySeverity?: { readonly fail?: number; readonly warn?: number };
    };
  };
};

const SHORT_COMMIT_LENGTH = 12;

function sessionId(session: GuardianSession): string {
  return session.session_id ?? session.sessionId ?? "";
}

function sessionWorktreePath(session: GuardianSession): string | undefined {
  return session.worktree_path ?? session.worktreePath;
}

function shortCommit(commit: string | undefined): string {
  return commit ? commit.slice(0, SHORT_COMMIT_LENGTH) : "-";
}

function relativePath(repoRoot: string, target: string): string {
  const relative = path.relative(repoRoot, target);
  if (relative === "") return path.basename(target) || target;
  return relative;
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return path.resolve(left) === path.resolve(right);
}

// Safety refs are named refs/opencode-guardian/<sessionId>/<branch>/<timestamp>,
// so the owning session id appears as a substring of the ref name.
function countSafetyRefsForSession(safetyRefs: readonly GitRefEntry[], id: string): number {
  if (!id) return 0;
  return safetyRefs.filter((ref) => ref.name.includes(id)).length;
}

function worktreeMarkers(worktree: WorktreeEntry): string[] {
  const markers: string[] = [];
  if (worktree.detached === true) markers.push("detached");
  if (worktree.bare === true) markers.push("bare");
  return markers;
}

function buildWorktree(
  worktree: WorktreeEntry,
  input: HudStatusInput,
  withoutStateByPath: ReadonlyMap<string, AnnotatedWorktree>,
): HudWorktree {
  const isPrimary = samePath(worktree.path, input.repoRoot);
  const owner = input.activeSessions.find((session) => samePath(sessionWorktreePath(session), worktree.path)) ?? null;
  // The primary repo worktree legitimately lacks Guardian state; never treat it
  // as an external/no-session risk even though guardianStatus lists it.
  const annotated = isPrimary ? undefined : withoutStateByPath.get(path.resolve(worktree.path));

  const flags: string[] = [];
  if (annotated?.category) flags.push(annotated.category);
  else if (!owner && !isPrimary) flags.push("no-session");

  const session: HudWorktreeSession | null = owner
    ? {
        sessionId: sessionId(owner),
        status: owner.status ?? "active",
        safetyRefCount: countSafetyRefsForSession(input.safetyRefs, sessionId(owner)),
      }
    : null;

  const tone: HudTone = annotated?.severity === "fail"
    ? "bad"
    : isPrimary
      ? "neutral"
      : owner
        ? "good"
        : "warn";

  return {
    path: worktree.path,
    relPath: relativePath(input.repoRoot, worktree.path),
    branch: worktree.branch ?? "(detached)",
    head: shortCommit(worktree.head),
    isPrimary,
    markers: worktreeMarkers(worktree),
    flags,
    session,
    tone,
  };
}

function buildMetrics(input: HudStatusInput): HudMetric[] {
  const hygieneFindings = input.hygiene?.summary?.findingCount ?? 0;
  const hygieneFail = input.hygiene?.summary?.bySeverity?.fail ?? 0;
  return [
    { label: "Worktrees", value: input.worktrees.length, tone: "neutral" },
    { label: "Active", value: input.activeSessions.length, tone: input.activeSessions.length > 0 ? "good" : "neutral" },
    { label: "Terminal", value: input.terminalSessions.length, tone: "neutral" },
    { label: "Orphaned", value: input.orphanedSessions.length, tone: input.orphanedSessions.length > 0 ? "bad" : "good" },
    { label: "Safety Refs", value: input.safetyRefs.length, tone: "neutral" },
    { label: "Dirty", value: input.dirtyFiles.length, tone: input.dirtyFiles.length > 0 ? "bad" : "good" },
    { label: "Stashes", value: input.stashes.length, tone: input.stashes.length > 0 ? "warn" : "good" },
    { label: "Hygiene", value: hygieneFindings, tone: hygieneFail > 0 ? "bad" : hygieneFindings > 0 ? "warn" : "good" },
  ];
}

function buildLifecycle(sessions: readonly GuardianSession[]): HudLifecycleBucket[] {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const status = session.status ?? "unknown";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((left, right) => right.count - left.count || left.status.localeCompare(right.status));
}

function buildRisks(input: HudStatusInput): HudRisk[] {
  const risks: HudRisk[] = [];
  for (const session of input.orphanedSessions) {
    risks.push({ severity: "fail", label: "orphaned session", detail: `${sessionId(session)} (${session.branch ?? "no branch"})` });
  }
  for (const session of input.poisonedSessions ?? []) {
    risks.push({ severity: "fail", label: "poisoned session", detail: `${sessionId(session)} (${session.branch ?? "no branch"})` });
  }
  for (const worktree of input.worktreesWithoutState) {
    if (samePath(worktree.path, input.repoRoot)) continue;
    if (worktree.severity === "fail") {
      risks.push({ severity: "fail", label: worktree.category ?? "external worktree", detail: worktree.path });
    }
  }
  if (input.dirtyFiles.length > 0) {
    risks.push({ severity: "warn", label: "dirty files", detail: `${input.dirtyFiles.length} uncommitted` });
  }
  if (input.stashes.length > 0) {
    risks.push({ severity: "warn", label: "stashes", detail: `${input.stashes.length} stashed` });
  }
  for (const branch of input.stateBranchesWithoutWorktrees ?? []) {
    risks.push({ severity: "warn", label: "branch without worktree", detail: branch });
  }
  const hygieneFindings = input.hygiene?.summary?.findingCount ?? 0;
  const hygieneFail = input.hygiene?.summary?.bySeverity?.fail ?? 0;
  if (hygieneFail > 0) {
    risks.push({ severity: "fail", label: "hygiene failures", detail: `${hygieneFail} fail-severity findings` });
  } else if (hygieneFindings > 0) {
    risks.push({ severity: "warn", label: "hygiene findings", detail: `${hygieneFindings} finding${hygieneFindings === 1 ? "" : "s"}` });
  }
  return risks;
}

export function buildHudModel(input: HudStatusInput, generatedAt: string = new Date().toISOString()): HudModel {
  const withoutStateByPath = new Map<string, AnnotatedWorktree>();
  for (const worktree of input.worktreesWithoutState) {
    withoutStateByPath.set(path.resolve(worktree.path), worktree);
  }

  const worktrees = [...input.worktrees]
    .map((worktree) => buildWorktree(worktree, input, withoutStateByPath))
    .sort((left, right) => (left.isPrimary === right.isPrimary ? left.relPath.localeCompare(right.relPath) : left.isPrimary ? -1 : 1));

  return {
    repoRoot: input.repoRoot,
    generatedAt,
    metrics: buildMetrics(input),
    worktrees,
    branchesWithoutWorktree: input.branchesWithoutWorktrees.map((branch) => ({ name: branch.name, head: shortCommit(branch.commit) })),
    lifecycle: buildLifecycle(input.sessions),
    risks: buildRisks(input),
    safetyRefTotal: input.safetyRefs.length,
    verdict: computeGuardianVerdict(input),
  };
}
