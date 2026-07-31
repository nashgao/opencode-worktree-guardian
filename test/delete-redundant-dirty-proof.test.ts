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
import { buildSafetyRef } from "../src/git.ts";

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

test("redundant dirty proof treats pathspec magic prefixes as literal dirty paths", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const globPath = ":(glob)literal.txt";
  const excludePath = ":(exclude)literal.txt";
  const globSame = await createGuardianWorktree(repo, "ses_redundant_dirty_literal_glob_same");
  const excludeSame = await createGuardianWorktree(repo, "ses_redundant_dirty_literal_exclude_same");
  const globDifferent = await createGuardianWorktree(repo, "ses_redundant_dirty_literal_glob_different");
  const excludeDifferent = await createGuardianWorktree(repo, "ses_redundant_dirty_literal_exclude_different");
  await fs.writeFile(path.join(repo, globPath), "base glob\n");
  await fs.writeFile(path.join(repo, excludePath), "base exclude\n");
  await git(repo, ["--literal-pathspecs", "add", "-A", "--", globPath, excludePath]);
  await git(repo, ["commit", "-m", "advance base with literal pathspec names"]);
  await git(repo, ["push", "origin", "main"]);
  await fs.writeFile(path.join(globSame.session.worktree_path, globPath), "base glob\n");
  await fs.writeFile(path.join(excludeSame.session.worktree_path, excludePath), "base exclude\n");
  await fs.writeFile(path.join(globDifferent.session.worktree_path, globPath), "different glob\n");
  await fs.writeFile(path.join(excludeDifferent.session.worktree_path, excludePath), "different exclude\n");

  const globSameResult = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_literal_glob_same", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });
  const excludeSameResult = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_literal_exclude_same", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });
  const globDifferentResult = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_literal_glob_different", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });
  const excludeDifferentResult = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_literal_exclude_different", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });

  assert.equal(globSameResult.ok, true);
  assert.equal(excludeSameResult.ok, true);
  assert.equal(globDifferentResult.ok, false);
  assert.match(globDifferentResult.reason, /redundant dirty proof/i);
  assert.equal(excludeDifferentResult.ok, false);
  assert.match(excludeDifferentResult.reason, /redundant dirty proof/i);
  assert.equal((await worktreePaths(repo)).includes(globDifferent.session.worktree_path), true);
  assert.equal((await worktreePaths(repo)).includes(excludeDifferent.session.worktree_path), true);
});

test("redundant dirty proof plans a deleted literal exclusion path absent from base", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const deletedPath = ":(exclude)deleted.txt";
  await advanceBase(repo, "seed literal deletion path", [{ file: deletedPath, content: "remove on base\n" }]);
  const start = await createGuardianWorktree(repo, "ses_redundant_dirty_literal_deleted");
  await advanceBase(repo, "remove literal deletion path", [{ file: deletedPath, content: null }]);
  await fs.rm(path.join(start.session.worktree_path, deletedPath));

  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_literal_deleted", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.match(JSON.stringify(plan.preflight.redundantDirtyProofs), /"path":":\(exclude\)deleted\.txt"/);
  assert.match(JSON.stringify(plan.preflight.redundantDirtyProofs), /"kind":"tracked-deleted"/);
});

test("redundant dirty apply restores only its planned literal path after safety-ref drift", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "ses_redundant_dirty_literal_restore";
  const branch = "guardian/redundant-dirty-literal-restore";
  const approvedPath = ":(exclude)approved.txt";
  const unapprovedPath = "unapproved.txt";
  await fs.writeFile(path.join(repo, approvedPath), "initial\n");
  await fs.writeFile(path.join(repo, unapprovedPath), "initial\n");
  await git(repo, ["--literal-pathspecs", "add", "--", approvedPath, unapprovedPath]);
  await git(repo, ["commit", "-m", "seed tracked literal paths"]);
  await git(repo, ["push", "origin", "main"]);
  const start = await createGuardianWorktree(repo, sessionId, "redundant dirty literal restore", branch);
  await fs.writeFile(path.join(repo, approvedPath), "base\n");
  await git(repo, ["--literal-pathspecs", "add", "--", approvedPath]);
  await git(repo, ["commit", "-m", "advance approved literal path"]);
  await git(repo, ["push", "origin", "main"]);
  const worktree = start.session.worktree_path;
  await fs.writeFile(path.join(worktree, approvedPath), "base\n");
  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId, allowRedundantDirtyPaths: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG }, {
    afterSafetyRefCreated: async () => fs.writeFile(path.join(worktree, unapprovedPath), "late\n"),
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(String(result.reason), /redundant dirty cleanup left uncommitted changes/);
  assert.equal(typeof result.dirtySnapshotCommit, "string");
  assert.equal(await refExists(repo, String(result.dirtySnapshotRef)), true);
  const snapshotParent = (await git(repo, ["rev-parse", `${String(result.dirtySnapshotCommit)}^`])).stdout;
  const snapshotPaths = (await git(repo, ["diff", "--name-only", snapshotParent, String(result.dirtySnapshotCommit)])).stdout.split("\n");
  assert.equal(snapshotParent, start.session.head_commit);
  assert.deepEqual(snapshotPaths, [approvedPath]);
  assert.equal(await fs.readFile(path.join(worktree, approvedPath), "utf8"), "initial\n");
  assert.equal(await fs.readFile(path.join(worktree, unapprovedPath), "utf8"), "late\n");
  assert.equal((await worktreePaths(repo)).includes(worktree), true);
  assert.equal(await branchExists(repo, branch), true);
  assert.equal(await refExists(repo, String(plan.preflight.safetyRef)), true);
  assert.equal(findSession(await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG }), sessionId).status, "active");
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

test("redundant dirty apply blocks on a colliding snapshot ref before removing the worktree", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "ses_redundant_dirty_collision";
  const branch = "guardian/redundant-dirty-collision";
  const timestamp = "20260727T084040";
  const start = await createGuardianWorktree(repo, sessionId, "redundant dirty collision", branch);
  await advanceBase(repo, "advance base for collision", [{ file: "README.md", content: "collision base\n" }]);
  await fs.writeFile(path.join(start.session.worktree_path, "README.md"), "collision base\n");
  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG, timestamp });
  assert.equal(plan.ok, true);
  const snapshotRef = buildSafetyRef(sessionId, `redundant-dirty/${branch}`, timestamp);
  const originalTarget = (await git(start.session.worktree_path, ["rev-parse", "HEAD"])).stdout;
  await git(repo, ["update-ref", snapshotRef, originalTarget]);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId, allowRedundantDirtyPaths: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal((await git(repo, ["rev-parse", snapshotRef])).stdout, originalTarget);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal(findSession(await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG }), sessionId).status, "active");
});
