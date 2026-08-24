import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianStart } from "../src/tools.ts";
import { isRecordLike, type RecordLike } from "../src/types.ts";
import { guardianFinishWorkflow } from "../src/workflow.ts";
import { createRepo, createRepoWithOrigin, git } from "./helpers.ts";

function record(value: unknown): RecordLike {
  return isRecordLike(value) ? value : {};
}

function records(value: unknown): readonly RecordLike[] {
  return Array.isArray(value) ? value.filter(isRecordLike) : [];
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

function branchExists(repo: string, branch: string) {
  return git(repo, ["rev-parse", "--verify", branch]).then(() => true, () => false);
}

function pathExists(filePath: string) {
  return fs.access(filePath).then(() => true, () => false);
}

test("guardian_finish_workflow dirty primary candidate scan includes read-only candidate inventory", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-dirty-primary-candidate";
  const head = await createMergedBranch(repo, branch, "workflow-dirty-primary-candidate.txt");
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), "workflow-dirty-primary-candidate");
  const dirtyPrimaryPath = path.join(repo, "dirty-primary.txt");
  await git(repo, ["worktree", "add", worktreePath, branch]);
  await fs.writeFile(dirtyPrimaryPath, "dirty\n");

  const plan = record(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));
  const planPreflight = record(plan.preflight);
  const planCandidates = records(plan.candidates);
  const planRemaining = records(plan.remaining);

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned-partial");
  assert.equal(typeof plan.confirmToken, "string");
  assert.equal(planPreflight.candidateScanStatus, "completed");
  assert.equal(planPreflight.candidateCount, 1);
  assert.equal(planCandidates.length, 1);
  const [candidate] = planCandidates;
  assert.ok(candidate);
  assert.equal(candidate.branch, branch);
  assert.equal(candidate.head, head);
  assert.equal(records(plan.blockers).length, 0);
  assert.equal(planRemaining.some((remaining) => remaining.kind === "primary-dirty"), true);

  const staleApply = record(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: "0".repeat(64) }));
  assert.equal(staleApply.ok, false);
  assert.equal(staleApply.confirmToken, undefined);
  assert.equal(await pathExists(worktreePath), true);
  assert.equal(await branchExists(repo, branch), true);

  const apply = record(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken }));
  const applyResults = records(apply.results);
  const applyRemaining = records(apply.remaining);

  assert.equal(apply.ok, false);
  assert.equal(apply.status, "partial");
  assert.equal(applyResults.length, 1);
  const [result] = applyResults;
  assert.ok(result);
  assert.equal(result.worktreeRemoved, true);
  assert.equal(result.branchDeleted, true);
  assert.equal(applyRemaining.some((remaining) => remaining.kind === "base-sync-skipped"), true);
  assert.equal(await pathExists(dirtyPrimaryPath), true);
  assert.equal(await pathExists(worktreePath), false);
  assert.equal(await branchExists(repo, branch), false);
});

test("guardian_finish_workflow scan failed suite keeps dirty primary inventory", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "dirty-primary-failed-scan.txt"), "dirty\n");
  const missingCwd = path.join(repo, "missing-cwd");

  const plan = record(await guardianFinishWorkflow({ repoRoot: repo, cwd: missingCwd, mode: "plan" }));
  const preflight = record(plan.preflight);

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.equal(preflight.candidateScanStatus, "failed");
  assert.equal(preflight.candidateScanFailedReason, "candidate-discovery-failed");
  assert.match(String(plan.reason), /candidate discovery failed/);
  assert.equal(preflight.blockingDirtyFileCount, 1);
  assert.deepEqual(preflight.blockingDirtyFiles, ["dirty-primary-failed-scan.txt"]);
});
