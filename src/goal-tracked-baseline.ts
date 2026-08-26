import { resolveBaseRefReadOnly } from "./done-base-ref.ts";
import { runGit, tryGit } from "./git.ts";
import { getGuardianPaths, readState } from "./state.ts";
import { sessionIdFromInput, stateFromInput } from "./session/context.ts";
import type { NormalizedGuardianConfig } from "./normalized-config.ts";
import type { GuardianToolInput } from "./types.ts";

export type GoalTrackedBaseline = {
  readonly commit: string;
  readonly source: "session-start" | "base-merge" | "current-head";
};

export class GoalTrackedBaselineError extends Error {
  readonly code = "tracked_baseline_unavailable";
}

async function verifiedCommit(cwd: string, candidate: unknown): Promise<string | null> {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  const verified = await tryGit(cwd, ["cat-file", "-e", `${candidate}^{commit}`]);
  if (!verified.ok) throw new GoalTrackedBaselineError("recorded session-start commit is unavailable");
  return candidate;
}

export async function resolveGoalTrackedBaseline(input: {
  readonly request: GuardianToolInput;
  readonly repoRoot: string;
  readonly cwd: string;
  readonly config: NormalizedGuardianConfig;
}): Promise<GoalTrackedBaseline> {
  const sessionId = sessionIdFromInput(input.request);
  let recordedSession = false;
  if (sessionId) {
    const state = stateFromInput(input.request.state) ?? await readState(await getGuardianPaths(input.repoRoot), { repoRoot: input.repoRoot, config: input.config });
    const session = state.sessions[sessionId];
    recordedSession = session !== undefined;
    const startCommit = await verifiedCommit(input.cwd, session?.started_head_commit);
    if (startCommit) return { commit: startCommit, source: "session-start" };
  }
  try {
    const resolved = await resolveBaseRefReadOnly(input.repoRoot, input.config);
    const merged = await runGit(input.cwd, ["merge-base", "HEAD", resolved.authorityRef]);
    if (!merged.stdout) throw new GoalTrackedBaselineError("tracked-file baseline could not be resolved");
    return { commit: merged.stdout, source: "base-merge" };
  } catch (error) {
    if (recordedSession) throw error;
    const head = await runGit(input.cwd, ["rev-parse", "HEAD^{commit}"]);
    if (!head.stdout) throw new GoalTrackedBaselineError("tracked-file baseline could not be resolved");
    return { commit: head.stdout, source: "current-head" };
  }
}
