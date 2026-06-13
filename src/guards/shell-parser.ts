import type { CommandSegment, MutableCommandSegment, SegmentSeparator, SegmentWithSeparator } from "./guard-types.ts";

const SEGMENT_BREAK_VALUES = [";", "&&", "||", "|", "(", ")"] as const;
export const SEGMENT_BREAKS = new Set<string>(SEGMENT_BREAK_VALUES);

export function isSegmentSeparator(token: string): token is SegmentSeparator {
  return SEGMENT_BREAKS.has(token);
}

export function tokenizeCommand(command: string): string[] {
  const tokens: MutableCommandSegment = [];
  let token = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const pair = `${char}${command[index + 1] ?? ""}`;
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if ((char === "'" || char === "\"") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (quote === null && (char === "\n" || char === "\r")) {
      if (token) tokens.push(token);
      tokens.push(";");
      token = "";
      continue;
    }
    if (quote === null && /\s/.test(char)) {
      if (token) tokens.push(token);
      token = "";
      continue;
    }
    if (quote === null && (pair === "&&" || pair === "||")) {
      if (token) tokens.push(token);
      tokens.push(pair);
      token = "";
      index += 1;
      continue;
    }
    if (quote === null && (char === ";" || char === "|" || char === "(" || char === ")")) {
      if (token) tokens.push(token);
      tokens.push(char);
      token = "";
      continue;
    }
    if (quote === null && char === "$" && command[index + 1] === "(") {
      if (token) tokens.push(token);
      tokens.push("(");
      token = "";
      index += 1;
      continue;
    }
    token += char;
  }
  if (token) tokens.push(token);
  return tokens;
}

export function commandSegments(tokens: readonly string[]): CommandSegment[] {
  const segments: CommandSegment[] = [];
  let current: MutableCommandSegment = [];
  for (const token of tokens) {
    if (SEGMENT_BREAKS.has(token)) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

export function commandSegmentsWithSeparators(tokens: readonly string[]): SegmentWithSeparator[] {
  const segments: SegmentWithSeparator[] = [];
  let current: MutableCommandSegment = [];
  for (const token of tokens) {
    if (isSegmentSeparator(token)) {
      if (current.length) segments.push({ segment: current, nextSeparator: token });
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length) segments.push({ segment: current, nextSeparator: null });
  return segments;
}

export function findBacktickPayloads(command: string): string[] {
  const payloads: string[] = [];
  let escaped = false;
  let start = -1;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "`") {
      if (start === -1) start = index + 1;
      else {
        payloads.push(command.slice(start, index));
        start = -1;
      }
    }
  }
  return payloads;
}
