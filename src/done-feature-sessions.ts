import fs from "node:fs/promises";
import path from "node:path";
import { expandWorktreeRoot } from "./config.ts";
import { isActiveSession } from "./lifecycle.ts";
import { isInside, realPathOrResolved, samePath } from "./done-shared.ts";
import { isRecordLike } from "./types.ts";
import type { GuardianConfig, GuardianSession } from "./types.ts";

export type FeatureSession = {
  readonly session_id: string;
  readonly branch: string | null;
  readonly worktree_path: string;
  readonly head: string | null;
};

type FeatureSessionState = { readonly sessions?: Record<string, GuardianSession> };

function worktreeExists(target: string) {
  return fs.access(target).then(() => true, () => false);
}

// Enumerates every active Guardian feature session: status active, recorded inside the
// configured Guardian worktree root, not the primary repo, and present on disk. This is the
// shared inventory primitive for both single-lane selection (done.ts) and batch finish (done-all.ts).
export async function activeFeatureSessions(state: FeatureSessionState, repoRoot: string, config: GuardianConfig): Promise<FeatureSession[]> {
  const guardianRoot = await realPathOrResolved(path.resolve(repoRoot, expandWorktreeRoot(String(config.worktreeRoot), repoRoot)));
  const primaryRoot = await realPathOrResolved(repoRoot);
  const sessionRecords: Record<string, GuardianSession> = state.sessions ?? {};
  const sessions: FeatureSession[] = [];
  for (const [sessionId, session] of Object.entries(sessionRecords)) {
    if (!isRecordLike(session) || !isActiveSession(session)) continue;
    const worktreePath = session.worktree_path;
    if (typeof worktreePath !== "string" || worktreePath.length === 0) continue;
    const canonicalWorktreePath = await realPathOrResolved(worktreePath);
    if (samePath(canonicalWorktreePath, primaryRoot) || !isInside(canonicalWorktreePath, guardianRoot)) continue;
    if (!(await worktreeExists(canonicalWorktreePath))) continue;
    sessions.push({
      session_id: sessionId,
      branch: typeof session.branch === "string" ? session.branch : null,
      worktree_path: canonicalWorktreePath,
      head: typeof session.head_commit === "string" ? session.head_commit : null,
    });
  }
  return sessions;
}

export function featureSessionCommands(sessions: readonly FeatureSession[]): string[] {
  return sessions
    .filter((session): session is FeatureSession & { branch: string } => typeof session.branch === "string" && session.branch.length > 0)
    .map((session) => `guardian_done branch=${session.branch}`);
}
