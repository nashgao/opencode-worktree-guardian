import path from "node:path";
import type { GuardOptions } from "../types.ts";
import type { CommandPrefix, CommandSegment, GitInvocation } from "./guard-types.ts";
import { stringOption } from "./options.ts";
import { peelCommandPrefix } from "./shell-prefix.ts";
import { fetchTransportArguments, pushRefspecs, refspecDestinations } from "./transport-arguments.ts";

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
const ALIAS_CAPABLE_ENV_SOURCES = new Set(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_PARAMETERS", "HOME", "XDG_CONFIG_HOME"]);

function peelGitCommandPrefix(segment: CommandSegment): CommandPrefix {
  return peelCommandPrefix(segment);
}

function assignmentMap(assignments: readonly string[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const assignment of assignments) {
    const equals = assignment.indexOf("=");
    if (equals > 0) map.set(assignment.slice(0, equals), assignment.slice(equals + 1));
  }
  return map;
}

function isGitExecutable(executable: string | undefined): boolean {
  if (!executable) return false;
  const basename = path.basename(path.win32.basename(executable)).toLowerCase();
  return basename === "git" || basename === "git.exe";
}

function configEnvValue(value: string, assignments: ReadonlyMap<string, string>): string {
  const separator = value.indexOf("=");
  if (separator <= 0) return value;
  const key = value.slice(0, separator);
  const environmentName = value.slice(separator + 1);
  return `${key}=${assignments.get(environmentName) ?? `$${environmentName}`}`;
}

export function envConfigAliases(assignments: readonly string[]): string[] {
  const env = assignmentMap(assignments);
  const count = Number(env.get("GIT_CONFIG_COUNT") ?? 0);
  const configs: string[] = [];
  for (const key of ALIAS_CAPABLE_ENV_SOURCES) {
    if (env.has(key)) configs.push(`include.path=<${key}>`);
  }
  if (!Number.isInteger(count) || count <= 0) return configs;
  for (let index = 0; index < count; index += 1) {
    const key = env.get(`GIT_CONFIG_KEY_${index}`);
    const value = env.get(`GIT_CONFIG_VALUE_${index}`) ?? "";
    if (typeof key === "string") configs.push(`${key}=${value}`);
  }
  return configs;
}

export function hasAliasCapableEnvironmentAssignments(assignments: readonly string[]): boolean {
  return assignments.some((assignment) => {
    const equals = assignment.indexOf("=");
    const key = (equals === -1 ? assignment : assignment.slice(0, equals)).toUpperCase();
    return ALIAS_CAPABLE_ENV_SOURCES.has(key)
      || key === "GIT_CONFIG_COUNT"
      || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key);
  });
}

export function hasAliasCapableRuntimeConfig(configs: readonly string[]): boolean {
  return configs.some((config) => {
    const key = config.slice(0, config.indexOf("=")).toLowerCase();
    return key.startsWith("alias.") || key === "include.path" || key.startsWith("includeif.") && key.endsWith(".path");
  });
}

function isLiteralReflogSelector(token: string): boolean {
  return /^[^{}]+@\{[^,{}]+\}(?:[~^].*)?$/.test(token);
}

export function hasDynamicShellArgument(tokens: readonly string[]): boolean {
  return tokens.some((token) => token.includes("$")
    || token.includes("`")
    || token.includes("*")
    || token.includes("?")
    || token.includes("[")
    || (/[{}]/.test(token) && !isLiteralReflogSelector(token)));
}

export function parseGitInvocation(segment: CommandSegment, options: GuardOptions = {}): GitInvocation | null {
  const { stripped, assignments, envCwd, unsafeExecutableSearchPath: unsafePrefixPath } = peelGitCommandPrefix(segment);
  if (!isGitExecutable(stripped[0])) return null;
  let index = 1;
  let gitCwd: string | null = envCwd ?? stringOption(options, "cwd") ?? process.cwd();
  let gitDir: string | null = null;
  let workTree: string | null = null;
  const inheritedAssignments = Array.isArray(options.inheritedEnvAssignments) ? options.inheritedEnvAssignments.filter((entry: unknown) => typeof entry === "string") : [];
  const allAssignments = [...inheritedAssignments, ...assignments];
  const assignmentValues = assignmentMap(allAssignments);
  const configs: string[] = envConfigAliases(allAssignments);
  let unsafeExecutableSearchPath = unsafePrefixPath || assignmentValues.has("PATH") || assignmentValues.has("GIT_EXEC_PATH");
  while (index < stripped.length) {
    const token = stripped[index] ?? "";
    if (!token.startsWith("-")) break;
    if (token === "-C") {
      const nextCwd = stripped[index + 1] ?? null;
      if (nextCwd) {
        gitCwd = gitCwd && !path.isAbsolute(nextCwd) ? path.join(gitCwd, nextCwd) : nextCwd;
      }
      index += 2;
      continue;
    }
    if (token === "-c") {
      if (stripped[index + 1]) configs.push(stripped[index + 1] ?? "");
      index += 2;
      continue;
    }
    if (token.startsWith("-c") && token.length > 2) {
      configs.push(token.slice(2));
      index += 1;
      continue;
    }
    if (token === "--config-env") {
      if (stripped[index + 1]) configs.push(configEnvValue(stripped[index + 1] ?? "", assignmentValues));
      index += 2;
      continue;
    }
    if (token.startsWith("--config-env=")) {
      configs.push(configEnvValue(token.slice("--config-env=".length), assignmentValues));
      index += 1;
      continue;
    }
    if (token === "--work-tree") {
      workTree = stripped[index + 1] ?? null;
      index += 2;
      continue;
    }
    if (token === "--git-dir") {
      gitDir = stripped[index + 1] ?? null;
      index += 2;
      continue;
    }
    if (token.startsWith("--git-dir=")) {
      gitDir = token.slice("--git-dir=".length);
      index += 1;
      continue;
    }
    if (token.startsWith("--work-tree=")) {
      workTree = token.slice("--work-tree=".length);
      index += 1;
      continue;
    }
    if (token === "--exec-path") {
      if (stripped[index + 1]?.startsWith("-")) {
        index += 1;
      } else if (stripped[index + 1]) {
        unsafeExecutableSearchPath = true;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (token.startsWith("--exec-path=")) {
      unsafeExecutableSearchPath = true;
      index += 1;
      continue;
    }
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(token)) {
      index += 2;
      continue;
    }
    if (token.startsWith("--config=")) {
      configs.push(token.slice("--config=".length));
      index += 1;
      continue;
    }
    if ([...GIT_GLOBAL_OPTIONS_WITH_VALUE].some((option) => token.startsWith(`${option}=`))) {
      index += 1;
      continue;
    }
    index += 1;
  }
  return { subcommand: stripped[index], rest: stripped.slice(index + 1), normalized: stripped, gitCwd, gitDir, workTree, configs, unsafeExecutableSearchPath };
}

export function pushDestinationRefs(rest: CommandSegment): string[] {
  return refspecDestinations(pushRefspecs(rest), true);
}

export function fetchDestinationRefs(rest: CommandSegment): string[] {
  const { refspecs, capturedValues } = fetchTransportArguments(rest);
  return refspecDestinations([...capturedValues, ...refspecs], false);
}

export function fetchUsesStdin(rest: CommandSegment): boolean {
  return rest.includes("--stdin");
}

export function isForcePushToken(token: string): boolean {
  return token === "--force" || token.startsWith("--force=") || token === "--force-with-lease" || token.startsWith("--force-with-lease=") || /^-[A-Za-z]*f[A-Za-z]*$/.test(token);
}

export { pushRefspecs } from "./transport-arguments.ts";
