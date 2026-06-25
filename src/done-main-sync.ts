import { fetchRemote, getDirtyFiles, getRefCommit, isAncestor, listWorktrees, runGit } from "./git.ts";
import type { GuardianConfig } from "./types.ts";

// Fail-soft: returns a report instead of throwing so a sync hiccup never undoes finished merges.
// Fast-forwards the local base-branch worktree to the freshly fetched remote base. Skips (never
// resets) when base is checked out nowhere, is dirty, or has diverged - no force, no merge commit.
export async function syncLocalBase(repoRoot: string, config: GuardianConfig): Promise<Record<string, unknown>> {
  const remote = String(config.remote);
  const baseBranch = String(config.baseBranch);
  const baseRef = `${remote}/${baseBranch}`;
  try {
    await fetchRemote(repoRoot, remote);
  } catch (error) {
    return { ok: false, baseBranch, reason: "remote fetch failed", error: error instanceof Error ? error.message : String(error) };
  }
  let remoteOid: string;
  try {
    remoteOid = await getRefCommit(repoRoot, baseRef);
  } catch (error) {
    return { ok: false, baseBranch, reason: `could not resolve ${baseRef}`, error: error instanceof Error ? error.message : String(error) };
  }
  const baseWorktree = (await listWorktrees(repoRoot)).find((worktree) => worktree.branch === baseBranch);
  if (!baseWorktree) return { ok: false, baseBranch, reason: `no worktree has ${baseBranch} checked out; skipped local fast-forward`, remoteHead: remoteOid };
  const localOid = typeof baseWorktree.head === "string" ? baseWorktree.head : null;
  if (localOid === remoteOid) return { ok: true, baseBranch, alreadySynced: true, head: remoteOid, worktreePath: baseWorktree.path };
  const dirty = await getDirtyFiles(baseWorktree.path);
  if (dirty.length > 0) return { ok: false, baseBranch, reason: `${baseBranch} worktree has uncommitted changes; skipped local fast-forward`, dirtyFileCount: dirty.length, worktreePath: baseWorktree.path };
  if (localOid && !(await isAncestor(repoRoot, localOid, baseRef))) {
    return { ok: false, baseBranch, reason: `local ${baseBranch} has diverged from ${baseRef}; skipped local fast-forward`, localHead: localOid, remoteHead: remoteOid, worktreePath: baseWorktree.path };
  }
  try {
    await runGit(baseWorktree.path, ["merge", "--ff-only", baseRef]);
  } catch (error) {
    return { ok: false, baseBranch, reason: "git merge --ff-only failed", error: error instanceof Error ? error.message : String(error), worktreePath: baseWorktree.path };
  }
  return { ok: true, baseBranch, fastForwarded: true, from: localOid, to: remoteOid, worktreePath: baseWorktree.path };
}
