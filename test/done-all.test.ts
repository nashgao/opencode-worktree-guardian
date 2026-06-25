import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { guardianStart } from "../src/tools.ts";
import { createRepoWithOrigin, git, installFakeGh, installMultiBranchFakeGh } from "./helpers.ts";

type LooseRecord = Record<string, unknown>;

async function pathExists(target: string) {
  return fs.access(target).then(() => true, () => false);
}

async function commitInWorktree(worktree: string, file: string, content: string, message: string) {
  await fs.writeFile(path.join(worktree, file), content);
  await git(worktree, ["add", file]);
  await git(worktree, ["commit", "-m", message]);
}

test("guardian_done all=true is a no-op when no active feature sessions exist", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const result = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan" }) as LooseRecord;

  assert.equal(result.ok, true);
  assert.equal(result.lane, "done-all");
  assert.equal(result.status, "no-op");
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
  await installMultiBranchFakeGh(t, { repo, remote });

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
});
