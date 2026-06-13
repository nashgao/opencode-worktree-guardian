import path from "node:path";
import { expandWorktreeRoot } from "./config.ts";
import type { GuardianConfig } from "./types.ts";

function sameOrInside(candidate: string, root: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "worktree";
}

export function recoverySessionId(branch: string, headCommit: string) {
  return `ses_recovered_${slug(branch)}_${headCommit.slice(0, 12)}`;
}

export function guardianWorktreeRoot(repoRoot: string, config: GuardianConfig | Record<string, unknown>) {
  return path.resolve(repoRoot, expandWorktreeRoot(String(config.worktreeRoot), repoRoot));
}

export function recoverableGuardianWorktreeBlocker(repoRoot: string, currentWorktree: string, currentBranch: string | null, config: GuardianConfig | Record<string, unknown>) {
  if (!currentBranch) return "detached HEAD cannot be recovered as a Guardian worktree";
  if (path.resolve(currentWorktree) === path.resolve(repoRoot)) return "primary repo worktree cannot be recovered as a Guardian worktree";
  const protectedBranches = Array.isArray(config.protectedBranches) ? config.protectedBranches.filter((branch): branch is string => typeof branch === "string") : [];
  if (protectedBranches.includes(currentBranch)) return "protected branches cannot be recovered as Guardian worktrees";
  const guardianRoot = guardianWorktreeRoot(repoRoot, config);
  if (!sameOrInside(currentWorktree, guardianRoot)) return "current worktree is outside the configured Guardian worktree root";
  return null;
}
