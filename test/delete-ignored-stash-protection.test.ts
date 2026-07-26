import {
  assert,
  branchExists,
  createGuardianWorktree,
  createRepoWithOrigin,
  DEFAULT_CONFIG,
  deleteWorktree,
  fs,
  git,
  guardianStart,
  guardianStatus,
  path,
  test,
  worktreePaths,
} from "./delete-fixtures.js";

test("ignored target worktree files are reported and blocked before safety refs", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_delete_ignored");
  await fs.writeFile(path.join(start.session.worktree_path, ".gitignore"), "ignored-output/\n");
  await git(start.session.worktree_path, ["add", ".gitignore"]);
  await git(start.session.worktree_path, ["commit", "-m", "ignore generated output"]);
  const ignoredDir = path.join(start.session.worktree_path, "ignored-output");
  await fs.mkdir(ignoredDir, { recursive: true });
  await fs.writeFile(path.join(ignoredDir, "artifact.log"), "generated\n");

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_delete_ignored", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /ignored files/);
  assert.equal(result.preflight.dirtyFileCount, 0);
  assert.equal(result.preflight.ignoredFileCount, 1);
  assert.deepEqual(result.preflight.ignoredFiles, ["ignored-output/"]);
  assert.equal(result.report.ignoredFileCount, 1);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG })).safetyRefs.length, 0);
});

test("allowIgnoredFiles permits explicit deletion of ignored-only target files", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_delete_allow_ignored", "delete ignored", "guardian/delete-ignored");
  await fs.writeFile(path.join(start.session.worktree_path, ".gitignore"), ".claude/\ndata/\n");
  await git(start.session.worktree_path, ["add", ".gitignore"]);
  await git(start.session.worktree_path, ["commit", "-m", "ignore local artifacts"]);
  await fs.mkdir(path.join(start.session.worktree_path, ".claude"), { recursive: true });
  await fs.mkdir(path.join(start.session.worktree_path, "data"), { recursive: true });
  await fs.writeFile(path.join(start.session.worktree_path, ".claude", "settings.json"), "{}\n");
  await fs.writeFile(path.join(start.session.worktree_path, "data", "cache.db"), "cache\n");

  const blocked = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_delete_allow_ignored", config: DEFAULT_CONFIG });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /ignored files/);

  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_delete_allow_ignored", deleteBranch: false, allowIgnoredFiles: true, config: DEFAULT_CONFIG, timestamp: "20260601T150000" });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.preflight.allowIgnoredFiles, true);
  assert.deepEqual(plan.preflight.ignoredFiles, [".claude/", "data/"]);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId: "ses_delete_allow_ignored", deleteBranch: false, allowIgnoredFiles: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T150000" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "deleted");
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), false);
  assert.equal(await branchExists(repo, "guardian/delete-ignored"), true);
  assert.match(result.safetyRef, /^refs\/opencode-guardian\/ses_delete_allow_ignored\/guardian\/delete-ignored\//);
});

test("apply tolerates empty timestamp without creating a trailing-slash safety ref", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "ses_15a6a9af2ffef5mXFgNq3s3zPm";
  const start = await createGuardianWorktree(repo, sessionId, "delete empty timestamp", "guardian/session-ses-15a6");

  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, config: DEFAULT_CONFIG });
  assert.equal(plan.ok, true);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "deleted");
  assert.equal(result.worktreeRemoved, true);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), false);
  assert.doesNotMatch(result.safetyRef ?? "", /\/$/);
  await git(repo, ["check-ref-format", String(result.safetyRef)]);
});

test("stash inventory is advisory during deletion planning by default", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_delete_stash");
  await fs.writeFile(path.join(repo, "stashed.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "delete test stash"]);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_delete_stash", config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.equal(result.status, "planned");
  assert.equal(typeof result.confirmToken, "string");
  assert.equal(result.preflight.stashCount, 1);
  assert.equal(Array.isArray(result.preflight.stashes) ? result.preflight.stashes.length : 0, 1);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG })).safetyRefs.length, 0);
});

test("strict stash inventory policy blocks deletion before safety refs", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_delete_stash_strict");
  await fs.writeFile(path.join(repo, "stashed-strict.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "strict delete test stash"]);
  const config = { ...DEFAULT_CONFIG, requireEmptyStashInventory: true };

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_delete_stash_strict", config });

  assert.equal(result.ok, false);
  assert.match(result.reason, /stash inventory/);
  assert.equal(result.preflight.stashCount, 1);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config })).safetyRefs.length, 0);
});

test("protected branches and primary/current worktrees are blocked", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const protectedStart = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_delete_protected", taskName: "delete protected", branch: "develop", createWorktree: true, config: DEFAULT_CONFIG });
  const currentStart = await createGuardianWorktree(repo, "ses_delete_current");

  assert.equal(protectedStart.ok, false);
  assert.match(String(protectedStart.reason), /protected/);

  const protectedResult = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", branch: "develop", config: DEFAULT_CONFIG });
  assert.equal(protectedResult.ok, false);
  assert.match(protectedResult.reason, /protected/);

  const primaryResult = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", targetPath: repo, config: DEFAULT_CONFIG });
  assert.equal(primaryResult.ok, false);
  assert.match(primaryResult.reason, /primary/);

  const primaryDeleteBranchResult = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", targetPath: repo, deleteBranch: true, config: DEFAULT_CONFIG });
  assert.equal(primaryDeleteBranchResult.ok, false);
  assert.match(primaryDeleteBranchResult.reason, /primary/);

  const currentResult = await deleteWorktree({ repoRoot: repo, cwd: currentStart.session.worktree_path, mode: "plan", sessionId: "ses_delete_current", config: DEFAULT_CONFIG });
  assert.equal(currentResult.ok, false);
  assert.match(currentResult.reason, /current/);
});
