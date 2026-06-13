import path from "node:path";
import { expandWorktreeRoot } from "./config.ts";
import { getRepoRoot, listWorktrees } from "./git.ts";
import type { MutableRecord, WorktreeEntry } from "./types.ts";

export type ResolvedUnblockTarget = {
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly targetSource: "state" | "branch" | "worktreePath";
};

function samePath(left: string, right: string) {
  return path.resolve(left) === path.resolve(right);
}

function sameOrInside(candidate: string, root: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function resolveListedWorktree(repoRoot: string, predicate: (worktree: WorktreeEntry) => boolean, targetSource: ResolvedUnblockTarget["targetSource"], missingReason: string, multipleReason: string, expectedBranch?: string | null): Promise<{ readonly target: ResolvedUnblockTarget | null; readonly reason: string | null }> {
  const matches = (await listWorktrees(repoRoot)).filter(predicate);
  if (matches.length !== 1) return { target: null, reason: matches.length > 1 ? multipleReason : missingReason };
  const match = matches[0];
  if (!match || match.detached || !match.branch) return { target: null, reason: "target worktree is detached" };
  if (expectedBranch && match.branch !== expectedBranch) return { target: null, reason: "recorded branch does not match checked-out worktree branch" };
  return { target: { worktreePath: match.path, branch: match.branch, targetSource }, reason: null };
}

export async function resolveExplicitUnblockTarget(repoRoot: string, input: MutableRecord): Promise<{ readonly target: ResolvedUnblockTarget | null; readonly reason: string | null }> {
  const explicitWorktreePath = typeof input.worktreePath === "string" && input.worktreePath.length > 0 ? input.worktreePath : null;
  const explicitBranch = typeof input.branch === "string" && input.branch.length > 0 ? input.branch : null;
  if (!explicitWorktreePath && !explicitBranch) return { target: null, reason: "current session is not recorded in guardian state" };

  if (explicitWorktreePath) {
    const resolved = path.resolve(repoRoot, explicitWorktreePath);
    return resolveListedWorktree(repoRoot, (worktree) => samePath(worktree.path, resolved), "worktreePath", "worktreePath is not checked out in git worktree list", "worktreePath matches multiple git worktrees", explicitBranch);
  }

  return resolveListedWorktree(repoRoot, (worktree) => worktree.branch === explicitBranch, "branch", "branch is not checked out in git worktree list", "branch matches multiple git worktrees");
}

export async function resolveStateUnblockTarget(repoRoot: string, worktreePath: string, expectedBranch?: string | null): Promise<{ readonly target: ResolvedUnblockTarget | null; readonly reason: string | null }> {
  return resolveListedWorktree(repoRoot, (worktree) => samePath(worktree.path, worktreePath), "state", "recorded worktree is not checked out in git worktree list", "recorded worktree path matches multiple git worktrees", expectedBranch);
}

export async function resolveCurrentUnblockTarget(repoRoot: string, cwd: string): Promise<{ readonly target: ResolvedUnblockTarget | null; readonly reason: string | null }> {
  const currentWorktree = await getRepoRoot(cwd);
  return resolveListedWorktree(repoRoot, (worktree) => samePath(worktree.path, currentWorktree), "worktreePath", "current worktree is not checked out in git worktree list", "current worktree matches multiple git worktrees");
}

export function validateUnblockTarget(repoRoot: string, config: MutableRecord, target: ResolvedUnblockTarget) {
  if (samePath(target.worktreePath, repoRoot)) return "target worktree is the primary repository worktree";
  if (!target.branch) return "target worktree is detached";
  const protectedBranches = Array.isArray(config.protectedBranches) ? config.protectedBranches : [];
  if (protectedBranches.includes(target.branch)) return "target branch is protected";
  if (target.targetSource !== "state") {
    const configuredRoot = typeof config.worktreeRoot === "string" ? config.worktreeRoot : ".worktrees/$REPO";
    const worktreeRoot = path.resolve(repoRoot, expandWorktreeRoot(configuredRoot, repoRoot));
    if (!sameOrInside(target.worktreePath, worktreeRoot)) return "explicit target is outside Guardian worktree root";
  }
  return null;
}
