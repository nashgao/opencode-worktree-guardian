import type { GuardDecision } from "../types.ts";

export type CommandToken = string;
export type CommandSegment = readonly CommandToken[];
export type MutableCommandSegment = CommandToken[];
export type SegmentSeparator = ";" | "&&" | "||" | "|" | "(" | ")";

export type SegmentWithSeparator = {
  readonly segment: CommandSegment;
  readonly nextSeparator: SegmentSeparator | null;
};

export type ShellPayload = {
  readonly payload: string;
  readonly assignments: readonly string[];
};

export type CommandPrefix = {
  readonly stripped: CommandSegment;
  readonly assignments: readonly string[];
};

export type GitInvocation = {
  readonly subcommand: string | undefined;
  readonly rest: CommandSegment;
  readonly normalized: CommandSegment;
  readonly gitCwd: string | null;
  readonly workTree: string | null;
  readonly configs: readonly string[];
};

export type GuardBlockDecision = GuardDecision & {
  readonly blocked: true;
  readonly reason: string;
  readonly segment: CommandSegment;
};
