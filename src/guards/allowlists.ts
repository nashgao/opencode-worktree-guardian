import type { AllowDecision, GuardOptions } from "../types.ts";
import type { CommandSegment } from "./guard-types.ts";
import { effectiveGitPolicyReason } from "./effective-git-policy.ts";
import { hasAliasCapableRuntimeConfig, hasDynamicShellArgument, isForcePushToken, parseGitInvocation, pushRefspecs } from "./git-invocation.ts";
import { stringOption } from "./options.ts";
import { cdTarget, READ_ONLY_SHELL_COMMANDS, SHELL_COMMANDS, stripCommandWrappers } from "./shell-prefix.ts";
import { commandSegments, commandSegmentsWithSeparators, SEGMENT_BREAKS, tokenizeCommand } from "./shell-parser.ts";
import { opaqueExecutionReason } from "./opaque-execution-policy.ts";
import { protectedBranchBypass } from "./protected-branch-policy.ts";

export const STASH_READ_ONLY = new Set<string>(["list", "show"]);
const READ_ONLY_GIT_COMMANDS = new Set(["status", "diff", "log", "show", "rev-parse", "branch", "worktree", "stash", "remote", "ls-files"]);
const NORMAL_AGENT_GIT_COMMANDS = new Set(["add", "commit", "fetch", "push"]);

export function hasUnsafeDiffOption(tokens: readonly string[]): boolean {
  return tokens.some((token) => token === "--output" || token.startsWith("--output=") || token === "--ext-diff" || token === "--textconv");
}

export { hasDynamicShellArgument } from "./git-invocation.ts";

export function isReadOnlyStashInvocation(rest: readonly string[]): boolean {
  const action = rest[0];
  const args = rest.slice(1);
  return typeof action === "string" && STASH_READ_ONLY.has(action) && !hasUnsafeDiffOption(args) && !hasDynamicShellArgument(args);
}

function hasUnsafeReadOnlySyntax(command: string, tokens: readonly string[]): boolean {
  return command.includes("`") || command.includes("$(") || /[<>]/.test(command) || tokens.some((token) => SEGMENT_BREAKS.has(token));
}

function isAllowedReadOnlyGit(segment: CommandSegment): boolean {
  const parsed = parseGitInvocation(segment);
  if (!parsed?.subcommand || !READ_ONLY_GIT_COMMANDS.has(parsed.subcommand)) return false;
  if (parsed.unsafeExecutableSearchPath) return false;
  const { subcommand, rest } = parsed;
  if (parsed.configs.length > 0) return false;

  if (subcommand === "status") {
    return rest.every((token) => token.startsWith("-") || token === "--");
  }
  if (subcommand === "branch") {
    return rest.every((token) => token === "--list" || token === "--show-current" || token === "-a" || token === "-r" || token.startsWith("--format="));
  }
  if (subcommand === "worktree") {
    return rest[0] === "list" && rest.slice(1).every((token) => token.startsWith("-"));
  }
  if (subcommand === "stash") {
    return isReadOnlyStashInvocation(rest);
  }
  if (subcommand === "remote") {
    return rest.length === 0 || rest.every((token) => token === "-v" || token === "--verbose");
  }
  if (subcommand === "diff" || subcommand === "log" || subcommand === "show") {
    return !hasUnsafeDiffOption(rest);
  }
  return true;
}

export function classifyReadOnlyInspectionCommand(command: unknown): AllowDecision {
  if (typeof command !== "string" || command.trim() === "") return { allowed: false, reason: "empty command" };
  const tokens = tokenizeCommand(command);
  if (hasUnsafeReadOnlySyntax(command, tokens)) return { allowed: false, reason: "compound or redirected shell syntax is not read-only allowlisted" };
  const segment = commandSegments(tokens)[0] ?? [];
  const stripped = stripCommandWrappers(segment);
  if (stripped.length === 1 && READ_ONLY_SHELL_COMMANDS.has(stripped[0] ?? "")) return { allowed: true, reason: null };
  if (SHELL_COMMANDS.has(stripped[0] ?? "")) return { allowed: false, reason: "shell payload execution is not read-only allowlisted" };
  if (isAllowedReadOnlyGit(segment)) return { allowed: true, reason: null };
  return { allowed: false, reason: "command is not read-only allowlisted" };
}

function isAllowedNormalAgentGit(segment: CommandSegment, options: GuardOptions = {}): boolean {
  if (isAllowedReadOnlyGit(segment)) return true;
  const parsed = parseGitInvocation(segment, options);
  if (!parsed?.subcommand || !NORMAL_AGENT_GIT_COMMANDS.has(parsed.subcommand)) return false;
  if (parsed.unsafeExecutableSearchPath) return false;
  if (hasAliasCapableRuntimeConfig(parsed.configs)) return false;
  if (effectiveGitPolicyReason(parsed, options)) return false;
  if (protectedBranchBypass(parsed.normalized, parsed.subcommand, parsed.rest, options, parsed.gitCwd, parsed.workTree, parsed.configs)) return false;

  const { subcommand, rest } = parsed;
  if (subcommand === "commit") return !rest.some((token) => token === "--amend" || token.startsWith("--amend="));
  if (subcommand === "push") {
    if (rest.some(isForcePushToken)) return false;
    if (rest.some((token) => token === "--delete" || token === "-d" || token === "--mirror")) return false;
    return !pushRefspecs(rest).some((refspec) => refspec.startsWith("+") || refspec.startsWith(":"));
  }
  if (subcommand === "fetch") return true;
  return true;
}

export function classifyNormalAgentGitCommand(command: unknown, options: GuardOptions = {}): AllowDecision {
  if (typeof command !== "string" || command.trim() === "") return { allowed: false, reason: "empty command" };
  if (options.inspection?.state === "failed") return { allowed: false, reason: `Git inspection failed: ${options.inspection.reason}` };
  const opaqueReason = opaqueExecutionReason(command);
  if (opaqueReason) return { allowed: false, reason: opaqueReason };
  const tokens = tokenizeCommand(command);
  if (command.includes("`") || command.includes("$(") || /[<>|()]/.test(command)) return { allowed: false, reason: "compound shell syntax is not normal git passthrough" };
  let effectiveCwd = stringOption(options, "cwd") ?? process.cwd();
  for (const { segment, nextSeparator } of commandSegmentsWithSeparators(tokens)) {
    const scopedOptions = { ...options, cwd: effectiveCwd };
    if (!isAllowedNormalAgentGit(segment, scopedOptions)) return { allowed: false, reason: "command is not normal non-destructive git" };
    if (nextSeparator === "||") return { allowed: false, reason: "fallback shell chains are not normal git passthrough" };
    if (nextSeparator === ";" || nextSeparator === "&&") effectiveCwd = cdTarget(segment, effectiveCwd) ?? effectiveCwd;
  }
  return { allowed: true, reason: null };
}
