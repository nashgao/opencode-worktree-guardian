import path from "node:path";
import type { CommandPrefix, CommandSegment, MutableCommandSegment, ShellPayload } from "./guard-types.ts";
import { normalizeForCompare } from "./path-policy.ts";
import { tokenizeCommand } from "./shell-parser.ts";

export const COMMAND_WRAPPERS = new Set(["command", "sudo", "if", "then", "do"]);
export const SHELL_COMMANDS = new Set(["bash", "sh", "zsh", "dash", "fish"]);
export const READ_ONLY_SHELL_COMMANDS = new Set(["pwd"]);
const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=.*/;

export function stripCommandWrappers(segment: CommandSegment): CommandSegment {
  return peelCommandPrefix(segment).stripped;
}

export function peelCommandPrefix(segment: CommandSegment): CommandPrefix {
  let prefixed = [...segment];
  let index = 0;
  const assignments: string[] = [];
  let envCwd: string | null = null;
  let unsafeExecutableSearchPath = false;
  while (index < prefixed.length) {
    const prefixStart = index;
    while (COMMAND_WRAPPERS.has(prefixed[index] ?? "")) index += 1;
    while (ASSIGNMENT_PATTERN.test(prefixed[index] ?? "")) {
      assignments.push(prefixed[index] ?? "");
      index += 1;
    }
    if (prefixed[index] !== "env") {
      if (index > prefixStart) continue;
      break;
    }
    index += 1;
    let wrapperCwd: string | null = null;
    while (prefixed[index] && (prefixed[index] ?? "").startsWith("-")) {
      const token = prefixed[index] ?? "";
      if (token === "--") {
        index += 1;
        break;
      }
      if (token === "-S" || token === "--split-string") {
        const split = tokenizeCommand(prefixed[index + 1] ?? "");
        prefixed = [...prefixed.slice(0, index), ...split, ...prefixed.slice(index + 2)];
        continue;
      }
      if (token.startsWith("-S") && token.length > 2) {
        const split = tokenizeCommand(token.slice(2));
        prefixed = [...prefixed.slice(0, index), ...split, ...prefixed.slice(index + 1)];
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
      if (token === "--chdir") {
        wrapperCwd = prefixed[index + 1] ?? null;
        index += 2;
        continue;
      }
      if (["-a", "--argv0"].includes(token)) {
        index += 2;
        continue;
      }
      if (token.startsWith("-u") || token.startsWith("--unset=")) {
        index += 1;
        continue;
      }
      if (token.startsWith("--chdir=")) {
        wrapperCwd = token.slice("--chdir=".length);
        index += 1;
        continue;
      }
      if (token.startsWith("--argv0=")) {
        index += 1;
        continue;
      }
      if (token.startsWith("--")) {
        if (!["--ignore-environment", "--null", "--debug", "--verbose"].includes(token)) unsafeExecutableSearchPath = true;
        index += 1;
        continue;
      }
      const cluster = token.slice(1);
      let clusterIndex = 0;
      let consumedValue = false;
      while (clusterIndex < cluster.length) {
        const flag = cluster[clusterIndex] ?? "";
        if (["0", "i", "v"].includes(flag)) {
          clusterIndex += 1;
          continue;
        }
        if (!["C", "P", "S", "u", "a"].includes(flag)) {
          unsafeExecutableSearchPath = true;
          break;
        }
        const attachedValue = cluster.slice(clusterIndex + 1);
        const value = attachedValue || prefixed[index + 1] || "";
        if (!value) {
          unsafeExecutableSearchPath = true;
          break;
        }
        if (flag === "S") {
          const split = tokenizeCommand(value);
          prefixed = [...prefixed.slice(0, index), ...split, ...prefixed.slice(index + (attachedValue ? 1 : 2))];
          consumedValue = true;
          break;
        }
        if (flag === "C") wrapperCwd = value;
        if (flag === "P") unsafeExecutableSearchPath = true;
        index += attachedValue ? 1 : 2;
        consumedValue = true;
        break;
      }
      if (!consumedValue) index += 1;
    }
    if (wrapperCwd) envCwd = envCwd && !path.isAbsolute(wrapperCwd) ? path.join(envCwd, wrapperCwd) : wrapperCwd;
  }
  return { stripped: prefixed.slice(index), assignments, envCwd, unsafeExecutableSearchPath };
}

export function shellPayload(segment: CommandSegment): ShellPayload | null {
  const { stripped, assignments, envCwd, unsafeExecutableSearchPath } = peelCommandPrefix(segment);
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
        return { payload: payloadTokens.join(" ").replace(new RegExp(`^\\${quote}|\\${quote}$`, "g"), ""), assignments, envCwd, unsafeExecutableSearchPath };
      }
      return { payload, assignments, envCwd, unsafeExecutableSearchPath };
    }
  }
  return null;
}

export function cdTarget(segment: CommandSegment, cwd: string): string | null {
  const stripped = stripCommandWrappers(segment);
  if (stripped[0] !== "cd" && stripped[0] !== "pushd") return null;
  const target = stripped.find((token, index) => index > 0 && !token.startsWith("-"));
  if (!target || target === "-") return null;
  return normalizeForCompare(target, cwd);
}

export function mutableSegment(segment: CommandSegment): MutableCommandSegment {
  return [...segment];
}
