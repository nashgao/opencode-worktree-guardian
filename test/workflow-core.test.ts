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
  path,
  pathExists,
  test,
  workflowResult,
} from "./workflow-test-support.js";

async function createIgnoredTokenCandidate() {
  const fixture = await createRepoWithOrigin();
  const { repo } = fixture;
  await fs.writeFile(path.join(repo, ".gitignore"), "ignored-residue/\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "add ignored residue rule"]);
  await git(repo, ["push", "origin", "main"]);
  const branch = "guardian/workflow-token-binding";
  await createMergedBranch(repo, branch, "workflow-token-binding.txt");
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), "workflow-token-binding");
  await git(repo, ["worktree", "add", worktreePath, branch]);
  const ignoredPath = path.join(worktreePath, "ignored-residue", "cache.bin");
  await fs.mkdir(path.dirname(ignoredPath), { recursive: true });
  await fs.writeFile(ignoredPath, "planned\n");
  return { ...fixture, branch, ignoredPath, worktreePath };
}

type WorkflowCandidateSnapshotInput = {
  readonly repo: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly candidateFile: string;
};

async function workflowCandidateSnapshot(input: WorkflowCandidateSnapshotInput) {
  const [localRefs, remoteRefs, remoteTrackingRefs, remoteTrackingReflog, safetyRefs, index, baseOid, branchOid, objects, status, candidateContent, fetchHead, state] = await Promise.all([
    git(input.repo, ["for-each-ref", "--format=%(refname) %(objectname)" ]),
    git(input.repo, ["ls-remote", "--refs", "origin"]),
    git(input.repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes"]),
    git(input.repo, ["reflog", "show", "--all", "--format=%gD %H"]),
    git(input.repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/opencode-guardian"]),
    git(input.repo, ["ls-files", "--stage"]),
    git(input.repo, ["rev-parse", "main"]),
    git(input.repo, ["rev-parse", input.branch]),
    git(input.repo, ["count-objects", "-v"]),
    git(input.repo, ["status", "--porcelain=v1", "--untracked-files=all"]),
    fs.readFile(input.candidateFile, "utf8"),
    fs.readFile(path.join(input.repo, ".git", "FETCH_HEAD"), "utf8").then((contents) => contents, () => "<absent>"),
    fs.readFile(path.join(input.repo, ".git", "opencode-guardian", "state.json"), "utf8").then((contents) => contents, () => "<absent>"),
  ]);
  return {
    localRefs: localRefs.stdout,
    remoteRefs: remoteRefs.stdout,
    remoteTrackingRefs: remoteTrackingRefs.stdout,
    remoteTrackingReflog: remoteTrackingReflog.stdout,
    safetyRefs: safetyRefs.stdout,
    index: index.stdout,
    baseOid: baseOid.stdout,
    branchOid: branchOid.stdout,
    objects: objects.stdout,
    worktreeExists: await pathExists(input.worktreePath),
    candidateContent,
    fetchHead,
    state,
    status: status.stdout,
  };
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

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken }));

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

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken }));

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

test("guardian_finish_workflow rejects an apply that drops ignored-file approval", async (t) => {
  const { base, repo, worktreePath } = await createIgnoredTokenCandidate();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", allowIgnoredFiles: true }));
  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken }));
  assert.equal(apply.ok, false);
  assert.match(String(apply.reason), /confirm token mismatch/);
  assert.equal(await pathExists(worktreePath), true);
});

test("guardian_finish_workflow requires explicit confirmation after a matching token without mutating cleanup candidates", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-confirmation-gate";
  await createMergedBranch(repo, branch, "workflow-confirmation-gate.txt");
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), "workflow-confirmation-gate");
  const candidateFile = path.join(worktreePath, "workflow-confirmation-gate.txt");
  await git(repo, ["worktree", "add", worktreePath, branch]);
  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));
  const snapshotInput = { repo, branch, worktreePath, candidateFile };
  const before = await workflowCandidateSnapshot(snapshotInput);

  const blocked = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirmToken: plan.confirmToken }));

  assert.equal(blocked.ok, false, JSON.stringify(blocked));
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.confirmationRequired, true);
  assert.equal(blocked.tokenChecked, false);
  assert.equal(blocked.remoteRefresh, "skipped");
  assert.equal(blocked.nextAction, "guardian_finish_workflow mode=apply confirm=true");
  assert.deepEqual(await workflowCandidateSnapshot(snapshotInput), before);

  const applied = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken }));

  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(await pathExists(worktreePath), false);
  assert.equal(await branchExists(repo, branch), false);
});

test("guardian_finish_workflow skips remote refresh until confirmed, then detects remote base drift", async (t) => {
  const { base, remote, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-confirmation-remote-race";
  await createMergedBranch(repo, branch, "workflow-confirmation-remote-race.txt");
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), "workflow-confirmation-remote-race");
  const candidateFile = path.join(worktreePath, "workflow-confirmation-remote-race.txt");
  await git(repo, ["worktree", "add", worktreePath, branch]);
  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));
  const updater = path.join(base, "remote-updater");
  await git(base, ["clone", remote, updater]);
  await git(updater, ["config", "user.email", "test@example.com"]);
  await git(updater, ["config", "user.name", "Test User"]);
  await fs.writeFile(path.join(updater, "remote-race.txt"), "remote advance\n");
  await git(updater, ["add", "remote-race.txt"]);
  await git(updater, ["commit", "-m", "advance remote base"]);
  await git(updater, ["push", "origin", "main"]);
  const snapshotInput = { repo, branch, worktreePath, candidateFile };
  const before = await workflowCandidateSnapshot(snapshotInput);

  const unconfirmed = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirmToken: plan.confirmToken }));

  assert.equal(unconfirmed.ok, false, JSON.stringify(unconfirmed));
  assert.equal(unconfirmed.status, "blocked");
  assert.equal(unconfirmed.confirmationRequired, true);
  assert.equal(unconfirmed.tokenChecked, false);
  assert.equal(unconfirmed.remoteRefresh, "skipped");
  assert.equal("candidates" in unconfirmed, false);
  assert.deepEqual(await workflowCandidateSnapshot(snapshotInput), before);

  const confirmed = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken }));

  assert.equal(confirmed.ok, false, JSON.stringify(confirmed));
  assert.equal(confirmed.status, "blocked");
  assert.equal(confirmed.driftDetected, true);
  assert.equal(confirmed.plannedConfirmToken, plan.confirmToken);
  assert.equal(typeof confirmed.refreshedConfirmToken, "string");
  assert.notEqual(confirmed.refreshedConfirmToken, plan.confirmToken);
  const refreshed = await workflowCandidateSnapshot(snapshotInput);
  assert.equal(refreshed.branchOid, before.branchOid);
  assert.equal(refreshed.worktreeExists, true);
  assert.equal(refreshed.candidateContent, before.candidateContent);
  assert.equal(refreshed.state, before.state);

  const refreshedPlan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));
  const applied = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: refreshedPlan.confirmToken }));

  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(await pathExists(worktreePath), false);
  assert.equal(await branchExists(repo, branch), false);
});

test("guardian_finish_workflow rejects ignored-file drift after planning", async (t) => {
  const { base, branch, ignoredPath, repo, worktreePath } = await createIgnoredTokenCandidate();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", allowIgnoredFiles: true }));
  await fs.writeFile(ignoredPath, "changed after plan\n");
  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken, allowIgnoredFiles: true }));
  assert.equal(apply.ok, false);
  assert.match(String(apply.reason), /confirm token mismatch/);
  assert.equal(await pathExists(worktreePath), true);
  assert.equal(await branchExists(repo, branch), true);
});
