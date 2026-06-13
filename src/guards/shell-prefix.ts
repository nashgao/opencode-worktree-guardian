import fs from "node:fs";
import type { CommandPrefix, CommandSegment, MutableCommandSegment, ShellPayload } from "./guard-types.ts";
import { normalizeForCompare } from "./path-policy.ts";
import { tokenizeCommand } from "./shell-parser.ts";

export const COMMAND_WRAPPERS = new Set(["command", "sudo", "if", "then", "do"]);
export const SHELL_COMMANDS = new Set(["bash", "sh", "zsh", "dash", "fish"]);
export const READ_ONLY_SHELL_COMMANDS = new Set(["pwd"]);

export function stripCommandWrappers(segment: CommandSegment): CommandSegment {
  let index = 0;
  while (COMMAND_WRAPPERS.has(segment[index] ?? "")) index += 1;
  if (segment[index] === "env") {
    index += 1;
    while (segment[index] && (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(segment[index] ?? "") || (segment[index] ?? "").startsWith("-"))) index += 1;
  }
  return segment.slice(index);
}

export function stripSimpleCommandWrappers(segment: CommandSegment): CommandSegment {
  let index = 0;
  while (COMMAND_WRAPPERS.has(segment[index] ?? "")) index += 1;
  return segment.slice(index);
}

export function peelCommandPrefix(segment: CommandSegment): CommandPrefix {
  let prefixed = stripSimpleCommandWrappers(segment);
  let index = 0;
  const assignments: string[] = [];
  if (prefixed[index] === "env") {
    index += 1;
    while (prefixed[index] && (prefixed[index] ?? "").startsWith("-")) {
      const token = prefixed[index] ?? "";
      if (token === "-S" || token === "--split-string") {
        const split = tokenizeCommand(prefixed[index + 1] ?? "");
        prefixed = [...prefixed.slice(0, index), ...split, ...prefixed.slice(index + 2)];
        continue;
      }
      if (token.startsWith("--split-string=")) {
        const split = tokenizeCommand(token.slice("--split-string=".length));
        prefixed = [...prefixed.slice(0, index), ...split, ...prefixed.slice(index + 1)];
        continue;
      }
      if (token === "-u" || token === "--unset") {
        index += 2;
        continue;
      }
      if (token.startsWith("-u") || token.startsWith("--unset=")) {
        index += 1;
        continue;
      }
      index += 1;
    }
  }
  while (prefixed[index] && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(prefixed[index] ?? "")) {
    assignments.push(prefixed[index] ?? "");
    index += 1;
  }
  return { stripped: prefixed.slice(index), assignments };
}

export function shellPayload(segment: CommandSegment): ShellPayload | null {
  const { stripped, assignments } = peelCommandPrefix(segment);
  if (!SHELL_COMMANDS.has(stripped[0] ?? "")) return null;
  for (let index = 1; index < stripped.length; index += 1) {
    const token = stripped[index] ?? "";
    if (token === "-c" || token === "-lc" || token === "-cl" || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(token)) {
      const payload = stripped[index + 1] ?? "";
      if (payload.startsWith("\"") || payload.startsWith("'")) {
        const quote = payload[0] ?? "";
        const payloadTokens: string[] = [];
        for (let payloadIndex = index + 1; payloadIndex < stripped.length; payloadIndex += 1) {
          const payloadToken = stripped[payloadIndex] ?? "";
          payloadTokens.push(payloadToken);
          if (payloadToken.length > 1 && payloadToken.endsWith(quote)) break;
        }
        return { payload: payloadTokens.join(" ").replace(new RegExp(`^\\${quote}|\\${quote}$`, "g"), ""), assignments };
      }
      return { payload, assignments };
    }
  }
  return null;
}

export function cdTarget(segment: CommandSegment, cwd: string): string | null {
  const stripped = stripCommandWrappers(segment);
  if (stripped[0] !== "cd" && stripped[0] !== "pushd") return null;
  const target = stripped.find((token, index) => index > 0 && !token.startsWith("-"));
  if (!target || target === "-") return null;
  const resolved = normalizeForCompare(target, cwd);
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

export function mutableSegment(segment: CommandSegment): MutableCommandSegment {
  return [...segment];
}
