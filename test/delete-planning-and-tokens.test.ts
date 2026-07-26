import {
  assert,
  assertNoExpectedToken,
  branchExists,
  createGuardianWorktree,
  createRepoWithOrigin,
  DEFAULT_CONFIG,
  deleteWorktree,
  fs,
  git,
  guardianStatus,
  path,
  test,
  worktreePaths,
} from "./delete-fixtures.js";

test("plan mode is read-only and returns a confirm token", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_delete_plan");

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_delete_plan", config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.equal(result.status, "planned");
  assert.equal(typeof result.confirmToken, "string");
  assert.equal(result.preflight.targetPath, start.session.worktree_path);
  assert.equal(result.preflight.deleteBranch, false);
  assert.deepEqual(result.preflight.blockers, []);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG })).safetyRefs.length, 0);
});

test("apply blocks stale or mismatched confirm tokens", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_delete_token");

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId: "ses_delete_token", confirmToken: "not-the-token", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /confirm token/i);
  assertNoExpectedToken(result);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG })).safetyRefs.length, 0);
});

test("apply blocks stale tokens after target HEAD changes without leaking the new token", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_delete_stale_head");
  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_delete_stale_head", config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(start.session.worktree_path, "after-plan.txt"), "changed after plan\n");
  await git(start.session.worktree_path, ["add", "after-plan.txt"]);
  await git(start.session.worktree_path, ["commit", "-m", "change after plan"]);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId: "ses_delete_stale_head", confirmToken: plan.confirmToken, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /confirm token/i);
  assertNoExpectedToken(result);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG })).safetyRefs.length, 0);
});

test("apply blocks old plans when target becomes dirty or ignored", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const dirtyStart = await createGuardianWorktree(repo, "ses_delete_stale_dirty");
  const dirtyPlan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_delete_stale_dirty", config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(dirtyStart.session.worktree_path, "dirty-after-plan.txt"), "dirty\n");

  const dirtyResult = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId: "ses_delete_stale_dirty", confirmToken: dirtyPlan.confirmToken, config: DEFAULT_CONFIG });
  assert.equal(dirtyResult.ok, false);
  assert.match(dirtyResult.reason, /uncommitted/);
  assert.equal((await worktreePaths(repo)).includes(dirtyStart.session.worktree_path), true);

  const ignoredStart = await createGuardianWorktree(repo, "ses_delete_stale_ignored");
  await fs.writeFile(path.join(ignoredStart.session.worktree_path, ".gitignore"), "ignored-after-plan/\n");
  await git(ignoredStart.session.worktree_path, ["add", ".gitignore"]);
  await git(ignoredStart.session.worktree_path, ["commit", "-m", "ignore after plan directory"]);
  const ignoredPlan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_delete_stale_ignored", config: DEFAULT_CONFIG });
  await fs.mkdir(path.join(ignoredStart.session.worktree_path, "ignored-after-plan"), { recursive: true });
  await fs.writeFile(path.join(ignoredStart.session.worktree_path, "ignored-after-plan", "artifact.log"), "ignored\n");

  const ignoredResult = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId: "ses_delete_stale_ignored", confirmToken: ignoredPlan.confirmToken, config: DEFAULT_CONFIG });
  assert.equal(ignoredResult.ok, false);
  assert.match(ignoredResult.reason, /ignored files/);
  assert.equal((await worktreePaths(repo)).includes(ignoredStart.session.worktree_path), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG })).safetyRefs.length, 0);
});

test("apply blocks when deleteBranch flag differs from the plan token", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_delete_toggle_branch", "toggle branch", "guardian/delete-toggle-branch");
  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_delete_toggle_branch", config: DEFAULT_CONFIG });

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId: "ses_delete_toggle_branch", deleteBranch: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /confirm token/i);
  assertNoExpectedToken(result);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal(await branchExists(repo, "guardian/delete-toggle-branch"), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG })).safetyRefs.length, 0);
});

test("dirty or untracked target worktrees are blocked before safety refs", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_delete_dirty");
  await fs.writeFile(path.join(start.session.worktree_path, "untracked.txt"), "do not delete\n");

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", targetPath: start.session.worktree_path, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /uncommitted/);
  assert.equal(result.preflight.dirtyFileCount, 1);
  assert.equal((await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG })).safetyRefs.length, 0);
});
