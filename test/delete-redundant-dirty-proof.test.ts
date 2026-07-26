import {
  advanceBase,
  assert,
  assertNoExpectedToken,
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
  refExists,
  test,
  worktreePaths,
} from "./delete-fixtures.js";

test("redundant dirty preflight keeps absent opt-in blocked", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_redundant_dirty_absent");
  await advanceBase(repo, "advance base readme", [{ file: "README.md", content: "base changed\n" }]);
  await fs.writeFile(path.join(start.session.worktree_path, "README.md"), "base changed\n");

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_absent", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /uncommitted/);
  assert.equal(result.preflight.allowRedundantDirtyPaths, false);
  assert.equal(result.preflight.dirtyFileCount, 1);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG })).safetyRefs.length, 0);
});

test("redundant dirty proof accepts paths matching base", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  await advanceBase(repo, "seed deleted file", [{ file: "delete-me.txt", content: "remove on base\n" }]);
  const modified = await createGuardianWorktree(repo, "ses_redundant_dirty_modified");
  const deleted = await createGuardianWorktree(repo, "ses_redundant_dirty_deleted");
  const untracked = await createGuardianWorktree(repo, "ses_redundant_dirty_untracked");
  const baseRefOid = await advanceBase(repo, "advance base for redundant dirt", [
    { file: "README.md", content: "base readme changed\n" },
    { file: "delete-me.txt", content: null },
    { file: "base-only.txt", content: "already on base\n" },
  ]);
  await fs.writeFile(path.join(modified.session.worktree_path, "README.md"), "base readme changed\n");
  await fs.rm(path.join(deleted.session.worktree_path, "delete-me.txt"));
  await fs.writeFile(path.join(untracked.session.worktree_path, "base-only.txt"), "already on base\n");

  const modifiedPlan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_modified", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });
  const deletedPlan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_deleted", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });
  const untrackedPlan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_untracked", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });

  for (const plan of [modifiedPlan, deletedPlan, untrackedPlan]) {
    assert.equal(plan.ok, true);
    assert.equal(plan.status, "planned");
    assert.equal(plan.preflight.allowRedundantDirtyPaths, true);
    assert.equal(plan.preflight.baseRef, "origin/main");
    assert.equal(plan.preflight.baseRefOid, baseRefOid);
    assert.equal(plan.preflight.redundantDirtyFileCount, 1);
    assert.equal(Array.isArray(plan.preflight.redundantDirtyProofs), true);
    assert.equal(typeof plan.confirmToken, "string");
  }
});

test("redundant dirty proof blocks non-redundant paths and staged changes", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const modified = await createGuardianWorktree(repo, "ses_redundant_dirty_nonredundant_mod");
  const untracked = await createGuardianWorktree(repo, "ses_redundant_dirty_nonredundant_untracked");
  const staged = await createGuardianWorktree(repo, "ses_redundant_dirty_staged");
  await advanceBase(repo, "advance base for nonredundant dirt", [
    { file: "README.md", content: "base content\n" },
    { file: "base-only.txt", content: "base file\n" },
  ]);
  await fs.writeFile(path.join(modified.session.worktree_path, "README.md"), "local content\n");
  await fs.writeFile(path.join(untracked.session.worktree_path, "base-only.txt"), "local file\n");
  await fs.writeFile(path.join(staged.session.worktree_path, "README.md"), "base content\n");
  await git(staged.session.worktree_path, ["add", "README.md"]);

  const modifiedResult = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_nonredundant_mod", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });
  const untrackedResult = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_nonredundant_untracked", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });
  const stagedResult = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_staged", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });

  assert.equal(modifiedResult.ok, false);
  assert.match(modifiedResult.reason, /redundant dirty proof/i);
  assert.equal(untrackedResult.ok, false);
  assert.match(untrackedResult.reason, /redundant dirty proof/i);
  assert.equal(stagedResult.ok, false);
  assert.match(stagedResult.reason, /unsupported dirty status/i);
  assert.equal((await worktreePaths(repo)).includes(modified.session.worktree_path), true);
  assert.equal((await worktreePaths(repo)).includes(untracked.session.worktree_path), true);
  assert.equal((await worktreePaths(repo)).includes(staged.session.worktree_path), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG })).safetyRefs.length, 0);
});

test("redundant dirty preflight token binds the base oid", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_redundant_dirty_base_oid");
  await advanceBase(repo, "advance base to v2", [{ file: "README.md", content: "base v2\n" }]);
  await fs.writeFile(path.join(start.session.worktree_path, "README.md"), "base v2\n");
  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_base_oid", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });
  assert.equal(plan.ok, true);

  const newBaseOid = await advanceBase(repo, "advance base to v3", [{ file: "README.md", content: "base v3\n" }]);
  await fs.writeFile(path.join(start.session.worktree_path, "README.md"), "base v3\n");
  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId: "ses_redundant_dirty_base_oid", allowRedundantDirtyPaths: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /confirm token/i);
  assert.equal(result.preflight.baseRefOid, newBaseOid);
  assertNoExpectedToken(result);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG })).safetyRefs.length, 0);
});

test("redundant dirty apply removes worktree and records snapshot", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_redundant_dirty_apply", "redundant dirty apply", "guardian/redundant-dirty-apply");
  await advanceBase(repo, "advance base for apply", [
    { file: "README.md", content: "base apply readme\n" },
    { file: "base-only.txt", content: "base apply file\n" },
  ]);
  await fs.writeFile(path.join(start.session.worktree_path, "README.md"), "base apply readme\n");
  await fs.writeFile(path.join(start.session.worktree_path, "base-only.txt"), "base apply file\n");
  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_apply", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG, timestamp: "20260601T210000" });
  assert.equal(plan.ok, true);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId: "ses_redundant_dirty_apply", allowRedundantDirtyPaths: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T210000" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "deleted");
  assert.equal(result.worktreeRemoved, true);
  assert.equal(result.branchDeleted, false);
  assert.equal(result.dirtySnapshotFileCount, 2);
  assert.deepEqual(result.dirtySnapshotFiles, ["README.md", "base-only.txt"]);
  assert.match(String(result.safetyRef), /^refs\/opencode-guardian\/ses_redundant_dirty_apply\/guardian\/redundant-dirty-apply\//);
  assert.match(String(result.dirtySnapshotRef), /^refs\/opencode-guardian\/ses_redundant_dirty_apply\/redundant-dirty\/guardian\/redundant-dirty-apply\//);
  assert.equal(typeof result.dirtySnapshotCommit, "string");
  assert.equal(await refExists(repo, String(result.dirtySnapshotRef)), true);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), false);
  assert.equal(await branchExists(repo, "guardian/redundant-dirty-apply"), true);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const session = findSession(status, "ses_redundant_dirty_apply");
  assert.deepEqual(session.safety_refs, [result.safetyRef, result.dirtySnapshotRef]);
});
