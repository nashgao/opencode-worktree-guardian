import path from "node:path";
import { observeBaseLineageReadOnly } from "./base-lineage.ts";
import { realPathOrResolved } from "./done-shared.ts";
import { tryGitReadOnly } from "./git.ts";
import type { GitReadTarget } from "./git.ts";
import { resolveBaseRefReadOnly } from "./done-base-ref.ts";
import type { BaseRefResolution } from "./done-base-ref.ts";
import type { GuardianConfig, GuardianSession, WorktreeEntry } from "./types.ts";

export type BaseDistanceRelation = "equal" | "ahead" | "behind" | "diverged";
export type BaseDistanceUnavailableReason = "base-authority-unavailable" | "base-ref-unavailable" | "head-unavailable" | "distance-unavailable";

export type CachedBaseAuthority =
  | {
    readonly status: "available";
    readonly baseRef: string;
    readonly baseAuthorityRef: string;
    readonly baseRefOid: string;
    readonly effectiveRemote: string;
    readonly source: "upstream" | "config";
  }
  | { readonly status: "unavailable"; readonly reason: "base-authority-unavailable" | "base-ref-unavailable" };

export type ActiveSessionBaseDistance =
  | {
    readonly status: "available";
    readonly sessionId: string;
    readonly worktreePath: string;
    readonly baseRef: string;
    readonly baseAuthorityRef: string;
    readonly baseRefOid: string;
    readonly head: string;
    readonly ahead: number;
    readonly behind: number;
    readonly relation: BaseDistanceRelation;
    readonly detached: boolean;
  }
  | {
    readonly status: "unavailable";
    readonly sessionId: string;
    readonly worktreePath: string;
    readonly reason: BaseDistanceUnavailableReason;
  };

type AvailableBaseAuthority = Extract<CachedBaseAuthority, { readonly status: "available" }>;

function readTarget(cwd: string): GitReadTarget {
  return { cwd, gitDir: null, workTree: null, configs: [] };
}

function sessionId(session: GuardianSession): string {
  return session.session_id ?? session.sessionId ?? "(unknown)";
}

function sessionWorktreePath(session: GuardianSession): string {
  return session.worktree_path ?? session.worktreePath ?? "";
}

function parsedDistance(value: string): { readonly ahead: number; readonly behind: number } | null {
  const [behindText, aheadText, ...extra] = value.trim().split(/\s+/);
  if (!behindText || !aheadText || extra.length > 0) return null;
  const behind = Number(behindText);
  const ahead = Number(aheadText);
  if (!Number.isSafeInteger(behind) || behind < 0 || !Number.isSafeInteger(ahead) || ahead < 0) return null;
  return { ahead, behind };
}

function lineageRelation(lineage: NonNullable<Awaited<ReturnType<typeof observeBaseLineageReadOnly>>>): BaseDistanceRelation {
  if (lineage.baseIsAncestorOfHead && lineage.headIsAncestorOfBase) return "equal";
  if (lineage.baseIsAncestorOfHead) return "ahead";
  if (lineage.headIsAncestorOfBase) return "behind";
  return "diverged";
}

async function resolveCachedBaseAuthority(repoRoot: string, config: GuardianConfig): Promise<CachedBaseAuthority> {
  let resolved: BaseRefResolution;
  try {
    resolved = await resolveBaseRefReadOnly(repoRoot, config);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { status: "unavailable", reason: "base-authority-unavailable" };
  }
  const localBase = await tryGitReadOnly(readTarget(repoRoot), ["rev-parse", "--verify", `${resolved.authorityRef}^{commit}`]);
  if (!localBase.ok) return { status: "unavailable", reason: "base-ref-unavailable" };
  return {
    status: "available",
    baseRef: resolved.baseRef,
    baseAuthorityRef: resolved.authorityRef,
    baseRefOid: localBase.stdout,
    effectiveRemote: resolved.remote,
    source: resolved.source,
  };
}

async function worktreesByCanonicalPath(worktrees: readonly WorktreeEntry[]): Promise<ReadonlyMap<string, WorktreeEntry>> {
  const entries: readonly (readonly [string, WorktreeEntry])[] = await Promise.all(worktrees.map(async (worktree): Promise<readonly [string, WorktreeEntry]> => [path.resolve(await realPathOrResolved(worktree.path)), worktree]));
  return new Map(entries);
}

function unavailable(session: GuardianSession, reason: BaseDistanceUnavailableReason): ActiveSessionBaseDistance {
  return { status: "unavailable", sessionId: sessionId(session), worktreePath: sessionWorktreePath(session), reason };
}

async function distanceForSession(session: GuardianSession, base: AvailableBaseAuthority, worktrees: ReadonlyMap<string, WorktreeEntry>): Promise<ActiveSessionBaseDistance> {
  const worktreePath = sessionWorktreePath(session);
  const worktree = worktreePath ? worktrees.get(path.resolve(await realPathOrResolved(worktreePath))) : undefined;
  if (!worktree?.head) return unavailable(session, "head-unavailable");
  const count = await tryGitReadOnly(readTarget(worktree.path), ["rev-list", "--left-right", "--count", `${base.baseRefOid}...${worktree.head}`]);
  const parsed = count.ok ? parsedDistance(count.stdout) : null;
  if (!parsed) return unavailable(session, "distance-unavailable");
  const lineage = await observeBaseLineageReadOnly({ target: readTarget(worktree.path), baseRefOid: base.baseRefOid, head: worktree.head });
  if (!lineage) return unavailable(session, "distance-unavailable");
  return {
    status: "available",
    sessionId: sessionId(session),
    worktreePath,
    baseRef: base.baseRef,
    baseAuthorityRef: base.baseAuthorityRef,
    baseRefOid: base.baseRefOid,
    head: worktree.head,
    ahead: parsed.ahead,
    behind: parsed.behind,
    relation: lineageRelation(lineage),
    detached: worktree.detached === true,
  };
}

export async function collectActiveSessionBaseDistances(repoRoot: string, config: GuardianConfig, sessions: readonly GuardianSession[], worktrees: readonly WorktreeEntry[]): Promise<{ readonly baseAuthority: CachedBaseAuthority; readonly activeSessionBaseDistances: readonly ActiveSessionBaseDistance[] }> {
  const baseAuthority = await resolveCachedBaseAuthority(repoRoot, config);
  if (baseAuthority.status === "unavailable") {
    return {
      baseAuthority,
      activeSessionBaseDistances: sessions.map((session) => unavailable(session, baseAuthority.reason)),
    };
  }
  const canonicalWorktrees = await worktreesByCanonicalPath(worktrees);
  return {
    baseAuthority,
    activeSessionBaseDistances: await Promise.all(sessions.map((session) => distanceForSession(session, baseAuthority, canonicalWorktrees))),
  };
}
