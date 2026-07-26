import { peelCommandPrefix, SHELL_COMMANDS } from "./shell-prefix.ts";
import { commandSegmentsWithSeparators, tokenizeCommand } from "./shell-parser.ts";

function hasDynamicExecutable(tokens: readonly string[]): boolean {
  const executable = peelCommandPrefix(tokens).stripped[0] ?? "";
  return executable.includes("$") || executable.includes("`");
}

function hasShellPipeline(command: string): boolean {
  const segments = commandSegmentsWithSeparators(tokenizeCommand(command));
  return segments.some(({ nextSeparator }, index) => nextSeparator === "|"
    && SHELL_COMMANDS.has(peelCommandPrefix(segments[index + 1]?.segment ?? []).stripped[0] ?? ""));
}

export function opaqueExecutionReason(command: string): string | null {
  const segments = commandSegmentsWithSeparators(tokenizeCommand(command));
  if (segments.some(({ segment }) => peelCommandPrefix(segment).stripped[0] === "eval")) {
    return "eval execution is opaque and blocked";
  }
  if (hasShellPipeline(command)) return "pipelines into shell interpreters are opaque and blocked";
  if (segments.some(({ segment }) => hasDynamicExecutable(segment))) {
    return "dynamic executable positions are opaque and blocked";
  }
  if (/(?:^|\s)git(?:\.exe)?\s+\$\(/i.test(command)) {
    return "dynamic git arguments are opaque and blocked";
  }
  return null;
}
