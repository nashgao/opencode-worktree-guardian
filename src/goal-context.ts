import path from "node:path";
import { loadConfig, normalizeConfig } from "./config.ts";
import { getRepoRoot } from "./git.ts";
import { normalizeGoalIntentionalPaths, validateGoalIntentionalPaths } from "./goal-intentional-paths.ts";
import type { NormalizedGuardianConfig } from "./normalized-config.ts";
import { resolveSessionWorktree } from "./session/worktree-binding.ts";
import type { GuardianToolInput } from "./types.ts";
import { isRecordLike } from "./types.ts";

export type GoalContext = {
  readonly repoRoot: string;
  readonly cwd: string;
  readonly config: NormalizedGuardianConfig;
  readonly hygieneConfig: NormalizedGuardianConfig;
  readonly intentionalPaths: readonly string[];
};

export type GoalContextResult =
  | { readonly ok: true; readonly context: GoalContext }
  | { readonly ok: false; readonly repoRoot: string; readonly cwd: string; readonly reason: string };

async function selectedSessionWorktree(input: GuardianToolInput, context: Omit<GoalContext, "cwd" | "hygieneConfig"> & { readonly cwd: string }): Promise<string | null> {
  const first = await resolveSessionWorktree({ ...input, repoRoot: context.repoRoot, cwd: context.cwd, actualWorktree: context.cwd, config: context.config, validateBinding: true });
  if (first.sessionId == null) return context.cwd;
  if (first.terminal === true) return null;
  if (typeof first.expectedWorktree !== "string") return null;
  const candidate = path.resolve(first.expectedWorktree);
  const actualWorktree = await getRepoRoot(candidate);
  const validated = await resolveSessionWorktree({ ...input, repoRoot: context.repoRoot, cwd: candidate, actualWorktree, config: context.config, validateBinding: true });
  return validated.ok === true && typeof validated.expectedWorktree === "string" ? path.resolve(validated.expectedWorktree) : null;
}

export async function resolveGoalContext(input: GuardianToolInput): Promise<GoalContextResult> {
  const cwdInput = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const requestedCwd = path.resolve(cwdInput);
  const repoRoot = path.resolve(typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(requestedCwd));
  try {
    const config = isRecordLike(input.config) ? normalizeConfig(input.config) : (await loadConfig(repoRoot)).config;
    const intentionalPaths = normalizeGoalIntentionalPaths(input.intentionalPaths);
    const cwd = await selectedSessionWorktree(input, { repoRoot, cwd: requestedCwd, config, intentionalPaths });
    if (!cwd) return { ok: false, repoRoot, cwd: requestedCwd, reason: "explicit Guardian session worktree binding is missing, terminal, or invalid" };
    await validateGoalIntentionalPaths(cwd, intentionalPaths);
    const hygieneConfig = normalizeConfig({ ...config, protectedPaths: [...config.protectedPaths, ...intentionalPaths] });
    return { ok: true, context: { repoRoot, cwd, config, hygieneConfig, intentionalPaths } };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { ok: false, repoRoot, cwd: requestedCwd, reason: error.message };
  }
}
