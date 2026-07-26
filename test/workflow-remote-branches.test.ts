import {
  assert,
  branchExists,
  createMergedBranch,
  createRepoWithOrigin,
  createSafetyRef,
  createUnmergedBranch,
  fs,
  git,
  guardianFinishWorkflow,
  remoteBranchExists,
  test,
  workflowResult,
} from "./workflow-test-support.js";

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
  assert.equal(plan.status, "planned-partial");
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].kind, "remote-branch");
  assert.equal(plan.candidates[0].targetKind, "remote-branch");
  assert.equal(plan.candidates[0].remote, "origin");
  assert.equal(plan.candidates[0].remoteBranch, branch);
  assert.equal(plan.candidates[0].head, head);
  assert.equal(plan.remaining.some((entry) => entry.kind === "final-postflight"), true);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirmToken: plan.confirmToken }));

  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(apply.status, "partial");
  assert.equal(apply.results.length, 1);
  assert.equal(apply.results[0].remoteBranchDeleted, true);
  assert.equal(apply.remaining.some((entry) => entry.kind === "final-postflight"), true);
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
