import {
  advanceBase,
  assert,
  branchExists,
  createGuardianWorktree,
  createRepoWithOrigin,
  DEFAULT_CONFIG,
  deleteWorktree,
  findSession,
  fs,
  git,
  guardianStatus,
  path,
  test,
  worktreePaths,
} from "./delete-fixtures.js";

test("redundant dirty apply reports partial branch deletion failure with snapshot recovery", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_redundant_dirty_branch_partial", "redundant dirty branch partial", "guardian/redundant-dirty-branch-partial");
  await advanceBase(repo, "advance base for branch partial", [{ file: "README.md", content: "base branch partial\n" }]);
  await fs.writeFile(path.join(start.session.worktree_path, "README.md"), "base branch partial\n");
  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_branch_partial", allowRedundantDirtyPaths: true, deleteBranch: true, config: DEFAULT_CONFIG, timestamp: "20260601T211000" });
  assert.equal(plan.ok, true);
  const lockPath = path.join(repo, ".git", "refs", "heads", "guardian", "redundant-dirty-branch-partial.lock");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, "locked\n");

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId: "ses_redundant_dirty_branch_partial", allowRedundantDirtyPaths: true, deleteBranch: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T211000" });

  assert.equal(result.ok, false);
  assert.equal(result.status, "partial");
  assert.equal(result.branchDeleted, false);
  assert.equal(result.worktreeRemoved, true);
  assert.equal(typeof result.dirtySnapshotRef, "string");
  assert.equal(typeof result.dirtySnapshotCommit, "string");
  assert.equal(result.dirtySnapshotFileCount, 1);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), false);
  assert.equal(await branchExists(repo, "guardian/redundant-dirty-branch-partial"), true);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const session = findSession(status, "ses_redundant_dirty_branch_partial");
  assert.deepEqual(session.safety_refs, [result.safetyRef, result.dirtySnapshotRef]);
  assert.equal(session.branch_delete_failed, true);
});

test("redundant dirty apply reports partial removal failure with snapshot recovery", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_redundant_dirty_remove_partial", "redundant dirty remove partial", "guardian/redundant-dirty-remove-partial");
  await advanceBase(repo, "advance base for remove partial", [{ file: "README.md", content: "base remove partial\n" }]);
  await fs.writeFile(path.join(start.session.worktree_path, "README.md"), "base remove partial\n");
  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_remove_partial", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG, timestamp: "20260601T212000" });
  assert.equal(plan.ok, true);
  await git(repo, ["worktree", "lock", "--reason", "test removal failure", start.session.worktree_path]);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId: "ses_redundant_dirty_remove_partial", allowRedundantDirtyPaths: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T212000" });

  assert.equal(result.ok, false);
  assert.equal(result.status, "partial");
  assert.match(result.reason, /worktree removal failed/);
  assert.equal(result.worktreeRemoved, false);
  assert.equal(typeof result.dirtySnapshotRef, "string");
  assert.equal(result.cleanedDirtyFileCount, 1);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const session = findSession(status, "ses_redundant_dirty_remove_partial");
  assert.deepEqual(session.safety_refs, [result.safetyRef, result.dirtySnapshotRef]);
});

test("redundant dirty fail closed when dirty content changes after planning", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_redundant_dirty_stale");
  await advanceBase(repo, "advance base for stale dirty", [{ file: "README.md", content: "base stale\n" }]);
  await fs.writeFile(path.join(start.session.worktree_path, "README.md"), "base stale\n");
  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_stale", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });
  assert.equal(plan.ok, true);
  await fs.writeFile(path.join(start.session.worktree_path, "README.md"), "local stale\n");

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId: "ses_redundant_dirty_stale", allowRedundantDirtyPaths: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /redundant dirty proof/i);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG })).safetyRefs.length, 0);
});

test("redundant dirty fail closed on symlink paths", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_redundant_dirty_symlink");
  await advanceBase(repo, "advance base with file", [{ file: "base-only.txt", content: "base file\n" }]);
  await fs.symlink("README.md", path.join(start.session.worktree_path, "base-only.txt"));

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_symlink", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /unsupported dirty path/i);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG })).safetyRefs.length, 0);
});

test("redundant dirty fail closed on rename conflict and directory type-change statuses", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  await advanceBase(repo, "seed type-change file", [{ file: "type-change.txt", content: "base file\n" }]);
  const renamed = await createGuardianWorktree(repo, "ses_redundant_dirty_rename");
  const conflicted = await createGuardianWorktree(repo, "ses_redundant_dirty_conflict", "conflict dirty", "guardian/redundant-dirty-conflict");
  const directory = await createGuardianWorktree(repo, "ses_redundant_dirty_directory");
  await advanceBase(repo, "advance base for unsupported statuses", [{ file: "README.md", content: "base unsupported\n" }]);
  await git(renamed.session.worktree_path, ["mv", "README.md", "RENAMED.md"]);

  await fs.writeFile(path.join(conflicted.session.worktree_path, "README.md"), "local conflict\n");
  await git(conflicted.session.worktree_path, ["add", "README.md"]);
  await git(conflicted.session.worktree_path, ["commit", "-m", "local conflict"]);
  await assert.rejects(git(conflicted.session.worktree_path, ["merge", "origin/main"]));

  await fs.rm(path.join(directory.session.worktree_path, "type-change.txt"));
  await fs.mkdir(path.join(directory.session.worktree_path, "type-change.txt"));
  await fs.writeFile(path.join(directory.session.worktree_path, "type-change.txt", "nested.txt"), "nested\n");

  const renameResult = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_rename", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });
  const conflictResult = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_conflict", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });
  const directoryResult = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_directory", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });

  assert.equal(renameResult.ok, false);
  assert.match(renameResult.reason, /unsupported dirty status/i);
  assert.equal(conflictResult.ok, false);
  assert.match(conflictResult.reason, /unsupported dirty status|redundant dirty proof/i);
  assert.equal(directoryResult.ok, false);
  assert.match(directoryResult.reason, /redundant dirty proof|unsupported dirty path/i);
  assert.equal((await worktreePaths(repo)).includes(renamed.session.worktree_path), true);
  assert.equal((await worktreePaths(repo)).includes(conflicted.session.worktree_path), true);
  assert.equal((await worktreePaths(repo)).includes(directory.session.worktree_path), true);
});
