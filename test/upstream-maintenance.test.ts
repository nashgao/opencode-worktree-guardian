import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { createSafetyRef, pushBranchNormally } from "../src/git.ts";
import { guardianDone } from "../src/done.ts";
import { syncLocalBase } from "../src/done-main-sync.ts";
import { guardianStart } from "../src/tools.ts";
import { guardianFinishWorkflow } from "../src/workflow.ts";
import { createRepoWithOrigin, createTempDir, git, seedSession } from "./helpers.ts";
import { doneAllCandidateSnapshot, installMultiBranchFakeGh } from "./workflow-test-support.ts";
import { guardianDoneAll } from "../src/done-all.ts";

const execFileAsync = promisify(execFile);
const TRUST_GITLAB_CONFIG = { ...DEFAULT_CONFIG, trustedUpstreamRemotes: ["gitlab"] };

type WorkflowResult = {
  readonly ok: boolean;
  readonly status: string;
  readonly confirmToken?: string;
  readonly preflight: Record<string, unknown>;
  readonly candidates: Array<Record<string, unknown>>;
  readonly results: Array<Record<string, unknown>>;
  readonly remaining: Array<Record<string, unknown>>;
  readonly finalPostflight?: Record<string, unknown>;
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

async function createRepoWithGitlabTrunkUpstream() {
  const { base, repo } = await createRepoWithOrigin();
  const gitlab = path.join(base, "gitlab.git");
  await execFileAsync("git", ["init", "--bare", gitlab]);
  await git(repo, ["remote", "add", "gitlab", gitlab]);
  await git(repo, ["push", "-u", "gitlab", "main:trunk"]);
  await git(repo, ["branch", "--set-upstream-to", "gitlab/trunk", "main"]);
  return { base, repo };
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

test("guardian_done all=true is a no-op when no active feature sessions exist", async (t) => {
  const { base, repo } = await createRepoWithOrigin(); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const result = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan" }) as Record<string, unknown>;
  assert.equal(result.ok, true); assert.equal(result.lane, "done-all"); assert.equal(result.status, "no-op");
});

test("guardian_done all=true finishes a session through a configured slash-containing remote", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await git(repo, ["remote", "rename", "origin", "origin/team"]);
  await git(repo, ["branch", "--unset-upstream", "main"]);
  const config = { ...DEFAULT_CONFIG, remote: "origin/team" };
  const session = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_slash_remote", taskName: "slash remote", createWorktree: true, config });
  await fs.writeFile(path.join(session.session.worktree_path, "slash-remote.txt"), "slash remote\n");
  await git(session.session.worktree_path, ["add", "slash-remote.txt"]);
  await git(session.session.worktree_path, ["commit", "-m", "add slash remote work"]);
  await installMultiBranchFakeGh(t, { repo, remote });

  const plan = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan", config });
  const apply = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "apply", confirm: true, confirmToken: plan.confirmToken, config });

  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.equal(apply.status, "finished");
});

test("guardian_done all=true skips remote refresh until confirmed, then blocks remote base token drift", async (t) => {
  const { base, remote, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/done-all-confirmation-race";
  const candidateFileName = "done-all-confirmation-race.txt";
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, candidateFileName), `${branch}\n`);
  await git(repo, ["add", candidateFileName]);
  await git(repo, ["commit", "-m", `add ${candidateFileName}`]);
  await git(repo, ["checkout", "main"]);
  await git(repo, ["merge", "--no-ff", branch, "-m", `merge ${branch}`]);
  await git(repo, ["push", "origin", "main"]);
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), "done-all-confirmation-race");
  await git(repo, ["worktree", "add", worktreePath, branch]);
  const candidateFile = path.join(worktreePath, candidateFileName);
  const plan = await guardianDoneAll({ repoRoot: repo, cwd: repo, all: true, mode: "plan" }) as Record<string, unknown>;
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(typeof plan.confirmToken, "string");
  const updater = path.join(base, "remote-updater");
  await git(base, ["clone", remote, updater]);
  await git(updater, ["config", "user.email", "test@example.com"]);
  await git(updater, ["config", "user.name", "Test User"]);
  await fs.writeFile(path.join(updater, "done-all-remote-race.txt"), "remote advance\n");
  await git(updater, ["add", "done-all-remote-race.txt"]); await git(updater, ["commit", "-m", "advance remote base"]); await git(updater, ["push", "origin", "main"]);
  const childPlan = { sessions: plan.sessions, cleanupPlan: plan.cleanupPlan };
  const before = await doneAllCandidateSnapshot(repo, branch, worktreePath, candidateFile, childPlan);
  const unconfirmed = await guardianDoneAll({ repoRoot: repo, cwd: repo, all: true, mode: "apply", confirmToken: plan.confirmToken as string }) as Record<string, unknown>;
  assert.equal(unconfirmed.ok, false, JSON.stringify(unconfirmed)); assert.equal(unconfirmed.status, "blocked"); assert.equal(unconfirmed.lane, "done-all"); assert.equal(unconfirmed.confirmationRequired, true); assert.equal(unconfirmed.tokenChecked, false); assert.equal(unconfirmed.remoteRefresh, "skipped"); assert.equal(unconfirmed.nextAction, "guardian_done all=true mode=apply confirm=true"); assert.equal("sessions" in unconfirmed, false); assert.equal("cleanupPlan" in unconfirmed, false); assert.deepEqual(await doneAllCandidateSnapshot(repo, branch, worktreePath, candidateFile, childPlan), before);
  const confirmed = await guardianDoneAll({ repoRoot: repo, cwd: repo, all: true, mode: "apply", confirm: true, confirmToken: plan.confirmToken as string }) as Record<string, unknown>;
  assert.equal(confirmed.ok, false, JSON.stringify(confirmed)); assert.equal(confirmed.status, "blocked"); assert.equal(confirmed.driftDetected, true); assert.equal(confirmed.plannedConfirmToken, plan.confirmToken); assert.equal(typeof confirmed.refreshedConfirmToken, "string"); assert.notEqual(confirmed.refreshedConfirmToken, plan.confirmToken);
  const refreshed = await doneAllCandidateSnapshot(repo, branch, worktreePath, candidateFile, childPlan);
  assert.equal(refreshed.branchOid, before.branchOid); assert.equal(refreshed.worktreeExists, true); assert.equal(refreshed.candidateContent, before.candidateContent); assert.equal(refreshed.state, before.state);
  const refreshedPlan = await guardianDoneAll({ repoRoot: repo, cwd: repo, all: true, mode: "plan" }) as Record<string, unknown>;
  const applied = await guardianDoneAll({ repoRoot: repo, cwd: repo, all: true, mode: "apply", confirm: true, confirmToken: refreshedPlan.confirmToken as string }) as Record<string, unknown>;
  assert.equal(applied.ok, true, JSON.stringify(applied)); assert.equal(await fs.access(worktreePath).then(() => true, () => false), false); await assert.rejects(git(repo, ["rev-parse", "--verify", branch]));
});

test("guardian_finish_workflow retains an allowed branch on the trusted tracked upstream without scanning secondary remotes", async (t) => {
  const { base, repo, gitlab } = await createRepoWithGitlabUpstream();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/upstream-merged";
  const secondaryBranch = "guardian/secondary-unscanned";
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, "upstream-merged.txt"), "merged upstream\n");
  await git(repo, ["add", "upstream-merged.txt"]);
  await git(repo, ["commit", "-m", "add upstream merged branch"]);
  const branchHead = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  await createSafetyRef(repo, { sessionId: "upstream-merged", branch, commit: branchHead, timestamp: "20260610T060606" });
  await git(repo, ["push", "gitlab", branch]);
  await git(repo, ["push", "origin", `main:refs/heads/${secondaryBranch}`]);
  await git(repo, ["checkout", "main"]);
  await mergeBranchToGitlabMain(gitlab, branch);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", config: TRUST_GITLAB_CONFIG, allowedRemoteBranches: [branch] }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.status, "planned");
  assert.equal(plan.preflight.baseRef, "gitlab/main");
  assert.equal(plan.preflight.configuredBaseRef, "origin/main");
  assert.equal(plan.preflight.baseRefSource, "upstream");
  assert.equal(plan.candidates.length, 1);
  assert.deepEqual(plan.candidates.map((candidate) => candidate.targetKind), ["stale-branch"]);
  assert.equal(plan.candidates.every((candidate) => candidate.branch === branch && candidate.head === branchHead), true);
  const scope = plan.finalPostflight?.operationalScope as Record<string, unknown>;
  assert.equal(scope.effectiveRemote, "gitlab");
  assert.deepEqual(scope.unexaminedSecondaryRemotes, ["origin"]);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken, config: TRUST_GITLAB_CONFIG, allowedRemoteBranches: [branch] }));

  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.equal(apply.status, "cleaned");
  assert.equal(apply.results.some((result) => result.branchDeleted === true), true);
  assert.equal(apply.results.some((result) => result.remoteBranchDeleted === true), false);
  await assert.rejects(() => git(repo, ["rev-parse", "--verify", branch]));
  assert.notEqual((await git(repo, ["ls-remote", "--heads", "gitlab", branch])).stdout, "");
  assert.notEqual((await git(repo, ["ls-remote", "--heads", "origin", secondaryBranch])).stdout, "");
});

test("guardian_finish_workflow final postflight keeps local base when trusted upstream branch has a different name", async (t) => {
  const { base, repo } = await createRepoWithGitlabTrunkUpstream();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", config: TRUST_GITLAB_CONFIG }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.status, "planned");
  assert.equal(plan.preflight.baseRef, "gitlab/trunk");
  assert.equal(plan.preflight.effectiveBaseBranch, "trunk");
  assert.equal(plan.preflight.configuredBaseRef, "origin/main");
  assert.equal(plan.finalPostflight?.ok, true, JSON.stringify(plan.finalPostflight));
  assert.equal(plan.finalPostflight?.baseBranch, "main");
  assert.deepEqual(plan.remaining, []);
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
  assert.equal(plan.candidates.length, 2);
  assert.deepEqual(plan.candidates.map((candidate) => candidate.targetKind).sort(), ["remote-branch", "worktree"]);
  assert.equal(plan.candidates.every((candidate) => candidate.branch === branch), true);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken, config: TRUST_GITLAB_CONFIG }));

  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.equal(apply.results.some((result) => result.worktreeRemoved === true), true);
  assert.equal(apply.results.some((result) => result.branchDeleted === true), true);
  assert.equal(apply.results.some((result) => result.remoteBranchDeleted === true), true);
  await assert.rejects(() => git(repo, ["rev-parse", "--verify", branch]));
});

test("normal push configures a fully qualified remote-tracking upstream", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "feature/nested";
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, "feature.txt"), "feature\n");
  await git(repo, ["add", "feature.txt"]);
  await git(repo, ["commit", "-m", "feature upstream"]);
  const head = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  await git(repo, ["branch", "origin/feature/nested", "main"]);

  await pushBranchNormally(repo, "origin", branch, head);

  assert.equal((await git(repo, ["config", `branch.${branch}.remote`])).stdout, "origin");
  assert.equal((await git(repo, ["config", `branch.${branch}.merge`])).stdout, `refs/heads/${branch}`);
  assert.equal((await git(repo, ["rev-parse", `${branch}@{upstream}`])).stdout, head);
});
