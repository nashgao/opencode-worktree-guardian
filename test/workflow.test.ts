import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { createSafetyRef, deleteRemoteBranch } from "../src/git.ts";
import { guardianFinishWorkflow } from "../src/workflow.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

type WorkflowResult = {
  ok: boolean;
  status: string;
  reason?: string;
  confirmToken?: string;
  preflight: {
    candidateCount?: number;
    dirtyFileCount?: number;
    blockerCount?: number;
    baseRefOid?: string;
    maxCandidateCount?: number;
    candidateScanStatus?: "completed" | "skipped" | "failed";
    candidateScanSkippedReason?: "invalid-mode" | "base-unavailable" | "stash-blocker";
    candidateScanFailedReason?: "candidate-discovery-failed";
    blockers?: string[];
  };
  candidates: Array<Record<string, unknown>>;
  blockers: Array<Record<string, unknown>>;
  results: Array<Record<string, unknown>>;
  remaining: Array<Record<string, unknown>>;
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

async function remoteBranchExists(repo: string, branch: string) {
  const result = await git(repo, ["ls-remote", "--heads", "origin", branch]);
  return result.stdout.length > 0;
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
  const branch = "guardian/workflow-merged-branch";
  const head = await createMergedBranch(repo, branch, "workflow-branch.txt");
  await createSafetyRef(repo, { sessionId: "workflow-merged-branch", branch, commit: head, timestamp: "20260610T030303" });

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.preflight.candidateCount, 1);
  assert.deepEqual(plan.candidates.map((candidate: Record<string, unknown>) => candidate.kind), ["branch"]);
  assert.equal(plan.candidates[0].targetKind, "stale-branch");
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

test("guardian_finish_workflow dirty primary candidate scan includes read-only candidate inventory", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-dirty-primary-candidate";
  const head = await createMergedBranch(repo, branch, "workflow-dirty-primary-candidate.txt");
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), "workflow-dirty-primary-candidate");
  await git(repo, ["worktree", "add", worktreePath, branch]);
  await fs.writeFile(path.join(repo, "dirty-primary.txt"), "dirty\n");

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.match(String(plan.reason), /primary worktree has uncommitted changes/);
  assert.equal(plan.preflight.candidateScanStatus, "completed");
  assert.equal(plan.preflight.candidateCount, 1);
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].branch, branch);
  assert.equal(plan.candidates[0].head, head);
  assert.equal(plan.blockers.length, 0);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirmToken: "stale" }));
  assert.equal(apply.ok, false);
  assert.equal(apply.confirmToken, undefined);
  assert.equal(await pathExists(worktreePath), true);
  assert.equal(await branchExists(repo, branch), true);
});

test("guardian_finish_workflow dirty primary candidate scan reports completed empty inventory", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "dirty-primary-empty.txt"), "dirty\n");

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.match(String(plan.reason), /primary worktree has uncommitted changes/);
  assert.equal(plan.preflight.candidateScanStatus, "completed");
  assert.equal(plan.preflight.candidateCount, 0);
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.blockers, []);
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

test("guardian_finish_workflow scan skipped for invalid mode without completed candidate evidence", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "preview" }));

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.equal(plan.preflight.candidateScanStatus, "skipped");
  assert.equal(plan.preflight.candidateScanSkippedReason, "invalid-mode");
  assert.equal(plan.preflight.candidateCount, undefined);
  assert.equal(plan.preflight.maxCandidateCount, 25);
});

test("guardian_finish_workflow scan skipped for base-unavailable without completed candidate evidence", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await git(repo, ["branch", "--unset-upstream", "main"]);
  const config = { ...DEFAULT_CONFIG, remote: "missing-origin" };

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", config }));

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.equal(plan.preflight.candidateScanStatus, "skipped");
  assert.equal(plan.preflight.candidateScanSkippedReason, "base-unavailable");
  assert.equal(plan.preflight.candidateCount, undefined);
  assert.equal(plan.preflight.maxCandidateCount, 25);
});

test("guardian_finish_workflow scan skipped for stash blocker without completed candidate evidence", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "stashed-skip.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "workflow stash skip"]);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.equal(plan.preflight.candidateScanStatus, "skipped");
  assert.equal(plan.preflight.candidateScanSkippedReason, "stash-blocker");
  assert.equal(plan.preflight.candidateCount, undefined);
  assert.equal(plan.preflight.maxCandidateCount, 25);
});

test("guardian_finish_workflow scan skipped suite catches failed candidate discovery after dirty primary blocker", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "dirty-primary-failed-scan.txt"), "dirty\n");
  const missingCwd = path.join(repo, "missing-cwd");

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: missingCwd, mode: "plan" }));

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.equal(plan.preflight.candidateScanStatus, "failed");
  assert.equal(plan.preflight.candidateScanFailedReason, "candidate-discovery-failed");
  assert.match(String(plan.reason), /candidate discovery failed/);
  assert.ok(plan.preflight.blockers?.some((blocker) => blocker.includes("primary worktree has uncommitted changes")));
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

test("guardian_finish_workflow cleans safe candidates while reporting dirty Guardian-root blockers", async (t) => {
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

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned-partial");
  assert.equal(typeof plan.confirmToken, "string");
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.blockers.length, 1);
  assert.match(String(plan.blockers[0].reason), /uncommitted changes/);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirmToken: plan.confirmToken }));
  assert.equal(apply.ok, false);
  assert.equal(apply.status, "partial");
  assert.match(String(apply.reason), /safe cleanup completed/);
  assert.equal(apply.results.length, 1);
  assert.equal(apply.results[0].worktreeRemoved, true);
  assert.equal(apply.results[0].branchDeleted, true);
  assert.equal(apply.remaining.length, 1);
  assert.match(String(apply.remaining[0].reason), /uncommitted changes/);
  assert.equal(await pathExists(cleanPath), false);
  assert.equal(await branchExists(repo, cleanBranch), false);
  assert.equal(await pathExists(dirtyPath), true);
  assert.equal(await branchExists(repo, dirtyBranch), true);
});

test("guardian_finish_workflow blocks redundant dirty Guardian-root candidates without opt-in", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-redundant-dirty";
  const fileName = "workflow-redundant-dirty.txt";
  await createMergedBranch(repo, branch, fileName);
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), "workflow-redundant-dirty");
  await git(repo, ["worktree", "add", worktreePath, branch]);
  await fs.writeFile(path.join(repo, fileName), "new base content\n");
  await git(repo, ["add", fileName]);
  await git(repo, ["commit", "-m", "advance redundant dirty base"]);
  await git(repo, ["push", "origin", "main"]);
  await fs.writeFile(path.join(worktreePath, fileName), "new base content\n");

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.blockers.length, 1);
  assert.match(String(plan.blockers[0].reason), /uncommitted changes/);
  assert.equal(plan.blockers[0].allowRedundantDirtyPaths, undefined);
  assert.equal(await pathExists(worktreePath), true);
  assert.equal(await branchExists(repo, branch), true);
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
  const head = (await git(repo, ["rev-parse", "main"])).stdout;
  for (let index = 0; index < 26; index += 1) {
    const branch = `guardian/workflow-bound-${index}`;
    await git(repo, ["branch", branch, "main"]);
    await createSafetyRef(repo, { sessionId: `workflow-bound-${index}`, branch, commit: head, timestamp: "20260610T040404" });
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


test("guardian_finish_workflow cleans merged remote Guardian branches", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-remote-merged";
  const rescueBranch = "rescue/workflow-remote-merged";
  const unmergedBranch = "guardian/workflow-remote-unmerged";
  const head = await createMergedBranch(repo, branch, "workflow-remote-merged.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["branch", "-d", branch]);
  await createMergedBranch(repo, rescueBranch, "workflow-rescue-merged.txt");
  await git(repo, ["push", "origin", rescueBranch]);
  await git(repo, ["branch", "-d", rescueBranch]);
  await createUnmergedBranch(repo, unmergedBranch, "workflow-remote-unmerged.txt");
  await git(repo, ["push", "origin", unmergedBranch]);
  await git(repo, ["branch", "-D", unmergedBranch]);
  await git(repo, ["fetch", "origin"]);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.status, "planned");
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].kind, "remote-branch");
  assert.equal(plan.candidates[0].targetKind, "remote-branch");
  assert.equal(plan.candidates[0].remote, "origin");
  assert.equal(plan.candidates[0].remoteBranch, branch);
  assert.equal(plan.candidates[0].head, head);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirmToken: plan.confirmToken }));

  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.equal(apply.status, "cleaned");
  assert.equal(apply.results.length, 1);
  assert.equal(apply.results[0].remoteBranchDeleted, true);
  assert.equal(await remoteBranchExists(repo, branch), false);
  assert.equal(await remoteBranchExists(repo, rescueBranch), true);
  assert.equal(await remoteBranchExists(repo, unmergedBranch), true);
});


test("guardian_finish_workflow cleans same-name local and remote Guardian branches with ancestry proof", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-same-name";
  const head = await createMergedBranch(repo, branch, "workflow-same-name.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["fetch", "origin"]);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.status, "planned");
  assert.equal(plan.candidates.length, 2);
  assert.deepEqual(plan.candidates.map((candidate) => candidate.targetKind).sort(), ["merged-branch", "remote-branch"]);
  assert.equal(plan.candidates.some((candidate) => candidate.branch === branch && candidate.head === head), true);
  assert.equal(plan.blockers.length, 0);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirmToken: plan.confirmToken }));

  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.equal(await branchExists(repo, branch), false);
  assert.equal(await remoteBranchExists(repo, branch), false);
});

test("guardian_finish_workflow cleans unowned merged local Guardian branches with ancestry proof", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-unowned-merged-local";
  const head = await createMergedBranch(repo, branch, "workflow-unowned-merged-local.txt");

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.status, "planned");
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].kind, "branch");
  assert.equal(plan.candidates[0].targetKind, "merged-branch");
  assert.equal(plan.candidates[0].branch, branch);
  assert.equal(plan.candidates[0].head, head);
  assert.equal(plan.blockers.length, 0);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirmToken: plan.confirmToken }));

  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.equal(apply.results.length, 1);
  assert.equal(apply.results[0].branchDeleted, true);
  assert.equal(apply.results[0].worktreeRemoved, false);
  assert.equal(await branchExists(repo, branch), false);
});

test("guardian_finish_workflow cleans same-name local and remote Guardian branches when both are safe", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-same-name-owned";
  const head = await createMergedBranch(repo, branch, "workflow-same-name-owned.txt");
  await createSafetyRef(repo, { sessionId: "workflow-same-name-owned", branch, commit: head, timestamp: "20260610T070707" });
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["fetch", "origin"]);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.candidates.length, 2);
  assert.deepEqual(plan.candidates.map((candidate) => candidate.targetKind).sort(), ["remote-branch", "stale-branch"]);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirmToken: plan.confirmToken }));

  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.equal(apply.results.length, 2);
  assert.equal(await branchExists(repo, branch), false);
  assert.equal(await remoteBranchExists(repo, branch), false);
});

test("guardian_finish_workflow preserves merged local rescue branches by default", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "rescue/workflow-local-rescue";
  await createMergedBranch(repo, branch, "workflow-local-rescue.txt");

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.candidates.length, 0);
  assert.equal(await branchExists(repo, branch), true);
});


test("guardian_finish_workflow cleans configured-prefix local branches with ancestry proof", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "agent/workflow-custom-prefix";
  const head = await createMergedBranch(repo, branch, "workflow-custom-prefix.txt");
  const config = { ...DEFAULT_CONFIG, branchPrefix: "agent/" };

  const unproven = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", config }));

  assert.equal(unproven.ok, true, JSON.stringify(unproven));
  assert.equal(unproven.status, "planned");
  assert.equal(unproven.candidates.length, 1);
  assert.equal(unproven.candidates[0].kind, "branch");
  assert.equal(unproven.candidates[0].targetKind, "merged-branch");
  assert.equal(unproven.candidates[0].branch, branch);
  assert.equal(unproven.candidates[0].head, head);
  assert.equal(await branchExists(repo, branch), true);

  await createSafetyRef(repo, { sessionId: "workflow-custom-prefix", branch, commit: head, timestamp: "20260610T080808" });
  const proven = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", config }));

  assert.equal(proven.ok, true, JSON.stringify(proven));
  assert.equal(proven.candidates.length, 1);
  assert.equal(proven.candidates[0].targetKind, "stale-branch");
});

test("guardian_finish_workflow ignores stale deleted remote tracking refs after prune", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-stale-remote-tracking";
  await createMergedBranch(repo, branch, "workflow-stale-remote-tracking.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["branch", "-d", branch]);
  await git(repo, ["fetch", "origin"]);
  assert.equal(await remoteBranchExists(repo, branch), true);
  await git(remote, ["update-ref", "-d", "refs/heads/" + branch]);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.candidates.some((candidate) => candidate.remoteBranch === branch), false);
});

test("deleteRemoteBranch blocks when remote branch advanced after discovery", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-remote-lease";
  const oldHead = await createMergedBranch(repo, branch, "workflow-remote-lease.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["checkout", branch]);
  await fs.writeFile(path.join(repo, "workflow-remote-lease-advanced.txt"), "advanced\n");
  await git(repo, ["add", "workflow-remote-lease-advanced.txt"]);
  await git(repo, ["commit", "-m", "advance workflow remote lease"]);
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["checkout", "main"]);

  await assert.rejects(() => deleteRemoteBranch(repo, "origin", branch, oldHead));
  assert.equal(await remoteBranchExists(repo, branch), true);
});
