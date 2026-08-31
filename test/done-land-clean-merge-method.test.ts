import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { guardianDone } from "../src/done.ts";
import { guardianStart } from "../src/start.ts";
import { isRecordLike } from "../src/types.ts";
import { installFakeGh } from "./delete-fixtures.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (isRecordLike(value)) return value;
  throw new TypeError(name + " must be an object");
}

function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(name + " must be a non-empty string");
}

test("guardian_done squash-lands the approved tree when merge commits are disabled", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({ pullRequestMergeMethod: "squash" }));
  await git(repo, ["add", ".opencode/worktree-guardian.json"]);
  await git(repo, ["commit", "-m", "configure squash pull request landing"]);
  await git(repo, ["push", "origin", "main"]);
  await git(repo, ["config", "fetch.prune", "true"]);
  const sessionId = "land-clean-squash-session";
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "squash land clean", createWorktree: true });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");
  await fs.writeFile(path.join(worktree, "feature.txt"), "squash landed by guardian_done\n", "utf8");
  await git(worktree, ["add", "feature.txt"]);
  await git(worktree, ["commit", "-m", "add squash landing fixture"]);
  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  const approvedTree = (await git(worktree, ["show", "-s", "--format=%T", head])).stdout;
  const fakeGh = await installFakeGh(t, { repo, branch, head, mergeMethod: "squash", autoDeleteBranch: true });
  const request = { repoRoot: repo, cwd: worktree, sessionId };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");

  // When
  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });

  // Then
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "landed-and-cleaned");
  assert.equal(result.pullRequestMergeMethod, "squash");
  assert.equal(result.worktreeRemoved, true);
  assert.equal(result.branchDeleted, true);
  const cleanup = requireRecord(result.cleanup, "result.cleanup");
  assert.equal(cleanup.remoteBranchDeleted, false);
  assert.equal(cleanup.remoteBranchReconciled, true);
  const log = await fs.readFile(fakeGh.logPath, "utf8");
  assert.match(log, /pr merge .* --squash /);
  assert.doesNotMatch(log, / --merge /);
  await git(repo, ["fetch", "origin", "main"]);
  await assert.rejects(git(repo, ["merge-base", "--is-ancestor", head, "origin/main"]));
  assert.equal((await git(repo, ["show", "-s", "--format=%T", "origin/main"])).stdout, approvedTree);
  assert.equal((await git(repo, ["ls-remote", "--heads", "origin", branch])).stdout, "");
  await assert.rejects(git(repo, ["rev-parse", "--verify", "refs/heads/" + branch]));
});

test("guardian_done all=true completes final postflight after a squash landing", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({ pullRequestMergeMethod: "squash" }));
  await git(repo, ["add", ".opencode/worktree-guardian.json"]);
  await git(repo, ["commit", "-m", "configure squash pull request landing"]);
  await git(repo, ["push", "origin", "main"]);
  const sessionId = "done-all-squash-session";
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "batch squash land clean", createWorktree: true });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");
  await fs.writeFile(path.join(worktree, "batch-feature.txt"), "squash landed by guardian_done all\n", "utf8");
  await git(worktree, ["add", "batch-feature.txt"]);
  await git(worktree, ["commit", "-m", "add batch squash landing fixture"]);
  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  const approvedTree = (await git(worktree, ["show", "-s", "--format=%T", head])).stdout;
  await installFakeGh(t, { repo, branch, head, mergeMethod: "squash" });
  const request = { repoRoot: repo, cwd: repo, all: true };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");

  // When
  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });

  // Then
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "finished");
  const results = result.results;
  assert.equal(Array.isArray(results), true);
  const child = requireRecord((results as unknown[])[0], "result.results[0]");
  assert.equal(child.ok, true, JSON.stringify(child));
  const landedCommit = requireString(child.landedCommit, "result.results[0].landedCommit");
  await git(repo, ["fetch", "origin", "main"]);
  assert.equal(landedCommit, (await git(repo, ["rev-parse", "origin/main"])).stdout);
  await assert.rejects(git(repo, ["merge-base", "--is-ancestor", head, "origin/main"]));
  assert.equal((await git(repo, ["show", "-s", "--format=%T", "origin/main"])).stdout, approvedTree);
});

test("guardian_done refuses a fast-forward result when squash was requested", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({ pullRequestMergeMethod: "squash" }));
  await git(repo, ["add", ".opencode/worktree-guardian.json"]);
  await git(repo, ["commit", "-m", "configure squash pull request landing"]);
  await git(repo, ["push", "origin", "main"]);
  const sessionId = "land-clean-squash-fast-forward";
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "reject squash fast-forward", createWorktree: true });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");
  await fs.writeFile(path.join(worktree, "fast-forward.txt"), "fast-forward instead of squash\n", "utf8");
  await git(worktree, ["add", "fast-forward.txt"]);
  await git(worktree, ["commit", "-m", "add fast-forward mismatch fixture"]);
  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  const fakeGh = await installFakeGh(t, { repo, branch, head, mergeMethod: "squash", resultMethod: "merge" });
  const request = { repoRoot: repo, cwd: worktree, sessionId };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");

  // When
  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });

  // Then
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.match(String(result.reason), /outside the approved topology/);
  assert.equal(await fs.access(worktree).then(() => true, () => false), true);
  assert.equal((await git(repo, ["rev-parse", "refs/heads/" + branch])).stdout, head);
  assert.equal((await git(repo, ["rev-parse", "origin/main"])).stdout, head);
  assert.match(await fs.readFile(fakeGh.logPath, "utf8"), /pr merge .* --squash /);
});

test("guardian_done recovers cleanup after an already-completed squash landing", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({ pullRequestMergeMethod: "squash" }));
  await git(repo, ["add", ".opencode/worktree-guardian.json"]);
  await git(repo, ["commit", "-m", "configure squash pull request landing"]);
  await git(repo, ["push", "origin", "main"]);
  const sessionId = "land-clean-squash-recovery";
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "recover squash cleanup", createWorktree: true });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");
  await fs.writeFile(path.join(worktree, "feature.txt"), "squash recovery proof\n", "utf8");
  await git(worktree, ["add", "feature.txt"]);
  await git(worktree, ["commit", "-m", "add squash recovery fixture"]);
  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  const approvedTree = (await git(worktree, ["show", "-s", "--format=%T", head])).stdout;
  await git(worktree, ["push", "origin", branch]);
  await git(repo, ["merge", "--squash", branch]);
  await git(repo, ["commit", "-m", "squash merged before cleanup"]);
  await git(repo, ["push", "origin", "main"]);
  const request = { repoRoot: repo, cwd: worktree, sessionId };

  // When
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");
  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });

  // Then
  assert.equal(plan.action, "already-landed-clean");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "already-landed-and-cleaned");
  assert.equal(result.pullRequestMergeMethod, "squash");
  await git(repo, ["fetch", "origin", "main"]);
  await assert.rejects(git(repo, ["merge-base", "--is-ancestor", head, "origin/main"]));
  assert.equal((await git(repo, ["show", "-s", "--format=%T", "origin/main"])).stdout, approvedTree);
  assert.equal((await git(repo, ["ls-remote", "--heads", "origin", branch])).stdout, "");
  await assert.rejects(git(repo, ["rev-parse", "--verify", "refs/heads/" + branch]));
});

test("guardian_done refuses already-landed squash cleanup when the base parent was not the session start", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({ pullRequestMergeMethod: "squash" }));
  await git(repo, ["add", ".opencode/worktree-guardian.json"]);
  await git(repo, ["commit", "-m", "configure squash pull request landing"]);
  await git(repo, ["push", "origin", "main"]);
  const sessionId = "land-clean-squash-wrong-parent";
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "reject wrong squash parent", createWorktree: true });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");
  await fs.writeFile(path.join(worktree, "feature.txt"), "wrong-parent candidate tree\n", "utf8");
  await git(worktree, ["add", "feature.txt"]);
  await git(worktree, ["commit", "-m", "add wrong-parent candidate"]);
  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  await git(worktree, ["push", "origin", branch]);
  await fs.writeFile(path.join(repo, "unapproved-parent.txt"), "unapproved parent\n", "utf8");
  await git(repo, ["add", "unapproved-parent.txt"]);
  await git(repo, ["commit", "-m", "advance base outside the approved session start"]);
  await git(repo, ["read-tree", "--reset", "-u", head]);
  await git(repo, ["commit", "-m", "copy candidate tree onto wrong parent"]);
  await git(repo, ["push", "origin", "main"]);

  // When
  const plan = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "plan" });

  // Then
  assert.equal(plan.ok, false, JSON.stringify(plan));
  assert.equal(plan.status, "blocked");
  assert.match(String(plan.reason), /fresh remote base is not an ancestor/);
  assert.equal(await fs.access(worktree).then(() => true, () => false), true);
  assert.equal((await git(repo, ["rev-parse", "--verify", "refs/heads/" + branch])).stdout, head);
});

test("guardian_done rotates a completed dirty-commit safety ref for follow-up review changes", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({ pullRequestMergeMethod: "squash" }));
  await git(repo, ["add", ".opencode/worktree-guardian.json"]);
  await git(repo, ["commit", "-m", "configure squash pull request landing"]);
  await git(repo, ["push", "origin", "main"]);
  const sessionId = "land-clean-follow-up-review";
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "follow-up review", createWorktree: true });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");
  await fs.writeFile(path.join(worktree, "review-one.txt"), "first review change\n", "utf8");
  await installFakeGh(t, { repo, branch, dynamicHead: true, existingPr: true, mergeFails: true, mergeMethod: "squash" });
  const request = { repoRoot: repo, cwd: worktree, sessionId, commitMessage: "fix: address review", timestamp: "2026-08-31T03:00:00.000Z" };
  const originalHead = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  const firstPlan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "firstPlan");
  const firstSafetyRef = requireString(firstPlan.safetyRef, "firstPlan.safetyRef");
  const first = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(firstPlan.confirmToken, "firstPlan.confirmToken") });

  assert.equal(first.ok, false, JSON.stringify(first));
  assert.equal(first.status, "waiting");
  const firstCommit = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  assert.notEqual(firstCommit, originalHead);
  assert.equal((await git(repo, ["rev-parse", firstSafetyRef])).stdout, originalHead);
  await fs.writeFile(path.join(worktree, "review-two.txt"), "second review change\n", "utf8");

  // When
  const secondPlan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "secondPlan");
  const secondSafetyRef = requireString(secondPlan.safetyRef, "secondPlan.safetyRef");

  // Then
  assert.notEqual(secondSafetyRef, firstSafetyRef);
  const second = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(secondPlan.confirmToken, "secondPlan.confirmToken") });
  assert.equal(second.ok, false, JSON.stringify(second));
  assert.equal(second.status, "waiting");
  assert.equal((await git(repo, ["rev-parse", secondSafetyRef])).stdout, firstCommit);
  assert.notEqual((await git(worktree, ["rev-parse", "HEAD"])).stdout, firstCommit);
});
