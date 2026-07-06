import type { GuardCommandPayload, GuardDecision, GuardOptions } from "../types.ts";
import { isRecordLike } from "../types.ts";
import { classifySegment } from "./destructive-classifier.ts";
import type { CommandSegment, GuardBlockDecision, SegmentSeparator } from "./guard-types.ts";
import { block, stringOption } from "./options.ts";
import { cdTarget, stripCommandWrappers } from "./shell-prefix.ts";
import { commandSegmentsWithSeparators, findBacktickPayloads, tokenizeCommand } from "./shell-parser.ts";

function isRecursiveForceRm(tokens: CommandSegment): boolean {
  const stripped = stripCommandWrappers(tokens);
  if (stripped[0] !== "rm") return false;
  const flags = stripped.slice(1).filter((token) => token.startsWith("-"));
  return flags.some((flag) => flag.includes("r") || flag.includes("R")) && flags.some((flag) => flag.includes("f") || flag.includes("F"));
}

function hasDynamicGitPathOption(tokens: CommandSegment): boolean {
  const stripped = stripCommandWrappers(tokens);
  if (stripped[0] !== "git") return false;
  const last = stripped[stripped.length - 1] ?? "";
  return ["-C", "--git-dir", "--work-tree"].includes(last) || last === "--git-dir=" || last === "--work-tree=";
}

function classifyDynamicTarget(segment: CommandSegment, nextSeparator: SegmentSeparator | null): GuardBlockDecision | null {
  if (nextSeparator !== "(") return null;
  if (isRecursiveForceRm(segment)) {
    return block("rm -rf with command substitution or dynamic target is blocked; use guardian_delete_paths or guardian_hygiene", stripCommandWrappers(segment));
  }
  if (hasDynamicGitPathOption(segment)) {
    return block("git command with command substitution in a path option is blocked; avoid dynamic -C/--git-dir/--work-tree targets", stripCommandWrappers(segment));
  }
  return null;
}

export function classifyGuardCommand(command: unknown, options: GuardOptions = {}): GuardDecision {
  if (typeof command !== "string" || command.trim() === "") {
    return { blocked: false, reason: null, command: "", tokens: [] };
  }
  for (const payload of findBacktickPayloads(command)) {
    const nested = classifyGuardCommand(payload, options);
    if (nested.blocked) return { ...nested, reason: `backtick command substitution is blocked: ${nested.reason}` };
  }
  const tokens = tokenizeCommand(command);
  let effectiveCwd = stringOption(options, "cwd") ?? process.cwd();
  for (const { segment, nextSeparator } of commandSegmentsWithSeparators(tokens)) {
    const scopedOptions = { ...options, cwd: effectiveCwd };
    const dynamicTarget = classifyDynamicTarget(segment, nextSeparator);
    if (dynamicTarget) return { ...dynamicTarget, tokens };
    const result = classifySegment(segment, scopedOptions, (payload, inheritedEnvAssignments) => {
      const nested = classifyGuardCommand(payload, { ...scopedOptions, inheritedEnvAssignments });
      return nested.blocked ? nested : null;
    });
    if (result) return { ...result, tokens };
    if (nextSeparator === ";" || nextSeparator === "&&") {
      effectiveCwd = cdTarget(segment, effectiveCwd) ?? effectiveCwd;
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
