import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { guardianFinishWorkflow } from "../src/workflow.ts";
import { createRepoWithOrigin, createTempDir, git } from "./helpers.ts";

type WorkflowResult = {
  readonly ok: boolean;
  readonly status: string;
  readonly reason?: string;
  readonly confirmToken?: string;
  readonly candidates: readonly Record<string, unknown>[];
  readonly results: readonly Record<string, unknown>[];
  readonly remaining: readonly Record<string, unknown>[];
  readonly baseSync?: Record<string, unknown>;
};

function workflowResult(result: Record<string, unknown>): WorkflowResult {
  return result as WorkflowResult;
}

async function createMergedRemoteBranch(repo: string, branch: string) {
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, "remote-diverged-cleanup.txt"), `${branch}\n`);
  await git(repo, ["add", "remote-diverged-cleanup.txt"]);
  await git(repo, ["commit", "-m", "add remote cleanup branch"]);
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["checkout", "main"]);
  await git(repo, ["merge", "--no-ff", branch, "-m", "merge remote cleanup branch"]);
  await git(repo, ["push", "origin", "main"]);
  await git(repo, ["branch", "-d", branch]);
  await git(repo, ["fetch", "origin"]);
}

async function createLocalBranchMergedOnlyOnRemote(repo: string, remote: string, branch: string) {
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, "local-branch-remote-merged.txt"), `${branch}\n`);
  await git(repo, ["add", "local-branch-remote-merged.txt"]);
  await git(repo, ["commit", "-m", "add local branch merged on remote"]);
  await git(repo, ["push", "origin", branch]);
  const { stdout: head } = await git(repo, ["rev-parse", branch]);
  await git(repo, ["checkout", "main"]);
  const merger = await createTempDir("guardian-local-branch-merger-");
  await git(path.dirname(remote), ["clone", remote, merger]);
  await git(merger, ["config", "user.email", "guardian@example.test"]);
  await git(merger, ["config", "user.name", "Guardian Test"]);
  await git(merger, ["merge", "--no-ff", `origin/${branch}`, "-m", "merge local branch on remote"]);
  await git(merger, ["push", "origin", "main"]);
  await git(repo, ["fetch", "origin"]);
  return head;
}

async function divergeLocalAndRemoteMain(repo: string, remote: string) {
  await fs.writeFile(path.join(repo, "local-main-only.txt"), "local only\n");
  await git(repo, ["add", "local-main-only.txt"]);
  await git(repo, ["commit", "-m", "local main only"]);
  const updater = await createTempDir("guardian-remote-main-updater-");
  await git(path.dirname(remote), ["clone", remote, updater]);
  await git(updater, ["config", "user.email", "guardian@example.test"]);
  await git(updater, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(updater, "remote-main-only.txt"), "remote only\n");
  await git(updater, ["add", "remote-main-only.txt"]);
  await git(updater, ["commit", "-m", "remote main only"]);
  await git(updater, ["push", "origin", "main"]);
}

async function remoteBranchExists(repo: string, branch: string) {
  const result = await git(repo, ["ls-remote", "--heads", "origin", branch]);
  return result.stdout.length > 0;
}

function pathExists(filePath: string) {
  return fs.access(filePath).then(() => true, () => false);
}

test("guardian_finish_workflow cleans safe remote branches when local main diverged", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-diverged-base-remote";
  await createMergedRemoteBranch(repo, branch);
  await divergeLocalAndRemoteMain(repo, remote);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.candidates.some((candidate) => candidate.branch === branch), true);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirmToken: plan.confirmToken }));

  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(apply.status, "partial");
  assert.equal(apply.results.some((result) => result.branch === branch && result.remoteBranchDeleted === true), true, JSON.stringify(apply.results));
  assert.equal(apply.remaining.some((entry) => entry.kind === "base-sync"), true, JSON.stringify(apply.remaining));
  assert.equal(apply.baseSync?.ok, false);
  assert.equal(await remoteBranchExists(repo, branch), false);
});

test("guardian_finish_workflow cleans safe local branches when local main diverged", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-diverged-base-local";
  const head = await createLocalBranchMergedOnlyOnRemote(repo, remote, branch);
  await divergeLocalAndRemoteMain(repo, remote);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.candidates.some((candidate) => candidate.branch === branch && candidate.head === head), true, JSON.stringify(plan.candidates));

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirmToken: plan.confirmToken }));

  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(apply.status, "partial");
  assert.equal(apply.results.some((result) => result.branch === branch && result.branchDeleted === true), true, JSON.stringify(apply.results));
  assert.equal(apply.remaining.some((entry) => entry.kind === "base-sync"), true, JSON.stringify(apply.remaining));
  assert.equal(apply.baseSync?.ok, false);
  await assert.rejects(() => git(repo, ["rev-parse", "--verify", branch]));
});

test("guardian_finish_workflow cleans safe worktrees when local main diverged", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-diverged-base-worktree";
  const head = await createLocalBranchMergedOnlyOnRemote(repo, remote, branch);
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), "workflow-diverged-base-worktree");
  await git(repo, ["worktree", "add", worktreePath, branch]);
  await divergeLocalAndRemoteMain(repo, remote);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.candidates.some((candidate) => candidate.branch === branch && candidate.head === head), true, JSON.stringify(plan.candidates));

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirmToken: plan.confirmToken }));

  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(apply.status, "partial");
  assert.equal(apply.results.some((result) => result.branch === branch && result.worktreeRemoved === true && result.branchDeleted === true), true, JSON.stringify(apply.results));
  assert.equal(apply.remaining.some((entry) => entry.kind === "base-sync"), true, JSON.stringify(apply.remaining));
  assert.equal(apply.baseSync?.ok, false);
  assert.equal(await pathExists(worktreePath), false);
  await assert.rejects(() => git(repo, ["rev-parse", "--verify", branch]));
});
