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

function classifyDynamicRmTarget(segment: CommandSegment, nextSeparator: SegmentSeparator | null): GuardBlockDecision | null {
  if (nextSeparator !== "(" || !isRecursiveForceRm(segment)) return null;
  return block("rm -rf with command substitution or dynamic target is blocked; use guardian_delete_paths or guardian_hygiene", stripCommandWrappers(segment));
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
    const dynamicRmTarget = classifyDynamicRmTarget(segment, nextSeparator);
    if (dynamicRmTarget) return { ...dynamicRmTarget, tokens };
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
