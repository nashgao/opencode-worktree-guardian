import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { createSafetyRef } from "../src/git.ts";
import { guardianStart } from "../src/tools.ts";
import { createRepoWithOrigin, git, installFakeGh, installMultiBranchFakeGh } from "./helpers.ts";

type LooseRecord = Record<string, unknown>;

async function pathExists(target: string) {
  return fs.access(target).then(() => true, () => false);
}

async function remoteBranchExists(repo: string, branch: string) {
  const result = await git(repo, ["ls-remote", "--heads", "origin", branch]);
  return result.stdout.length > 0;
}

async function commitInWorktree(worktree: string, file: string, content: string, message: string) {
  await fs.writeFile(path.join(worktree, file), content);
  await git(worktree, ["add", file]);
  await git(worktree, ["commit", "-m", message]);
}

async function createMergedGuardianWorktree(repo: string, branch: string, worktreeName: string, fileName: string) {
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, fileName), `${branch}\n`);
  await git(repo, ["add", fileName]);
  await git(repo, ["commit", "-m", `add ${fileName}`]);
  const head = (await git(repo, ["rev-parse", branch])).stdout;
  await git(repo, ["checkout", "main"]);
  await git(repo, ["merge", "--no-ff", branch, "-m", `merge ${branch}`]);
  await git(repo, ["push", "origin", "main"]);
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), worktreeName);
  await git(repo, ["worktree", "add", worktreePath, branch]);
  return { head, worktreePath };
}

test("guardian_done all=true is a no-op when no active feature sessions exist", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const result = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan" }) as LooseRecord;

  assert.equal(result.ok, true);
  assert.equal(result.lane, "done-all");
  assert.equal(result.status, "no-op");
});

test("guardian_done all=true blocks cleanup-only blockers without an apply token", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "dirty-primary.txt"), "dirty primary\n");

  const plan = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan" }) as LooseRecord;

  assert.equal(plan.ok, false, JSON.stringify(plan));
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.match(plan.reason as string, /cleanup plan has blockers/);
  const cleanupPlan = plan.cleanupPlan as LooseRecord;
  assert.equal(cleanupPlan.ok, false);

  const apply = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "apply", confirm: true, confirmToken: "stale" }) as LooseRecord;

  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(apply.status, "blocked");
  assert.match(apply.reason as string, /cleanup plan has blockers/);
});

test("guardian_done all=true plans every active feature session", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const a = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_all_a", taskName: "all a", createWorktree: true, config: DEFAULT_CONFIG });
  const b = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_all_b", taskName: "all b", createWorktree: true, config: DEFAULT_CONFIG });
  await commitInWorktree(a.session.worktree_path, "feat-a.txt", "a\n", "feat a");
  await commitInWorktree(b.session.worktree_path, "feat-b.txt", "b\n", "feat b");

  const result = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan" }) as LooseRecord;

  assert.equal(result.ok, true);
  assert.equal(result.lane, "done-all");
  assert.equal(result.status, "planned");
  const summary = result.summary as LooseRecord;
  assert.equal(summary.total, 2);
  assert.equal(summary.finishable, 2);
  assert.equal(summary.dirtySkipped, 0);
  assert.equal(typeof result.confirmToken, "string");
  assert.match(result.nextAction as string, /all=true mode=apply confirm=true/);
});

test("guardian_done all=true classifies dirty sessions as skipped", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const a = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_all_clean", taskName: "clean", createWorktree: true, config: DEFAULT_CONFIG });
  const b = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_all_dirty", taskName: "dirty", createWorktree: true, config: DEFAULT_CONFIG });
  await commitInWorktree(a.session.worktree_path, "feat-a.txt", "a\n", "feat a");
  await fs.writeFile(path.join(b.session.worktree_path, "uncommitted.txt"), "dirty\n");

  const result = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan" }) as LooseRecord;

  const summary = result.summary as LooseRecord;
  assert.equal(summary.finishable, 1);
  assert.equal(summary.dirtySkipped, 1);
  const remaining = result.remaining as LooseRecord[];
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].branch, b.session.branch);
  assert.equal(remaining[0].disposition, "dirty-skipped");
});

test("guardian_done all=true apply requires confirm=true", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const a = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_all_confirm", taskName: "confirm", createWorktree: true, config: DEFAULT_CONFIG });
  await commitInWorktree(a.session.worktree_path, "feat-a.txt", "a\n", "feat a");
  const plan = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan" }) as LooseRecord;

  const apply = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "apply", confirmToken: plan.confirmToken }) as LooseRecord;

  assert.equal(apply.ok, false);
  assert.equal(apply.status, "blocked");
  assert.match(apply.reason as string, /confirm=true/);
});

test("guardian_done all=true apply blocks a stale confirm token after a session goes dirty", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const a = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_all_stale", taskName: "stale", createWorktree: true, config: DEFAULT_CONFIG });
  await commitInWorktree(a.session.worktree_path, "feat-a.txt", "a\n", "feat a");
  const plan = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan" }) as LooseRecord;
  await fs.writeFile(path.join(a.session.worktree_path, "late.txt"), "late\n");

  const apply = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "apply", confirm: true, confirmToken: plan.confirmToken }) as LooseRecord;

  assert.equal(apply.ok, false);
  assert.equal(apply.status, "blocked");
  assert.match(apply.reason as string, /confirm token mismatch/);
});

test("guardian_done all=true cleans already-merged sessions without creating a PR", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const session = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_all_already_merged", taskName: "all already merged", createWorktree: true, config: DEFAULT_CONFIG });
  await commitInWorktree(session.session.worktree_path, "feat-already.txt", "already\n", "feat already merged");
  const head = (await git(session.session.worktree_path, ["rev-parse", "HEAD"])).stdout;
  await git(repo, ["merge", "--ff-only", session.session.branch]);
  await git(repo, ["push", "origin", "main"]);
  const fakeGh = await installFakeGh(t, { repo, branch: session.session.branch, head });

  const plan = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan" }) as LooseRecord;
  const apply = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "apply", confirm: true, confirmToken: plan.confirmToken, timestamp: "20260624T121500" }) as LooseRecord;

  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.equal(apply.status, "finished");
  const results = apply.results as LooseRecord[];
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "already-landed-and-cleaned");
  assert.equal(results[0].worktreeRemoved, true);
  assert.equal(results[0].branchDeleted, true);
  const log = await fs.readFile(fakeGh.logPath, "utf8").catch(() => "");
  assert.equal(log, "");
  assert.equal(await pathExists(session.session.worktree_path), false);
  await assert.rejects(git(repo, ["rev-parse", "--verify", `refs/heads/${session.session.branch}`]));
});

test("guardian_done all=true finishes every clean session and fast-forwards local main", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const a = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_all_e2e_a", taskName: "e2e a", createWorktree: true, config: DEFAULT_CONFIG });
  const b = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_all_e2e_b", taskName: "e2e b", createWorktree: true, config: DEFAULT_CONFIG });
  await commitInWorktree(a.session.worktree_path, "feat-a.txt", "a\n", "feat a");
  await commitInWorktree(b.session.worktree_path, "feat-b.txt", "b\n", "feat b");
  const fakeGh = await installMultiBranchFakeGh(t, { repo, remote });

  const plan = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan" }) as LooseRecord;
  const apply = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "apply", confirm: true, confirmToken: plan.confirmToken, timestamp: "20260610T010101" }) as LooseRecord;

  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.equal(apply.status, "finished");
  const results = apply.results as LooseRecord[];
  assert.equal(results.length, 2);
  assert.equal(results.every((entry) => entry.ok === true), true, JSON.stringify(results));
  assert.equal(await pathExists(a.session.worktree_path), false);
  assert.equal(await pathExists(b.session.worktree_path), false);
  const mainSync = apply.mainSync as LooseRecord;
  assert.equal(mainSync.ok, true, JSON.stringify(mainSync));
  assert.equal(mainSync.fastForwarded, true, JSON.stringify(mainSync));
  const localMain = (await git(repo, ["rev-parse", "main"])).stdout;
  const remoteMain = (await git(repo, ["rev-parse", "origin/main"])).stdout;
  assert.equal(localMain, remoteMain);
  const ghLog = await fs.readFile(fakeGh.logPath, "utf8");
  assert.doesNotMatch(ghLog, /--delete-branch/);
});



test("guardian_done all=true applies preplanned cleanup before session merges advance base", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const staleBranch = "guardian/done-all-preexisting-stale";
  await git(repo, ["checkout", "-b", staleBranch]);
  await fs.writeFile(path.join(repo, "done-all-preexisting-stale.txt"), "preexisting stale\n");
  await git(repo, ["add", "done-all-preexisting-stale.txt"]);
  await git(repo, ["commit", "-m", "add preexisting stale"]);
  const staleHead = (await git(repo, ["rev-parse", staleBranch])).stdout;
  await createSafetyRef(repo, { sessionId: "done-all-preexisting-stale", branch: staleBranch, commit: staleHead, timestamp: "20260610T090909" });
  await git(repo, ["checkout", "main"]);
  await git(repo, ["merge", "--no-ff", staleBranch, "-m", "merge preexisting stale"]);
  await git(repo, ["push", "origin", "main"]);

  const session = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_all_with_preexisting_cleanup", taskName: "with preexisting cleanup", createWorktree: true, config: DEFAULT_CONFIG });
  await commitInWorktree(session.session.worktree_path, "feat-preexisting-cleanup.txt", "session work\n", "feat with preexisting cleanup");
  await installMultiBranchFakeGh(t, { repo, remote });

  const plan = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan" }) as LooseRecord;
  const cleanupPlan = plan.cleanupPlan as LooseRecord;
  assert.equal((cleanupPlan.candidates as LooseRecord[]).some((candidate) => candidate.branch === staleBranch), true);

  const apply = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "apply", confirm: true, confirmToken: plan.confirmToken, timestamp: "20260610T101010" }) as LooseRecord;

  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.equal(apply.status, "finished");
  assert.equal((apply.cleanupSweep as LooseRecord).cleanedCount, 1);
  await assert.rejects(git(repo, ["rev-parse", "--verify", staleBranch]));
  assert.equal(await pathExists(session.session.worktree_path), false);
});

test("guardian_done all=true progresses safe sessions and cleanup while reporting stale worktree blockers", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const cleanBranch = "guardian/done-all-clean-stale-worktree";
  const dirtyBranch = "guardian/done-all-dirty-stale-worktree";
  const clean = await createMergedGuardianWorktree(repo, cleanBranch, "done-all-clean-stale-worktree", "done-all-clean-stale-worktree.txt");
  const dirty = await createMergedGuardianWorktree(repo, dirtyBranch, "done-all-dirty-stale-worktree", "done-all-dirty-stale-worktree.txt");
  await fs.writeFile(path.join(dirty.worktreePath, "dirty.txt"), "dirty\n");
  const session = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_all_partial_cleanup", taskName: "partial cleanup", createWorktree: true, config: DEFAULT_CONFIG });
  await commitInWorktree(session.session.worktree_path, "feat-partial-cleanup.txt", "session work\n", "feat partial cleanup");
  await installMultiBranchFakeGh(t, { repo, remote });

  const plan = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan" }) as LooseRecord;

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.status, "planned-partial");
  assert.equal(typeof plan.confirmToken, "string");
  const cleanupPlan = plan.cleanupPlan as LooseRecord;
  assert.equal(cleanupPlan.status, "planned-partial");
  assert.equal(typeof cleanupPlan.confirmToken, "string");
  assert.equal((cleanupPlan.candidates as LooseRecord[]).some((candidate) => candidate.branch === cleanBranch && candidate.head === clean.head), true);
  assert.equal((cleanupPlan.blockers as LooseRecord[]).some((blocker) => blocker.branch === dirtyBranch && blocker.head === dirty.head), true);

  const apply = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "apply", confirm: true, confirmToken: plan.confirmToken, timestamp: "20260610T111111" }) as LooseRecord;

  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(apply.status, "partial");
  const results = apply.results as LooseRecord[];
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true, JSON.stringify(results));
  assert.equal(results[0].worktreeRemoved, true);
  const cleanupSweep = apply.cleanupSweep as LooseRecord;
  assert.equal(cleanupSweep.status, "partial");
  assert.equal(cleanupSweep.cleanedCount, 1);
  assert.equal(cleanupSweep.failedCount, 0);
  const cleanupRemaining = cleanupSweep.remaining as LooseRecord[];
  assert.equal(cleanupRemaining.length, 1);
  assert.equal(cleanupRemaining[0].branch, dirtyBranch);
  assert.match(String(cleanupRemaining[0].reason), /uncommitted changes/);
  assert.equal(await pathExists(session.session.worktree_path), false);
  assert.equal(await pathExists(clean.worktreePath), false);
  await assert.rejects(git(repo, ["rev-parse", "--verify", cleanBranch]));
  assert.equal(await pathExists(dirty.worktreePath), true);
  await git(repo, ["rev-parse", "--verify", dirtyBranch]);
});

test("guardian_done all=true does not clean post-finish candidates absent from plan", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const session = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_all_post_finish_candidate", taskName: "post finish candidate", createWorktree: true, config: DEFAULT_CONFIG });
  await commitInWorktree(session.session.worktree_path, "post-finish-candidate.txt", "post finish candidate\n", "feat post finish candidate");
  const fakeGh = await installMultiBranchFakeGh(t, { repo, remote });

  const plan = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan" }) as LooseRecord;
  const cleanupPlan = plan.cleanupPlan as LooseRecord;
  assert.equal(Array.isArray(cleanupPlan.candidates) ? cleanupPlan.candidates.length : 0, 0);

  const apply = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "apply", confirm: true, confirmToken: plan.confirmToken, timestamp: "20260610T020202" }) as LooseRecord;

  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.equal(apply.status, "finished");
  const cleanupSweep = apply.cleanupSweep as LooseRecord;
  assert.equal(cleanupSweep.status, "no-op");
  assert.equal(cleanupSweep.candidateCount, 0);
  assert.equal(await remoteBranchExists(repo, session.session.branch), true);
  const ghLog = await fs.readFile(fakeGh.logPath, "utf8");
  assert.doesNotMatch(ghLog, /--delete-branch/);
});


test("guardian_done all=true cleans stale branches without active sessions", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const localBranch = "guardian/done-all-local-stale";
  const remoteBranch = "guardian/done-all-remote-stale";
  await git(repo, ["checkout", "-b", localBranch]);
  await fs.writeFile(path.join(repo, "done-all-local-stale.txt"), "local stale\n");
  await git(repo, ["add", "done-all-local-stale.txt"]);
  await git(repo, ["commit", "-m", "add local stale"]);
  const localHead = (await git(repo, ["rev-parse", localBranch])).stdout;
  await createSafetyRef(repo, { sessionId: "done-all-local-stale", branch: localBranch, commit: localHead, timestamp: "20260610T050505" });
  await git(repo, ["checkout", "main"]);
  await git(repo, ["merge", "--no-ff", localBranch, "-m", "merge local stale"]);
  await git(repo, ["push", "origin", "main"]);
  await git(repo, ["checkout", "-b", remoteBranch]);
  await fs.writeFile(path.join(repo, "done-all-remote-stale.txt"), "remote stale\n");
  await git(repo, ["add", "done-all-remote-stale.txt"]);
  await git(repo, ["commit", "-m", "add remote stale"]);
  await git(repo, ["push", "origin", remoteBranch]);
  await git(repo, ["checkout", "main"]);
  await git(repo, ["merge", "--no-ff", remoteBranch, "-m", "merge remote stale"]);
  await git(repo, ["push", "origin", "main"]);
  await git(repo, ["branch", "-d", remoteBranch]);
  await git(repo, ["fetch", "origin"]);

  const plan = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan" }) as LooseRecord;

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.status, "planned");
  assert.equal((plan.summary as LooseRecord).total, 0);
  const cleanupPlan = plan.cleanupPlan as LooseRecord;
  assert.equal((cleanupPlan.candidates as LooseRecord[]).length, 2);

  const apply = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "apply", confirm: true, confirmToken: plan.confirmToken }) as LooseRecord;

  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.equal(apply.status, "finished");
  const cleanupSweep = apply.cleanupSweep as LooseRecord;
  assert.equal(cleanupSweep.status, "cleaned");
  assert.equal(cleanupSweep.cleanedCount, 2);
  await assert.rejects(git(repo, ["rev-parse", "--verify", localBranch]));
  assert.equal(await remoteBranchExists(repo, remoteBranch), false);
});


test("guardian_done all=true apply blocks cleanup candidates added after plan", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/done-all-token-drift";

  const plan = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan" }) as LooseRecord;

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.status, "no-op");
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, "done-all-token-drift.txt"), "token drift\n");
  await git(repo, ["add", "done-all-token-drift.txt"]);
  await git(repo, ["commit", "-m", "add done-all token drift"]);
  const head = (await git(repo, ["rev-parse", branch])).stdout;
  await git(repo, ["checkout", "main"]);
  await git(repo, ["merge", "--no-ff", branch, "-m", "merge done-all token drift"]);
  await git(repo, ["push", "origin", "main"]);
  await createSafetyRef(repo, { sessionId: "done-all-token-drift", branch, commit: head, timestamp: "20260610T101010" });

  const apply = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "apply", confirm: true, confirmToken: plan.confirmToken }) as LooseRecord;

  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(apply.status, "blocked");
  assert.match(apply.reason as string, /confirm token mismatch/);
  assert.equal(await pathExists(path.join(repo, ".git")), true);
  await git(repo, ["rev-parse", "--verify", branch]);
});
