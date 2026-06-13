import type { GuardOptions } from "../types.ts";
import { nonEmptyString, stringArray } from "../types.ts";
import type { CommandSegment, GuardBlockDecision } from "./guard-types.ts";

export function block(reason: string, segment: CommandSegment): GuardBlockDecision {
  return { blocked: true, reason, command: segment.join(" "), segment };
}

export function stringArrayOption(options: GuardOptions, key: keyof GuardOptions): string[] {
  return stringArray(options[key]);
}

export function stringOption(options: GuardOptions, key: keyof GuardOptions): string | null {
  return nonEmptyString(options[key]);
}
