import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianFinishWorkflow } from "../src/workflow.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

type WorkflowResult = {
  ok: boolean;
  status: string;
  reason?: string;
  confirmToken?: string;
  preflight: { candidateCount?: number; dirtyFileCount?: number; blockerCount?: number; baseRefOid?: string; maxCandidateCount?: number };
  candidates: Array<Record<string, unknown>>;
  blockers: Array<Record<string, unknown>>;
  results: Array<Record<string, unknown>>;
};

function workflowResult(result: Record<string, unknown>): WorkflowResult {
  return result as WorkflowResult;
}

async function createMergedBranch(repo: string, branch: string, fileName: string) {
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, fileName), `${branch}\n`);
  await git(repo, ["add", fileName]);
  await git(repo, ["commit", "-m", `add ${fileName}`]);
  await git(repo, ["checkout", "main"]);
  await git(repo, ["merge", "--no-ff", branch, "-m", `merge ${branch}`]);
  await git(repo, ["push", "origin", "main"]);
  const { stdout: head } = await git(repo, ["rev-parse", branch]);
  return head;
}

async function createUnmergedBranch(repo: string, branch: string, fileName: string) {
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, fileName), `${branch}\n`);
  await git(repo, ["add", fileName]);
  await git(repo, ["commit", "-m", `add ${fileName}`]);
  const { stdout: head } = await git(repo, ["rev-parse", branch]);
  await git(repo, ["checkout", "main"]);
  return head;
}

function branchExists(repo: string, branch: string) {
  return git(repo, ["rev-parse", "--verify", branch]).then(() => true, () => false);
}

function pathExists(filePath: string) {
  return fs.access(filePath).then(() => true, () => false);
}

test("guardian_finish_workflow plans and applies merged Guardian worktree cleanup", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-worktree";
  const head = await createMergedBranch(repo, branch, "workflow-worktree.txt");
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), "workflow-worktree");
  await git(repo, ["worktree", "add", worktreePath, branch]);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(typeof plan.confirmToken, "string");
  assert.equal(plan.preflight.candidateCount, 1);
  assert.deepEqual(plan.candidates.map((candidate: Record<string, unknown>) => candidate.kind), ["worktree"]);
  assert.equal(plan.candidates[0].branch, branch);
  assert.equal(plan.candidates[0].head, head);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirmToken: plan.confirmToken }));

  assert.equal(apply.ok, true);
  assert.equal(apply.status, "cleaned");
  assert.equal(apply.results.length, 1);
  assert.equal(apply.results[0].worktreeRemoved, true);
  assert.equal(apply.results[0].branchDeleted, true);
  await assert.rejects(() => fs.access(worktreePath));
  await assert.rejects(() => git(repo, ["rev-parse", "--verify", branch]));
});

test("guardian_finish_workflow plans and applies merged local branch cleanup", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "feature/workflow-merged-branch";
  const head = await createMergedBranch(repo, branch, "workflow-branch.txt");

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.preflight.candidateCount, 1);
  assert.deepEqual(plan.candidates.map((candidate: Record<string, unknown>) => candidate.kind), ["branch"]);
  assert.equal(plan.candidates[0].targetKind, "merged-branch");
  assert.equal(plan.candidates[0].branch, branch);
  assert.equal(plan.candidates[0].head, head);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirmToken: plan.confirmToken }));

  assert.equal(apply.ok, true);
  assert.equal(apply.status, "cleaned");
  assert.equal(apply.results.length, 1);
  assert.equal(apply.results[0].branchDeleted, true);
  await assert.rejects(() => git(repo, ["rev-parse", "--verify", branch]));
});

test("guardian_finish_workflow blocks dirty primary worktrees before cleanup", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "dirty.txt"), "dirty\n");

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.match(String(plan.reason), /primary worktree has uncommitted changes/);
  assert.equal(plan.preflight.dirtyFileCount, 1);
});

test("guardian_finish_workflow plans cleanly when no cleanup candidates exist", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(typeof plan.confirmToken, "string");
  assert.equal(typeof plan.preflight.baseRefOid, "string");
  assert.equal(plan.preflight.candidateCount, 0);
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.blockers, []);
});

test("guardian_finish_workflow blocks when stash inventory exists", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "stashed.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "workflow stash"]);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.match(String(plan.reason), /stash inventory/);
});

test("guardian_finish_workflow blocks stale workflow tokens after base ref advances", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-stale-base";
  await createMergedBranch(repo, branch, "workflow-stale-base.txt");
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), "workflow-stale-base");
  await git(repo, ["worktree", "add", worktreePath, branch]);
  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));
  assert.equal(plan.ok, true);
  const originalBaseRefOid = plan.preflight.baseRefOid;
  await fs.writeFile(path.join(repo, "base-advance.txt"), "advance\n");
  await git(repo, ["add", "base-advance.txt"]);
  await git(repo, ["commit", "-m", "advance base"]);
  await git(repo, ["push", "origin", "main"]);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirmToken: plan.confirmToken }));

  assert.equal(apply.ok, false);
  assert.equal(apply.status, "blocked");
  assert.match(String(apply.reason), /confirm token mismatch/);
  assert.notEqual(apply.preflight.baseRefOid, originalBaseRefOid);
  assert.equal(await pathExists(worktreePath), true);
  assert.equal(await branchExists(repo, branch), true);
});

test("guardian_finish_workflow blocks dirty Guardian-root candidates and deletes nothing", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const cleanBranch = "guardian/workflow-clean-candidate";
  const dirtyBranch = "guardian/workflow-dirty-candidate";
  await createMergedBranch(repo, cleanBranch, "workflow-clean-candidate.txt");
  await createMergedBranch(repo, dirtyBranch, "workflow-dirty-candidate.txt");
  const cleanPath = path.join(repo, ".worktrees", path.basename(repo), "workflow-clean-candidate");
  const dirtyPath = path.join(repo, ".worktrees", path.basename(repo), "workflow-dirty-candidate");
  await git(repo, ["worktree", "add", cleanPath, cleanBranch]);
  await git(repo, ["worktree", "add", dirtyPath, dirtyBranch]);
  await fs.writeFile(path.join(dirtyPath, "dirty.txt"), "dirty\n");

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.blockers.length, 1);
  assert.match(String(plan.blockers[0].reason), /uncommitted changes/);
  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirmToken: "stale" }));
  assert.equal(apply.ok, false);
  assert.equal(await pathExists(cleanPath), true);
  assert.equal(await branchExists(repo, cleanBranch), true);
});

test("guardian_finish_workflow reports unmerged Guardian-root candidates as blockers", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-unmerged-candidate";
  const head = await createUnmergedBranch(repo, branch, "workflow-unmerged-candidate.txt");
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), "workflow-unmerged-candidate");
  await git(repo, ["worktree", "add", worktreePath, branch]);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.blockers[0].head, head);
  assert.match(String(plan.blockers[0].reason), /not proven reachable/);
});

test("guardian_finish_workflow reports protected branch worktrees as blockers", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "release/workflow-protected";
  await createMergedBranch(repo, branch, "workflow-protected.txt");
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), "workflow-protected");
  await git(repo, ["worktree", "add", worktreePath, branch]);
  const config = { ...DEFAULT_CONFIG, protectedBranches: [...DEFAULT_CONFIG.protectedBranches, branch] };

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", config }));

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.candidates.length, 0);
  assert.match(String(plan.blockers[0].reason), /protected branch/);
});

test("guardian_finish_workflow reports detached Guardian-root worktrees as blockers", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), "workflow-detached");
  await git(repo, ["worktree", "add", "--detach", worktreePath, "main"]);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.candidates.length, 0);
  assert.match(String(plan.blockers[0].reason), /detached Guardian worktree/);
});

test("guardian_finish_workflow blocks mismatched confirm tokens", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-token-mismatch";
  await createMergedBranch(repo, branch, "workflow-token-mismatch.txt");
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), "workflow-token-mismatch");
  await git(repo, ["worktree", "add", worktreePath, branch]);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirmToken: "not-the-token" }));

  assert.equal(apply.ok, false);
  assert.equal(apply.status, "blocked");
  assert.match(String(apply.reason), /confirm token mismatch/);
  assert.equal(await pathExists(worktreePath), true);
  assert.equal(await branchExists(repo, branch), true);
});

test("guardian_finish_workflow blocks cleanup batches over the candidate bound", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  for (let index = 0; index < 26; index += 1) {
    await git(repo, ["branch", `feature/workflow-bound-${index}`, "main"]);
  }

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.preflight.maxCandidateCount, 25);
  assert.equal(plan.preflight.candidateCount, 26);
  assert.match(String(plan.blockers[0].reason), /candidate count exceeds maximum/);
});

test("guardian_finish_workflow blocks merged worktrees with ignored files unless allowIgnoredFiles is set", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, ".gitignore"), "ignored-residue/\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "add gitignore"]);
  await git(repo, ["push", "origin", "main"]);
  const branch = "guardian/workflow-ignored";
  await createMergedBranch(repo, branch, "workflow-ignored.txt");
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), "workflow-ignored");
  await git(repo, ["worktree", "add", worktreePath, branch]);
  await fs.mkdir(path.join(worktreePath, "ignored-residue"), { recursive: true });
  await fs.writeFile(path.join(worktreePath, "ignored-residue", "cache.bin"), "residue\n");

  const blockedPlan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(blockedPlan.ok, false);
  assert.equal(blockedPlan.status, "blocked");
  assert.equal(blockedPlan.candidates.length, 0);
  assert.equal(blockedPlan.blockers.length, 1);
  assert.match(String(blockedPlan.blockers[0].reason), /ignored files/);
  assert.equal(await pathExists(worktreePath), true);
  assert.equal(await branchExists(repo, branch), true);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", allowIgnoredFiles: true }));

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.preflight.candidateCount, 1);
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].branch, branch);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirmToken: plan.confirmToken, allowIgnoredFiles: true }));

  assert.equal(apply.ok, true);
  assert.equal(apply.status, "cleaned");
  assert.equal(apply.results.length, 1);
  assert.equal(apply.results[0].worktreeRemoved, true);
  assert.equal(apply.results[0].branchDeleted, true);
  await assert.rejects(() => fs.access(worktreePath));
  await assert.rejects(() => git(repo, ["rev-parse", "--verify", branch]));
});
