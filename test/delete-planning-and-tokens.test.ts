import {
  assert,
  assertNoExpectedToken,
  branchExists,
  createGuardianWorktree,
  createRepoWithOrigin,
  DEFAULT_CONFIG,
  deleteWorktree,
  findSession,
  fs,
  fs as fixtureFs,
  git,
  guardianStatus,
  path,
  refExists,
  test,
  worktreePaths,
} from "./delete-fixtures.js";
import { setDeletionFingerprintTestHookForTesting } from "../src/deletion-fingerprint.ts";

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

test("direct apply blocks an unrecorded same-OID planned safety ref", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "ses_delete_unrecorded_same_oid";
  const branch = "guardian/delete-unrecorded-same-oid";
  const start = await createGuardianWorktree(repo, sessionId, "unrecorded same OID", branch);
  const timestamp = "20260728T120000";
  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", targetPath: start.session.worktree_path, deleteBranch: false, timestamp, config: DEFAULT_CONFIG });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const safetyRef = String(plan.preflight.safetyRef);
  const { stdout: head } = await git(start.session.worktree_path, ["rev-parse", "HEAD"]);
  await git(repo, ["update-ref", safetyRef, head]);
  const sessionBeforeApply = findSession(await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG }), sessionId);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", targetPath: start.session.worktree_path, deleteBranch: false, confirmToken: plan.confirmToken, timestamp, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /safety ref could not be created/);
  assert.equal((await git(repo, ["rev-parse", safetyRef])).stdout, head);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal(await branchExists(repo, branch), true);
  const sessionAfterApply = findSession(await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG }), sessionId);
  assert.deepEqual(sessionAfterApply, sessionBeforeApply);
  assert.equal(sessionAfterApply.status, "active");
  assert.deepEqual(sessionAfterApply.safety_refs ?? [], []);
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

const lateIgnoredChanges = ["added", "changed-bytes", "changed-symlink", "changed-type"] as const;

for (const change of lateIgnoredChanges) {
  test(`delete blocks ${change} ignored data introduced at the deletion boundary`, async (t) => {
    const { base, repo } = await createRepoWithOrigin();
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const sessionId = `ses_delete_boundary_${change}`;
    const branch = `guardian/delete-boundary-${change}`;
    const start = await createGuardianWorktree(repo, sessionId, `delete boundary ${change}`, branch);
    const worktree = start.session.worktree_path;
    const ignoredDirectory = path.join(worktree, ".claude");
    const ignoredPath = path.join(ignoredDirectory, "state");

    await fs.writeFile(path.join(worktree, ".gitignore"), ".claude/\n");
    await fs.writeFile(path.join(worktree, "target-a.txt"), "a\n");
    await fs.writeFile(path.join(worktree, "target-b.txt"), "b\n");
    await git(worktree, ["add", ".gitignore", "target-a.txt", "target-b.txt"]);
    await git(worktree, ["commit", "-m", "prepare deletion-boundary ignored data"]);
    await fs.mkdir(ignoredDirectory, { recursive: true });
    if (change === "changed-symlink") await fs.symlink("../target-a.txt", ignoredPath);
    else await fs.writeFile(ignoredPath, "planned\n");

    const timestamp = `20260729T1${change.length}000`;
    const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, deleteBranch: false, allowIgnoredFiles: true, timestamp, config: DEFAULT_CONFIG });
    assert.equal(plan.ok, true, JSON.stringify(plan));

    const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId, deleteBranch: false, allowIgnoredFiles: true, confirmToken: plan.confirmToken, timestamp, config: DEFAULT_CONFIG }, {
      beforeWorktreeRemoval: async () => {
        if (change === "added") await fs.writeFile(path.join(ignoredDirectory, "late"), "late\n");
        else if (change === "changed-bytes") await fs.writeFile(ignoredPath, "changed\n");
        else if (change === "changed-symlink") {
          await fs.rm(ignoredPath);
          await fs.symlink("../target-b.txt", ignoredPath);
        } else {
          await fs.rm(ignoredPath);
          await fs.symlink("../target-a.txt", ignoredPath);
        }
      },
    });

    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.status, "blocked");
    assert.match(String(result.reason), /ignored-file consent changed at deletion boundary/i);
    assert.equal(result.requiresFreshPlan, true);
    assert.equal((await worktreePaths(repo)).includes(worktree), true);
    assert.equal(await branchExists(repo, branch), true);
    await git(repo, ["rev-parse", "--verify", String(plan.preflight.safetyRef)]);
    if (change === "added") await fs.access(path.join(ignoredDirectory, "late"));
    else if (change === "changed-bytes") assert.equal(await fs.readFile(ignoredPath, "utf8"), "changed\n");
    else assert.equal((await fs.lstat(ignoredPath)).isSymbolicLink(), true);
  });
}

test("locked non-force removal rescans and preserves current ignored inventory", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "ses_delete_locked_ignored_rescan";
  const branch = "guardian/delete-locked-ignored-rescan";
  const start = await createGuardianWorktree(repo, sessionId, "locked ignored rescan", branch);
  const worktree = start.session.worktree_path;
  const ignoredDirectory = path.join(worktree, ".claude");
  const ignoredPath = path.join(ignoredDirectory, "state");

  await fs.writeFile(path.join(worktree, ".gitignore"), ".claude/\n");
  await git(worktree, ["add", ".gitignore"]);
  await git(worktree, ["commit", "-m", "prepare locked ignored rescan"]);
  await fs.mkdir(ignoredDirectory, { recursive: true });
  await fs.writeFile(ignoredPath, "planned\n");
  await fs.writeFile(path.join(ignoredDirectory, "late"), "late\n");
  const timestamp = "20260729T171500";
  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, deleteBranch: false, allowIgnoredFiles: true, timestamp, config: DEFAULT_CONFIG });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  await git(repo, ["worktree", "lock", "--reason", "prove non-force removal", worktree]);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId, deleteBranch: false, allowIgnoredFiles: true, confirmToken: plan.confirmToken, timestamp, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.match(String(result.reason), /worktree removal failed at deletion boundary/i);
  assert.match(String(result.error), /locked/i);
  assert.equal(result.requiresFreshPlan, true);
  assert.deepEqual(result.ignoredFiles, [".claude/late", ".claude/state"]);
  assert.deepEqual(result.preflight.finalIgnoredFiles, [".claude/late", ".claude/state"]);
  assert.equal((await worktreePaths(repo)).includes(worktree), true);
  assert.equal(await branchExists(repo, branch), true);
  assert.equal(await fs.readFile(path.join(ignoredDirectory, "late"), "utf8"), "late\n");
});

test("Guardian returns a structured boundary block when an ignored root disappears during planning", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(async () => {
    setDeletionFingerprintTestHookForTesting(undefined);
    await fixtureFs.rm(base, { recursive: true, force: true });
  });
  const sessionId = "ses_deletion_fingerprint_missing_root";
  const branch = "guardian/deletion-fingerprint-missing-root";
  const start = await createGuardianWorktree(repo, sessionId, "deletion fingerprint missing root", branch);
  const worktree = start.session.worktree_path;
  const ignoredDirectory = path.join(worktree, "ignored-output");
  const ignoredPath = path.join(ignoredDirectory, "planned.log");
  await fixtureFs.writeFile(path.join(worktree, ".gitignore"), "ignored-output/\n");
  await git(worktree, ["add", ".gitignore"]);
  await git(worktree, ["commit", "-m", "ignore missing fingerprint root"]);
  await fixtureFs.mkdir(ignoredDirectory);
  await fixtureFs.writeFile(ignoredPath, "planned\n");
  setDeletionFingerprintTestHookForTesting({
    beforeLstat: async (absolutePath) => {
      if (absolutePath === ignoredPath) await fixtureFs.rm(ignoredPath);
    },
  });

  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, deleteBranch: false, allowIgnoredFiles: true, config: DEFAULT_CONFIG, timestamp: "20260729T181000" });

  setDeletionFingerprintTestHookForTesting(undefined);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.deepEqual(plan.preflight.ignoredFileFingerprint, []);
  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId, deleteBranch: false, allowIgnoredFiles: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260729T181000" });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /confirm token mismatch/i);
  assert.deepEqual(result.preflight.ignoredFiles, []);
  assert.deepEqual(result.preflight.ignoredFileFingerprint, []);
  assert.equal((await worktreePaths(repo)).includes(worktree), true);
  assert.equal(await branchExists(repo, branch), true);
  assert.equal(await refExists(repo, String(plan.preflight.safetyRef)), false);
  const session = findSession(await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG }), sessionId);
  assert.equal(session.status, "active");
  assert.equal(session.safety_refs?.includes(String(plan.preflight.safetyRef)) ?? false, false);
  assert.equal(Object.hasOwn(session, "worktree_delete_failed"), false);
});
