import type { GuardCommandPayload, GuardDecision, GuardOptions } from "../types.ts";
import { isRecordLike } from "../types.ts";
import { classifySegment } from "./destructive-classifier.ts";
import { opaqueExecutionReason } from "./opaque-execution-policy.ts";
import type { GuardBlockDecision } from "./guard-types.ts";
import { stringOption } from "./options.ts";
import { cdTarget, peelCommandPrefix } from "./shell-prefix.ts";
import { isSameOrInside } from "./path-policy.ts";
import { commandSegmentsWithSeparators, findBacktickPayloads, tokenizeCommand } from "./shell-parser.ts";

const COMMAND_SUBSTITUTION = String.raw`(?:\$\([^)]*\)|\`[^\`]*\`)`;
const SUPPORTED_PREFIX = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*|command|env|sudo|--?[A-Za-z0-9][^\s]*)`;
const SYNTHESIZED_EXECUTABLE = new RegExp(String.raw`(?:^|[;|&()]\s*)(?:${SUPPORTED_PREFIX}\s+)*(?:['"]?${COMMAND_SUBSTITUTION}['"]?)\s+`);

function guardCwdAfter(segment: readonly string[], cwd: string, options: GuardOptions): string {
  const candidate = cdTarget(segment, cwd);
  if (!candidate) return cwd;
  const roots = [cwd, ...(options.protectedBranchWorktreePaths ?? []), ...(options.knownWorktreePaths ?? [])];
  return roots.some((root) => isSameOrInside(candidate, root) || isSameOrInside(root, candidate)) ? candidate : cwd;
}

export function classifyGuardCommand(command: unknown, options: GuardOptions = {}): GuardDecision {
  if (typeof command !== "string" || command.trim() === "") {
    return { blocked: false, reason: null, command: "", tokens: [] };
  }
  if (options.inspection?.state === "failed") {
    return { blocked: true, reason: `Git inspection failed: ${options.inspection.reason}`, command, tokens: [] };
  }
  const opaqueReason = opaqueExecutionReason(command);
  if (opaqueReason) return { blocked: true, reason: opaqueReason, command, tokens: [] };
  const hasCommandSubstitution = command.includes("$(") || command.includes("`");
  const hasSynthesizedExecutable = SYNTHESIZED_EXECUTABLE.test(command);
  const hasDynamicDeletionTarget = /(?:^|[;|&()]\s*)(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+|command\s+|env\s+|sudo\s+)*rm\s+[^\n]*[$`]/.test(command);
  if (hasCommandSubstitution && (/\bgit(?:\s|$)/.test(command) || hasSynthesizedExecutable)) {
    return { blocked: true, reason: "dynamic shell command substitution in a git command is blocked", command, tokens: [] };
  }
  if (hasDynamicDeletionTarget) {
    return { blocked: true, reason: "dynamic shell deletion targets are blocked", command, tokens: [] };
  }
  for (const payload of findBacktickPayloads(command)) {
    const nested = classifyGuardCommand(payload, options);
    if (nested.blocked) return { ...nested, reason: `backtick command substitution is blocked: ${nested.reason}` };
  }
  const tokens = tokenizeCommand(command);
  let effectiveCwd = stringOption(options, "cwd") ?? process.cwd();
  for (const { segment, nextSeparator } of commandSegmentsWithSeparators(tokens)) {
    const prefix = peelCommandPrefix(segment);
    const scopedCwd = prefix.envCwd ? guardCwdAfter(["cd", prefix.envCwd], effectiveCwd, options) : effectiveCwd;
    const scopedOptions = { ...options, cwd: scopedCwd };
    if (prefix.unsafeExecutableSearchPath) {
      return { blocked: true, reason: "env alternate executable search path is blocked because it can replace commands", command, tokens };
    }
    const result = classifySegment(segment, scopedOptions, (payload, inheritedEnvAssignments, envCwd) => {
      const nestedCwd = envCwd ? guardCwdAfter(["cd", envCwd], effectiveCwd, options) : effectiveCwd;
      const nested = classifyGuardCommand(payload, { ...scopedOptions, cwd: nestedCwd, inheritedEnvAssignments });
      return nested.blocked ? nested : null;
    });
    if (result) return { ...result, tokens };
    if (nextSeparator === ";" || nextSeparator === "&&") {
      effectiveCwd = guardCwdAfter(segment, scopedCwd, options);
    }
  }
  return { blocked: false, reason: null, command, tokens };
}

export function extractCommandText(input: GuardCommandPayload = {}, output: GuardCommandPayload = {}): unknown {
  const outputArgs = isRecordLike(output.args) ? output.args : {};
  const inputArgs = isRecordLike(input.args) ? input.args : {};
  return outputArgs.command ?? inputArgs.command ?? inputArgs.code ?? input.command ?? output.command ?? "";
}

export type { GuardBlockDecision };
