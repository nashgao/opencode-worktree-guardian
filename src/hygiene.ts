import { runGuardianHygieneMode } from "./hygiene-apply.ts";
import { loadConfig, normalizeConfig } from "./config.ts";
import { getRepoRoot } from "./git.ts";
import { GoalTrackedBaselineError, resolveGoalTrackedBaseline } from "./goal-tracked-baseline.ts";
import { scanWorkspaceHygiene } from "./hygiene-scan.ts";
import { isRecordLike } from "./types.ts";

export type { HygieneCategory, HygieneSeverity } from "./hygiene-scan.ts";
export { scanWorkspaceHygiene } from "./hygiene-scan.ts";

async function resolveHygieneTrackedBaseline(input: {
  readonly request: Record<string, unknown>;
  readonly repoRoot: string;
  readonly cwd: string;
  readonly config: ReturnType<typeof normalizeConfig>;
}) {
  try {
    return await resolveGoalTrackedBaseline(input);
  } catch (error) {
    if (error instanceof GoalTrackedBaselineError) throw error;
    return null;
  }
}

export async function guardianHygiene(input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const config = isRecordLike(input.config) ? normalizeConfig(input.config) : (await loadConfig(repoRoot)).config;
  const trackedBaseline = typeof input.trackedBaselineCommit === "string"
    ? { commit: input.trackedBaselineCommit, source: typeof input.trackedBaselineSource === "string" ? input.trackedBaselineSource : "provided" }
    : await resolveHygieneTrackedBaseline({ request: input, repoRoot, cwd, config });
  const prepared = { ...input, repoRoot, cwd, config, ...(trackedBaseline ? { trackedBaselineCommit: trackedBaseline.commit, trackedBaselineSource: trackedBaseline.source } : {}) };
  if (input.mode != null) return runGuardianHygieneMode(prepared);
  return scanWorkspaceHygiene(prepared);
}
