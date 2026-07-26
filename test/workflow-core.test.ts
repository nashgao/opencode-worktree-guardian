import {
  assert,
  createMergedBranch,
  createRepoWithOrigin,
  createSafetyRef,
  DEFAULT_CONFIG,
  fs,
  git,
  guardianFinishWorkflow,
  path,
  test,
  workflowResult,
} from "./workflow-test-support.js";

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

test("guardian_finish_workflow reports stash inventory without blocking by default", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "stashed.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "workflow stash"]);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(typeof plan.confirmToken, "string");
  assert.equal(plan.preflight.candidateScanStatus, "completed");
  assert.equal(plan.preflight.stashCount, 1);
  assert.equal(plan.preflight.stashes?.length, 1);
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

  const config = { ...DEFAULT_CONFIG, requireEmptyStashInventory: true };
  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", config }));

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.equal(plan.preflight.candidateScanStatus, "skipped");
  assert.equal(plan.preflight.candidateScanSkippedReason, "stash-blocker");
  assert.equal(plan.preflight.candidateCount, undefined);
  assert.equal(plan.preflight.maxCandidateCount, 25);
});
