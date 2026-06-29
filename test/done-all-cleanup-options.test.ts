import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { guardianStart } from "../src/tools.ts";
import { createRepoWithOrigin, git, installMultiBranchFakeGh } from "./helpers.ts";

type LooseRecord = Record<string, unknown>;
type WorktreeCommit = { readonly file: string; readonly content: string; readonly message: string };
type MergedWorktree = { readonly branch: string; readonly worktreeName: string; readonly fileName: string };

async function pathExists(target: string) {
  return fs.access(target).then(() => true, () => false);
}

async function commitInWorktree(worktree: string, commit: WorktreeCommit) {
  await fs.writeFile(path.join(worktree, commit.file), commit.content);
  await git(worktree, ["add", commit.file]);
  await git(worktree, ["commit", "-m", commit.message]);
}

async function createMergedGuardianWorktree(repo: string, worktree: MergedWorktree) {
  await git(repo, ["checkout", "-b", worktree.branch]);
  await fs.writeFile(path.join(repo, worktree.fileName), `${worktree.branch}\n`);
  await git(repo, ["add", worktree.fileName]);
  await git(repo, ["commit", "-m", `add ${worktree.fileName}`]);
  await git(repo, ["checkout", "main"]);
  await git(repo, ["merge", "--no-ff", worktree.branch, "-m", `merge ${worktree.branch}`]);
  await git(repo, ["push", "origin", "main"]);
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), worktree.worktreeName);
  await git(repo, ["worktree", "add", worktreePath, worktree.branch]);
  return { worktreePath };
}

test("guardian_done all=true honors allowIgnoredFiles for stale Guardian cleanup", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, ".gitignore"), "ignored-residue/\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "add ignored residue rule"]);
  await git(repo, ["push", "origin", "main"]);
  const staleBranch = "guardian/done-all-ignored-stale-worktree";
  const stale = await createMergedGuardianWorktree(repo, { branch: staleBranch, worktreeName: "done-all-ignored-stale-worktree", fileName: "done-all-ignored-stale-worktree.txt" });
  await fs.mkdir(path.join(stale.worktreePath, "ignored-residue"), { recursive: true });
  await fs.writeFile(path.join(stale.worktreePath, "ignored-residue", "cache.bin"), "ignored residue\n");
  const session = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_all_allow_ignored_cleanup", taskName: "allow ignored cleanup", createWorktree: true, config: DEFAULT_CONFIG });
  await commitInWorktree(session.session.worktree_path, { file: "feat-allow-ignored-cleanup.txt", content: "session work\n", message: "feat allow ignored cleanup" });
  await installMultiBranchFakeGh(t, { repo, remote });

  const plan = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan", allowIgnoredFiles: true }) as LooseRecord;

  assert.equal(plan.ok, true, JSON.stringify(plan));
  const cleanupPlan = plan.cleanupPlan as LooseRecord;
  assert.equal((cleanupPlan.candidates as LooseRecord[]).some((candidate) => candidate.branch === staleBranch), true, JSON.stringify(cleanupPlan));
  assert.equal((cleanupPlan.blockers as LooseRecord[]).some((blocker) => blocker.branch === staleBranch), false, JSON.stringify(cleanupPlan));

  const apply = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "apply", confirm: true, confirmToken: plan.confirmToken, allowIgnoredFiles: true, timestamp: "20260610T121212" }) as LooseRecord;

  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.equal(apply.status, "finished");
  const cleanupSweep = apply.cleanupSweep as LooseRecord;
  assert.equal(cleanupSweep.cleanedCount, 2);
  assert.equal((cleanupSweep.preSession as LooseRecord).cleanedCount, 1);
  assert.equal((cleanupSweep.postSession as LooseRecord).cleanedCount, 1);
  assert.equal(await pathExists(stale.worktreePath), false);
  await assert.rejects(git(repo, ["rev-parse", "--verify", staleBranch]));
});
