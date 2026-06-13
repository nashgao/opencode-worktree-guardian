import type { GuardCommandPayload, GuardDecision, GuardOptions } from "../types.ts";
import { isRecordLike } from "../types.ts";
import { classifySegment } from "./destructive-classifier.ts";
import type { GuardBlockDecision } from "./guard-types.ts";
import { stringOption } from "./options.ts";
import { cdTarget } from "./shell-prefix.ts";
import { commandSegmentsWithSeparators, findBacktickPayloads, tokenizeCommand } from "./shell-parser.ts";

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
