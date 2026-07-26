import path from "node:path";
import type { GuardOptions } from "../types.ts";
import type { CommandSegment } from "./guard-types.ts";
import { isSameOrInside, normalizeForCompare } from "./path-policy.ts";
import { stringOption } from "./options.ts";

export function rmTargets(rest: CommandSegment): string[] {
  const targets: string[] = [];
  let positional = false;
  for (const token of rest) {
    if (token === "--") {
      positional = true;
      continue;
    }
    if (positional || !token.startsWith("-")) targets.push(token);
  }
  return targets;
}

export function isRecursiveForce(tokens: CommandSegment): boolean {
  const flags = tokens.filter((token) => token.startsWith("-"));
  return flags.some((flag) => flag.includes("r") || flag.includes("R"))
    && flags.some((flag) => flag.includes("f") || flag.includes("F"));
}

export function checkoutRestoresPaths(rest: CommandSegment): boolean {
  return rest.includes("--") && rest.indexOf("--") < rest.length - 1;
}

export function restoreIsDestructive(rest: CommandSegment): boolean {
  if (rest.includes("--staged") && !rest.includes("--worktree") && rest.every((token) => token === "--staged" || token.startsWith("-"))) {
    return false;
  }
  return rest.includes("--worktree") || rest.some((token) => !token.startsWith("-"));
}

function canonicalTarget(target: string, cwd: string, options: GuardOptions): string {
  const resolved = normalizeForCompare(target, cwd);
  const facts = options.pathFacts;
  return facts?.canonicalTargets[resolved] ?? facts?.canonicalTargets[target] ?? resolved;
}

function canonicalRoots(options: GuardOptions, cwd: string): readonly string[] {
  if (options.pathFacts) return options.pathFacts.canonicalRepoRoots;
  const roots = [stringOption(options, "repoRoot"), stringOption(options, "worktree")]
    .filter((root): root is string => root !== null);
  return roots.length > 0 ? roots.map((root) => normalizeForCompare(root, cwd)) : [normalizeForCompare(cwd, cwd)];
}

export function targetsRepoManagedPath(targets: readonly string[], options: GuardOptions): boolean {
  const cwd = options.cwd ?? process.cwd();
  const roots = canonicalRoots(options, cwd);
  return targets.some((target) => target !== "" && !target.startsWith("-")
    && roots.some((root) => isSameOrInside(canonicalTarget(target, cwd, options), root)));
}

export function targetsKnownWorktreePath(targets: readonly string[], options: GuardOptions): boolean {
  const cwd = options.cwd ?? process.cwd();
  const roots = options.pathFacts?.canonicalKnownWorktreePaths
    ?? (options.knownWorktreePaths ?? []).map((knownPath) => path.resolve(cwd, knownPath));
  return targets.some((target) => target !== "" && !target.startsWith("-")
    && roots.some((root) => isSameOrInside(canonicalTarget(target, cwd, options), root)));
}
