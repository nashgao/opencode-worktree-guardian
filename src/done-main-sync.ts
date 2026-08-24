import path from "node:path";
import { expandWorktreeRoot } from "./config.ts";
import { resolveBaseRef } from "./done-base-ref.ts";
import { fetchRemote, getDirtyFiles, getRefCommit, isAncestor, listWorktrees, runGit } from "./git.ts";
import { isInside } from "./workflow-candidates.ts";

async function matchesIncomingTrackedFiles(worktreePath: string, incomingOid: string, files: readonly string[]): Promise<boolean> {
  try {
    await runGit(worktreePath, ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", ...files]);
    await runGit(worktreePath, ["--literal-pathspecs", "diff", "--cached", "--quiet", "HEAD", "--", ...files]);
    await runGit(worktreePath, ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--quiet", incomingOid, "--", ...files]);
    return true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return false;
  }
}

async function restoreWorktreeFiles(worktreePath: string, source: string, files: readonly string[]): Promise<void> {
  await runGit(worktreePath, ["--literal-pathspecs", "restore", `--source=${source}`, "--worktree", "--", ...files]);
}

// Fail-soft: returns a report instead of throwing so a sync hiccup never undoes finished merges.
export async function syncLocalBase(repoRoot: string, config: Record<string, unknown>): Promise<Record<string, unknown>> {
  const base = await resolveBaseRef(repoRoot, config);
  const { localBaseBranch, baseRef, authorityRef } = base;
  try {
    await fetchRemote(repoRoot, base.remote);
  } catch (error) {
    return { ok: false, baseBranch: localBaseBranch, baseRef, configuredBaseRef: base.configuredBaseRef, baseRefSource: base.source, reason: "remote fetch failed", error: error instanceof Error ? error.message : String(error) };
  }
  let remoteOid: string;
  try {
    remoteOid = await getRefCommit(repoRoot, authorityRef);
  } catch (error) {
    return { ok: false, baseBranch: localBaseBranch, baseRef, configuredBaseRef: base.configuredBaseRef, baseRefSource: base.source, reason: `could not resolve ${baseRef}`, error: error instanceof Error ? error.message : String(error) };
  }
  const baseWorktree = (await listWorktrees(repoRoot)).find((worktree) => worktree.branch === localBaseBranch);
  if (!baseWorktree) return { ok: false, baseBranch: localBaseBranch, baseRef, configuredBaseRef: base.configuredBaseRef, baseRefSource: base.source, reason: `no worktree has ${localBaseBranch} checked out; skipped local fast-forward`, remoteHead: remoteOid };
  const localOid = typeof baseWorktree.head === "string" ? baseWorktree.head : null;
  if (localOid === remoteOid) return { ok: true, baseBranch: localBaseBranch, baseRef, configuredBaseRef: base.configuredBaseRef, baseRefSource: base.source, alreadySynced: true, head: remoteOid, worktreePath: baseWorktree.path };
  const guardianRoot = path.resolve(repoRoot, expandWorktreeRoot(String(config.worktreeRoot), repoRoot));
  const dirty = (await getDirtyFiles(baseWorktree.path)).filter((file) => !isInside(path.resolve(baseWorktree.path, file.replace(/\/$/, "")), guardianRoot));
  const reconciledDirtyFiles = dirty.length > 0 && await matchesIncomingTrackedFiles(baseWorktree.path, remoteOid, dirty) ? dirty : [];
  if (dirty.length > 0 && reconciledDirtyFiles.length === 0) return { ok: false, baseBranch: localBaseBranch, baseRef, configuredBaseRef: base.configuredBaseRef, baseRefSource: base.source, reason: `${localBaseBranch} worktree has uncommitted changes; skipped local fast-forward`, dirtyFileCount: dirty.length, worktreePath: baseWorktree.path };
  if (localOid && !(await isAncestor(repoRoot, localOid, remoteOid))) {
    return { ok: false, baseBranch: localBaseBranch, baseRef, configuredBaseRef: base.configuredBaseRef, baseRefSource: base.source, reason: `local ${localBaseBranch} has diverged from ${baseRef}; skipped local fast-forward`, localHead: localOid, remoteHead: remoteOid, worktreePath: baseWorktree.path };
  }
  if (reconciledDirtyFiles.length > 0) {
    try {
      await restoreWorktreeFiles(baseWorktree.path, "HEAD", reconciledDirtyFiles);
    } catch (error) {
      return { ok: false, baseBranch: localBaseBranch, baseRef, configuredBaseRef: base.configuredBaseRef, baseRefSource: base.source, reason: "incoming-identical worktree changes could not be prepared for fast-forward", error: error instanceof Error ? error.message : String(error), dirtyFileCount: dirty.length, worktreePath: baseWorktree.path };
    }
  }
  try {
    await runGit(baseWorktree.path, ["merge", "--ff-only", remoteOid]);
  } catch (error) {
    let recoveryError: string | undefined;
    if (reconciledDirtyFiles.length > 0) {
      try {
        await restoreWorktreeFiles(baseWorktree.path, remoteOid, reconciledDirtyFiles);
      } catch (restoreError) {
        recoveryError = restoreError instanceof Error ? restoreError.message : String(restoreError);
      }
    }
    return { ok: false, baseBranch: localBaseBranch, baseRef, configuredBaseRef: base.configuredBaseRef, baseRefSource: base.source, reason: "git merge --ff-only failed", error: error instanceof Error ? error.message : String(error), ...(recoveryError ? { recoveryError } : {}), worktreePath: baseWorktree.path };
  }
  return { ok: true, baseBranch: localBaseBranch, baseRef, configuredBaseRef: base.configuredBaseRef, baseRefSource: base.source, fastForwarded: true, from: localOid, to: remoteOid, ...(reconciledDirtyFiles.length > 0 ? { reconciledDirtyFiles } : {}), worktreePath: baseWorktree.path };
}
