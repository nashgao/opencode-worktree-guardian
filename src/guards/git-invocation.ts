import path from "node:path";
import type { GuardOptions } from "../types.ts";
import type { CommandPrefix, CommandSegment, GitInvocation } from "./guard-types.ts";
import { peelCommandPrefix } from "./shell-prefix.ts";

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path"]);
const GIT_PUSH_OPTIONS_WITH_VALUE = new Set(["--repo", "--receive-pack", "--exec", "--push-option", "--recurse-submodules", "-o"]);

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

export function envConfigAliases(assignments: readonly string[]): string[] {
  const env = assignmentMap(assignments);
  const count = Number(env.get("GIT_CONFIG_COUNT") ?? 0);
  const configs: string[] = [];
  if (!Number.isInteger(count) || count <= 0) return configs;
  for (let index = 0; index < count; index += 1) {
    const key = env.get(`GIT_CONFIG_KEY_${index}`);
    const value = env.get(`GIT_CONFIG_VALUE_${index}`) ?? "";
    if (typeof key === "string") configs.push(`${key}=${value}`);
  }
  return configs;
}

export function hasAliasCapableRuntimeConfig(configs: readonly string[]): boolean {
  return configs.some((config) => {
    const key = config.slice(0, config.indexOf("=")).toLowerCase();
    return key.startsWith("alias.") || key === "include.path" || key.startsWith("includeif.") && key.endsWith(".path");
  });
}

export function parseGitInvocation(segment: CommandSegment, options: GuardOptions = {}): GitInvocation | null {
  const { stripped, assignments } = peelGitCommandPrefix(segment);
  if (stripped[0] !== "git") return null;
  let index = 1;
  let gitCwd: string | null = null;
  let workTree: string | null = null;
  const inheritedAssignments = Array.isArray(options.inheritedEnvAssignments) ? options.inheritedEnvAssignments.filter((entry: unknown) => typeof entry === "string") : [];
  const configs: string[] = envConfigAliases([...inheritedAssignments, ...assignments]);
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
      if (stripped[index + 1]) configs.push(stripped[index + 1] ?? "");
      index += 2;
      continue;
    }
    if (token.startsWith("--config-env=")) {
      configs.push(token.slice("--config-env=".length));
      index += 1;
      continue;
    }
    if (token === "--work-tree") {
      workTree = stripped[index + 1] ?? null;
      index += 2;
      continue;
    }
    if (token.startsWith("--work-tree=")) {
      workTree = token.slice("--work-tree=".length);
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
  return { subcommand: stripped[index], rest: stripped.slice(index + 1), normalized: stripped, gitCwd, workTree, configs };
}

export function pushRefspecs(rest: CommandSegment): string[] {
  let index = 0;
  let repoOption = false;
  while (index < rest.length) {
    const token = rest[index] ?? "";
    if (token === "--") {
      index += 1;
      break;
    }
    if (!token.startsWith("-")) break;
    if (token === "--repo") {
      repoOption = true;
      index += 2;
      continue;
    }
    if (token.startsWith("--repo=")) {
      repoOption = true;
      index += 1;
      continue;
    }
    if (GIT_PUSH_OPTIONS_WITH_VALUE.has(token)) {
      index += 2;
      continue;
    }
    if ([...GIT_PUSH_OPTIONS_WITH_VALUE].some((option) => token.startsWith(`${option}=`))) {
      index += 1;
      continue;
    }
    index += 1;
  }
  if (!repoOption && index < rest.length) index += 1;
  return rest.slice(index).filter((token) => token && !token.startsWith("-"));
}

export function isForcePushToken(token: string): boolean {
  return token === "--force" || token.startsWith("--force=") || token === "--force-with-lease" || token.startsWith("--force-with-lease=") || token === "-f";
}
