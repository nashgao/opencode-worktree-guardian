import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { createSafetyRef } from "../src/git.ts";
import { syncLocalBase } from "../src/done-main-sync.ts";
import { guardianFinishWorkflow } from "../src/workflow.ts";
import { createRepoWithOrigin, createTempDir, git, seedSession } from "./helpers.ts";

const execFileAsync = promisify(execFile);
const TRUST_GITLAB_CONFIG = { ...DEFAULT_CONFIG, trustedUpstreamRemotes: ["gitlab"] };

type WorkflowResult = {
  readonly ok: boolean;
  readonly status: string;
  readonly confirmToken?: string;
  readonly preflight: Record<string, unknown>;
  readonly candidates: Array<Record<string, unknown>>;
  readonly results: Array<Record<string, unknown>>;
};

async function createRepoWithGitlabUpstream() {
  const { base, repo } = await createRepoWithOrigin();
  const gitlab = path.join(base, "gitlab.git");
  await execFileAsync("git", ["init", "--bare", gitlab]);
  await git(repo, ["remote", "add", "gitlab", gitlab]);
  await git(repo, ["push", "-u", "gitlab", "main"]);
  await git(repo, ["branch", "--set-upstream-to", "gitlab/main", "main"]);
  return { base, repo, gitlab };
}

async function clonePublisher(remote: string) {
  const clone = await createTempDir("guardian-upstream-publisher-");
  await execFileAsync("git", ["clone", "--quiet", remote, clone]);
  await git(clone, ["config", "user.email", "guardian@example.test"]);
  await git(clone, ["config", "user.name", "Guardian Test"]);
  return clone;
}

async function advanceGitlabMain(remote: string, fileName: string) {
  const publisher = await clonePublisher(remote);
  await fs.writeFile(path.join(publisher, fileName), `${fileName}\n`);
  await git(publisher, ["add", fileName]);
  await git(publisher, ["commit", "-m", `advance ${fileName}`]);
  await git(publisher, ["push", "origin", "main"]);
  return (await git(publisher, ["rev-parse", "HEAD"])).stdout;
}

async function mergeBranchToGitlabMain(remote: string, branch: string) {
  const publisher = await clonePublisher(remote);
  await git(publisher, ["fetch", "origin", `${branch}:${branch}`]);
  await git(publisher, ["checkout", "main"]);
  await git(publisher, ["merge", "--no-ff", `origin/${branch}`, "-m", `merge ${branch}`]);
  await git(publisher, ["push", "origin", "main"]);
}

function workflowResult(result: Record<string, unknown>): WorkflowResult {
  return result as WorkflowResult;
}

test("syncLocalBase fast-forwards main from its tracked upstream instead of configured remote", async (t) => {
  const { base, repo, gitlab } = await createRepoWithGitlabUpstream();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const upstreamHead = await advanceGitlabMain(gitlab, "gitlab-only.txt");

  const result = await syncLocalBase(repo, TRUST_GITLAB_CONFIG);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.baseRef, "gitlab/main");
  assert.equal(result.configuredBaseRef, "origin/main");
  assert.equal(result.baseRefSource, "upstream");
  assert.equal(result.fastForwarded, true);
  assert.equal((await git(repo, ["rev-parse", "main"])).stdout, upstreamHead);
  assert.notEqual((await git(repo, ["rev-parse", "origin/main"])).stdout, upstreamHead);
});

test("guardian_finish_workflow cleans local branches merged to tracked upstream", async (t) => {
  const { base, repo, gitlab } = await createRepoWithGitlabUpstream();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/upstream-merged";
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, "upstream-merged.txt"), "merged upstream\n");
  await git(repo, ["add", "upstream-merged.txt"]);
  await git(repo, ["commit", "-m", "add upstream merged branch"]);
  const branchHead = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  await createSafetyRef(repo, { sessionId: "upstream-merged", branch, commit: branchHead, timestamp: "20260610T060606" });
  await git(repo, ["push", "gitlab", branch]);
  await git(repo, ["checkout", "main"]);
  await mergeBranchToGitlabMain(gitlab, branch);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", config: TRUST_GITLAB_CONFIG }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.status, "planned");
  assert.equal(plan.preflight.baseRef, "gitlab/main");
  assert.equal(plan.preflight.configuredBaseRef, "origin/main");
  assert.equal(plan.preflight.baseRefSource, "upstream");
  assert.equal(plan.candidates.length, 2);
  assert.deepEqual(plan.candidates.map((candidate) => candidate.targetKind).sort(), ["remote-branch", "stale-branch"]);
  assert.equal(plan.candidates.every((candidate) => candidate.branch === branch && candidate.head === branchHead), true);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirmToken: plan.confirmToken, config: TRUST_GITLAB_CONFIG }));

  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.equal(apply.status, "cleaned");
  assert.equal(apply.results.some((result) => result.branchDeleted === true), true);
  assert.equal(apply.results.some((result) => result.remoteBranchDeleted === true), true);
  await assert.rejects(() => git(repo, ["rev-parse", "--verify", branch]));
});


test("syncLocalBase blocks untrusted tracked upstream before fetch", async (t) => {
  const { base, repo, gitlab } = await createRepoWithGitlabUpstream();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await advanceGitlabMain(gitlab, "untrusted.txt");

  await assert.rejects(() => syncLocalBase(repo, DEFAULT_CONFIG), /Untrusted upstream remote gitlab/);
});

test("guardian_finish_workflow cleans recorded worktrees using trusted effective upstream despite stale session base_ref", async (t) => {
  const { base, repo, gitlab } = await createRepoWithGitlabUpstream();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/recorded-upstream-merged";
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, "recorded-upstream.txt"), "merged recorded upstream\n");
  await git(repo, ["add", "recorded-upstream.txt"]);
  await git(repo, ["commit", "-m", "add recorded upstream branch"]);
  const branchHead = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  await git(repo, ["push", "gitlab", branch]);
  await git(repo, ["checkout", "main"]);
  const worktree = path.join(repo, ".worktrees", path.basename(repo), "guardian-recorded-upstream-merged");
  await fs.mkdir(path.dirname(worktree), { recursive: true });
  await git(repo, ["worktree", "add", worktree, branch]);
  await mergeBranchToGitlabMain(gitlab, branch);
  await seedSession(repo, {
    session_id: "ses_recorded_upstream",
    status: "active",
    branch,
    worktree_path: worktree,
    base_ref: "origin/main",
    head_commit: branchHead,
  }, TRUST_GITLAB_CONFIG);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", config: TRUST_GITLAB_CONFIG }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].branch, branch);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirmToken: plan.confirmToken, config: TRUST_GITLAB_CONFIG }));

  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.equal(apply.results[0].worktreeRemoved, true);
  assert.equal(apply.results[0].branchDeleted, true);
  await assert.rejects(() => git(repo, ["rev-parse", "--verify", branch]));
});
