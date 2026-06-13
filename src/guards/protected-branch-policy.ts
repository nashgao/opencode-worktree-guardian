import path from "node:path";
import type { GuardOptions } from "../types.ts";
import type { CommandSegment, GuardBlockDecision } from "./guard-types.ts";
import { hasAliasCapableRuntimeConfig, pushRefspecs } from "./git-invocation.ts";
import { block, stringArrayOption, stringOption } from "./options.ts";
import { pathSameOrInside } from "./path-policy.ts";

function branchNameFromRef(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

function isProtectedRef(ref: string, protectedBranches: readonly string[]): boolean {
  return protectedBranches.includes(branchNameFromRef(ref));
}

function isGuardianRef(ref: string, branchPrefix: string | null, guardianBranches: readonly string[]): boolean {
  const branch = branchNameFromRef(ref);
  return guardianBranches.includes(branch) || Boolean(branchPrefix && branch.startsWith(branchPrefix));
}

function isProtectedWorktreeTarget(target: string, worktreePaths: readonly string[], cwd: string): boolean {
  return worktreePaths.some((worktreePath) => pathSameOrInside(target, worktreePath, cwd));
}

export function protectedBranchBypass(
  segment: CommandSegment,
  subcommand: string,
  rest: CommandSegment,
  options: GuardOptions,
  gitCwd: string | null,
  workTree: string | null,
  configs: readonly string[],
): GuardBlockDecision | null {
  const protectedBranches = stringArrayOption(options, "protectedBranches");
  const branchPrefix = stringOption(options, "branchPrefix");
  const guardianBranches = stringArrayOption(options, "guardianBranches");
  const protectedBranchWorktreePaths = stringArrayOption(options, "protectedBranchWorktreePaths");
  if (protectedBranches.length === 0) return null;

  if (subcommand === "push") {
    const deletesBranch = rest.includes("--delete") || rest.includes("-d");
    for (const rawSpec of pushRefspecs(rest)) {
      const spec = rawSpec.startsWith("+") ? rawSpec.slice(1) : rawSpec;
      const colon = spec.indexOf(":");
      if (colon === -1) {
        if (deletesBranch && isProtectedRef(spec, protectedBranches)) {
          return block("protected branch deletion push is blocked", segment);
        }
        continue;
      }
      const source = spec.slice(0, colon);
      const target = spec.slice(colon + 1);
      if (!source && target && isProtectedRef(target, protectedBranches)) {
        return block("protected branch deletion push is blocked", segment);
      }
      if (target && isProtectedRef(target, protectedBranches) && (source === "HEAD" || isGuardianRef(source, branchPrefix, guardianBranches))) {
        return block("manual push from Guardian work to a protected branch is blocked; use guardian_finish", segment);
      }
    }
  }

  if (subcommand === "merge") {
    const currentBranch = stringOption(options, "currentBranch");
    const cwd = stringOption(options, "cwd") ?? process.cwd();
    const gitTargetCwd = gitCwd ? path.resolve(cwd, gitCwd) : null;
    const gitWorkTree = workTree ? path.resolve(gitTargetCwd ?? cwd, workTree) : null;
    const cwdProtected = isProtectedWorktreeTarget(cwd, protectedBranchWorktreePaths, cwd);
    const protectedTarget = gitWorkTree ?? gitTargetCwd;
    const protectedCwd = protectedTarget ? isProtectedWorktreeTarget(protectedTarget, protectedBranchWorktreePaths, cwd) : cwdProtected;
    if (!protectedCwd && (!currentBranch || !isProtectedRef(currentBranch, protectedBranches))) return null;
    const mergeTargets = rest.filter((token) => token && !token.startsWith("-"));
    if (mergeTargets.some((target) => isGuardianRef(target, branchPrefix, guardianBranches))) {
      return block("manual merge of Guardian work into a protected branch is blocked; use guardian_finish", segment);
    }
  }

  if (hasAliasCapableRuntimeConfig(configs)) {
    const cwd = stringOption(options, "cwd") ?? process.cwd();
    const gitTargetCwd = gitCwd ? path.resolve(cwd, gitCwd) : cwd;
    const gitWorkTree = workTree ? path.resolve(gitTargetCwd, workTree) : null;
    const protectedTarget = gitWorkTree ?? gitTargetCwd;
    if (isProtectedWorktreeTarget(protectedTarget, protectedBranchWorktreePaths, cwd)) {
      return block("runtime git alias-capable config in protected worktrees is blocked; use guardian_finish", segment);
    }
  }

  return null;
}
