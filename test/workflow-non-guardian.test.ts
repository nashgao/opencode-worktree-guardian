import {
  assert,
  branchExists,
  createMergedBranch,
  createRepoWithOrigin,
  createUnmergedBranch,
  deleteRemoteBranch,
  fs,
  git,
  guardianFinishWorkflow,
  path,
  remoteBranchExists,
  test,
  workflowResult,
} from "./workflow-test-support.js";

test("guardian_finish_workflow cleans merged non-Guardian local and remote branches", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "feat/workflow-non-guardian";
  const head = await createMergedBranch(repo, branch, "workflow-non-guardian.txt");
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

test("guardian_finish_workflow excludes unmerged non-Guardian local branches", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "feat/workflow-non-guardian-unmerged";
  await createUnmergedBranch(repo, branch, "workflow-non-guardian-unmerged.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["fetch", "origin"]);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", abandonUnmerged: true }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.candidates.some((candidate) => candidate.branch === branch), false);
  assert.equal(await branchExists(repo, branch), true);
  assert.equal(await remoteBranchExists(repo, branch), true);
});

test("guardian_finish_workflow preserves merged non-Guardian rescue remote branches", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "rescue/workflow-non-guardian-remote-rescue";
  await createMergedBranch(repo, branch, "workflow-non-guardian-remote-rescue.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["branch", "-d", branch]);
  await git(repo, ["fetch", "origin"]);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.candidates.some((candidate) => candidate.remoteBranch === branch), false);
  assert.equal(await remoteBranchExists(repo, branch), true);
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
