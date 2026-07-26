import { classifyGuardCommand, classifyNormalAgentGitCommand } from "../guards.ts";
import { pushRefspecs } from "../guards/transport-arguments.ts";
import type { GuardDecision, GuardOptions, GuardianConfig } from "../types.ts";
import { discoverGitInvocations, gitInspectionTargetForInvocation } from "./effective-git-config.ts";
import { collectGuardContext, guardOptionsFromContext, resolveGuardRepository, resolveGuardRepositoryForTarget } from "./guard-context.ts";

type ScopedEvaluation = {
  readonly config: GuardianConfig | null;
  readonly guard: GuardDecision;
  readonly normalAgentGit: ReturnType<typeof classifyNormalAgentGitCommand>;
};

export type GuardCommandEvaluation = {
  readonly config: GuardianConfig | null;
  readonly guard: GuardDecision;
  readonly enforcedGuard: GuardDecision;
  readonly normalAgentGit: ReturnType<typeof classifyNormalAgentGitCommand>;
  readonly strictMode: boolean;
  readonly auditOnly: boolean;
};

function fallbackOptions(cwd: string, repoRoot: string | undefined, knownWorktreePaths: readonly string[], reason?: string): GuardOptions {
  return {
    cwd,
    ...(repoRoot ? { repoRoot } : {}),
    knownWorktreePaths,
    inspection: reason ? { state: "failed", stage: "git-target", reason } : { state: "not-requested" },
  };
}

function pushSources(rest: readonly string[]): readonly string[] {
  return pushRefspecs(rest).flatMap((refspec) => {
    const normalized = refspec.startsWith("+") ? refspec.slice(1) : refspec;
    const separator = normalized.indexOf(":");
    const source = separator >= 0 ? normalized.slice(0, separator) : "";
    return source ? [source] : [];
  });
}

type GuardEvaluationInput = {
  readonly command: string;
  readonly cwd: string;
  readonly currentWorktree?: string;
  readonly fallbackRepoRoot?: string;
  readonly fallbackKnownWorktreePaths?: readonly string[];
};

function fallbackPaths(input: GuardEvaluationInput): readonly string[] {
  return input.fallbackKnownWorktreePaths ?? (input.currentWorktree ? [input.currentWorktree] : []);
}

async function fallbackEvaluation(input: GuardEvaluationInput): Promise<ScopedEvaluation> {
  const repository = await resolveGuardRepository(input.cwd);
  if (repository.state !== "repository") {
    const options = fallbackOptions(input.cwd, input.fallbackRepoRoot, fallbackPaths(input), repository.state === "failed" ? repository.reason : undefined);
    return { config: null, guard: classifyGuardCommand(input.command, options), normalAgentGit: classifyNormalAgentGitCommand(input.command, options) };
  }
  const context = await collectGuardContext({ repoRoot: repository.repoRoot, effectiveCwd: input.cwd, command: input.command, currentWorktree: input.currentWorktree });
  const options = guardOptionsFromContext(context, input.cwd, repository.repoRoot);
  return { config: context.guardConfig, guard: classifyGuardCommand(input.command, options), normalAgentGit: classifyNormalAgentGitCommand(input.command, options) };
}

async function invocationEvaluation(input: { readonly command: string; readonly cwd: string; readonly currentWorktree?: string; readonly discovered: ReturnType<typeof discoverGitInvocations>[number] }): Promise<ScopedEvaluation> {
  const target = gitInspectionTargetForInvocation(input.discovered);
  const repository = await resolveGuardRepositoryForTarget(target);
  if (repository.state !== "repository") {
    const options = fallbackOptions(input.discovered.cwd, undefined, [], repository.state === "failed" ? repository.reason : undefined);
    const scope = input.discovered.segment.join(" ");
    return { config: null, guard: classifyGuardCommand(scope, options), normalAgentGit: classifyNormalAgentGitCommand(scope, options) };
  }
  const context = await collectGuardContext({
    repoRoot: repository.repoRoot,
    effectiveCwd: input.discovered.cwd,
    command: input.discovered.segment.join(" "),
    currentWorktree: input.currentWorktree,
    target,
    explicitPushSources: input.discovered.invocation.subcommand === "push" ? pushSources(input.discovered.invocation.rest) : [],
  });
  const options = guardOptionsFromContext(context, input.discovered.cwd, repository.repoRoot);
  const scope = input.discovered.segment.join(" ");
  return { config: context.guardConfig, guard: classifyGuardCommand(scope, options), normalAgentGit: classifyNormalAgentGitCommand(scope, options) };
}

function allowedDecision(command: string): GuardDecision {
  return { blocked: false, reason: null, command, tokens: [] };
}

export async function evaluateGuardCommand(input: GuardEvaluationInput): Promise<GuardCommandEvaluation> {
  const discovered = discoverGitInvocations(input.command, input.cwd);
  const fallback = await fallbackEvaluation(input);
  const scoped = [fallback, ...await Promise.all(discovered.map((entry) => invocationEvaluation({ ...input, discovered: entry })))]
  const strictFinding = scoped.find((entry) => entry.config?.commandInterceptionMode === "strict" && entry.guard.blocked);
  const finding = strictFinding ?? scoped.find((entry) => entry.guard.blocked);
  const primary = fallback;
  const guard = finding?.guard ?? allowedDecision(input.command);
  const enforcedGuard = strictFinding?.guard ?? allowedDecision(input.command);
  return {
    config: primary?.config ?? null,
    guard,
    enforcedGuard,
    normalAgentGit: discovered.length === 0 ? fallback.normalAgentGit : discovered.length === 1 ? scoped[1]?.normalAgentGit ?? fallback.normalAgentGit : { allowed: false, reason: "compound Git command is not normal passthrough" },
    strictMode: scoped.some((entry) => entry.config?.commandInterceptionMode === "strict"),
    auditOnly: guard.blocked && !enforcedGuard.blocked,
  };
}
