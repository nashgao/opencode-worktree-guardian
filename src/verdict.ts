import fs from "node:fs";
import path from "node:path";

// One synthesized "so what" line shared by every Guardian visualization surface
// (status text, HTML report, TUI HUD). It reads defensively from a guardianStatus()
// result so each surface can pass its raw result without a shared concrete type.

export type GuardianVerdictTone = "good" | "warn" | "bad";

export type GuardianVerdict = {
  readonly tone: GuardianVerdictTone;
  readonly headline: string;
  readonly nextAction: string | null;
};

type LooseRecord = Record<string, unknown>;

type VerdictSignal = {
  readonly tone: "warn" | "bad";
  readonly fragment: string;
  readonly nextAction: string;
};

function recordValue(value: unknown): LooseRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as LooseRecord) : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

function pluralEs(count: number): string {
  return count === 1 ? "" : "es";
}

function sessionBranch(session: LooseRecord): string {
  return textValue(session.branch, "(no branch)");
}

function activeDescriptor(activeSessions: readonly LooseRecord[]): string {
  const first = activeSessions[0];
  if (activeSessions.length === 1 && first) return `1 active session on ${sessionBranch(first)}`;
  if (activeSessions.length > 1) return `${activeSessions.length} active sessions`;
  return "No active Guardian sessions";
}

// realpath canonicalizes macOS /var <-> /private/var symlinks; fall back to
// path.resolve for paths that do not exist (e.g. unit-test fixtures).
export function canonicalPath(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

// The primary repo worktree is always listed without Guardian state and annotated
// severity:"fail" by guardianStatus(); it is not a real risk, so exclude it the same
// way the HUD's buildRisks does before counting external-worktree failures.
function externalWorktreeFailCount(status: LooseRecord): number {
  const repoRoot = textValue(status.repoRoot);
  const canonicalRepoRoot = repoRoot ? canonicalPath(repoRoot) : "";
  return arrayValue(status.worktreesWithoutState)
    .map(recordValue)
    .filter((worktree) => textValue(worktree.severity) === "fail")
    .filter((worktree) => {
      const worktreePath = textValue(worktree.path);
      if (!worktreePath || !canonicalRepoRoot) return true;
      return canonicalPath(worktreePath) !== canonicalRepoRoot;
    }).length;
}

function collectSignals(status: LooseRecord): VerdictSignal[] {
  const signals: VerdictSignal[] = [];

  const orphaned = arrayValue(status.orphanedSessions).length;
  const poisoned = arrayValue(status.poisonedSessions).length;
  const externalFail = externalWorktreeFailCount(status);
  const hygieneSummary = recordValue(recordValue(status.hygiene).summary);
  const hygieneFail = numberValue(recordValue(hygieneSummary.bySeverity).fail);
  const hygieneFindings = numberValue(hygieneSummary.findingCount);

  const dirty = arrayValue(status.dirtyFiles).length;
  const stashes = arrayValue(status.stashes).length;
  const strandedBranches = arrayValue(status.stateBranchesWithoutWorktrees).length;

  if (orphaned > 0) {
    signals.push({ tone: "bad", fragment: `${orphaned} orphaned session${plural(orphaned)} (worktree missing)`, nextAction: "guardian_recover, then guardian_delete_worktree" });
  }
  if (poisoned > 0) {
    signals.push({ tone: "bad", fragment: `${poisoned} poisoned session${plural(poisoned)} on the primary or a protected branch`, nextAction: "guardian_start createWorktree=true to repair" });
  }
  if (externalFail > 0) {
    signals.push({ tone: "bad", fragment: `${externalFail} worktree${plural(externalFail)} outside Guardian ownership`, nextAction: "guardian_status for paths, then guardian_delete_worktree if intended" });
  }
  if (hygieneFail > 0) {
    signals.push({ tone: "bad", fragment: `${hygieneFail} fail-severity hygiene finding${plural(hygieneFail)}`, nextAction: "guardian_hygiene to review" });
  }

  if (dirty > 0) {
    signals.push({ tone: "warn", fragment: `${dirty} dirty file${plural(dirty)} uncommitted`, nextAction: "commit, or run guardian_done before finishing" });
  }
  if (stashes > 0) {
    signals.push({ tone: "warn", fragment: `${stashes} stash${pluralEs(stashes)} present`, nextAction: "git stash list to review (Guardian never mutates stashes)" });
  }
  if (strandedBranches > 0) {
    signals.push({ tone: "warn", fragment: `${strandedBranches} session branch${pluralEs(strandedBranches)} without a worktree`, nextAction: "guardian_recover to inspect" });
  }
  if (hygieneFail === 0 && hygieneFindings > 0) {
    signals.push({ tone: "warn", fragment: `${hygieneFindings} workspace hygiene finding${plural(hygieneFindings)}`, nextAction: "guardian_hygiene to review" });
  }

  return signals;
}

export function computeGuardianVerdict(rawStatus: unknown): GuardianVerdict {
  const status = recordValue(rawStatus);
  if (status.ok === false) {
    return { tone: "bad", headline: textValue(status.reason, "Guardian status reported a failure"), nextAction: "guardian_status to re-check" };
  }

  const activeSessions = arrayValue(status.activeSessions).map(recordValue);
  const descriptor = activeDescriptor(activeSessions);
  const signals = collectSignals(status);

  const failSignals = signals.filter((signal) => signal.tone === "bad");
  const dominant = failSignals[0] ?? signals[0];
  if (!dominant) {
    return { tone: "good", headline: `${descriptor} — clean, no risks detected.`, nextAction: null };
  }

  const remaining = signals.length - 1;
  const suffix = remaining > 0 ? ` (+${remaining} more)` : "";
  return {
    tone: failSignals.length > 0 ? "bad" : "warn",
    headline: `${descriptor} — ${dominant.fragment}${suffix}.`,
    nextAction: dominant.nextAction,
  };
}

export function guardianRiskCount(rawStatus: unknown): number {
  return collectSignals(recordValue(rawStatus)).length;
}
