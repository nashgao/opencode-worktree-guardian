import {
  assert,
  branchExists,
  createMergedBranch,
  createRepoWithOrigin,
  createSafetyRef,
  DEFAULT_CONFIG,
  fs,
  git,
  guardianFinishWorkflow,
  remoteBranchExists,
  test,
  workflowResult,
} from "./workflow-test-support.js";

test("guardian_finish_workflow skipFinalPostflight skips plan-mode final postflight blockers", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "rescue/workflow-skip-plan-postflight";
  await createMergedBranch(repo, branch, "workflow-skip-plan-postflight.txt");

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", skipFinalPostflight: true }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.status, "planned");
  assert.equal(plan.candidates.length, 0);
  assert.deepEqual(plan.remaining, []);
  assert.equal(plan.finalPostflight?.status, "skipped");
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
