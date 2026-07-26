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
  readonly envCwd: string | null;
  readonly unsafeExecutableSearchPath: boolean;
};

export type CommandPrefix = {
  readonly stripped: CommandSegment;
  readonly assignments: readonly string[];
  readonly envCwd: string | null;
  readonly unsafeExecutableSearchPath: boolean;
};

export type GitInvocation = {
  readonly subcommand: string | undefined;
  readonly rest: CommandSegment;
  readonly normalized: CommandSegment;
  readonly gitCwd: string | null;
  readonly gitDir: string | null;
  readonly workTree: string | null;
  readonly configs: readonly string[];
  readonly unsafeExecutableSearchPath: boolean;
};

export type GitRevisionIdentity = {
  readonly source: string;
  readonly oid: string;
};

export type GuardBlockDecision = GuardDecision & {
  readonly blocked: true;
  readonly reason: string;
  readonly segment: CommandSegment;
};
