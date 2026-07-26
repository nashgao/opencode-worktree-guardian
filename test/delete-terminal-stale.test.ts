import {
  assert,
  branchExists,
  createRepoWithOrigin,
  DEFAULT_CONFIG,
  deleteWorktree,
  fs,
  git,
  guardianStatus,
  path,
  recordSession,
  test,
} from "./delete-fixtures.js";

test("deleteBranch=true cleans stale branches for finished and preserved terminal sessions", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));

  for (const status of ["finished", "preserved"]) {
    const branch = `guardian/delete-stale-${status}`;
    const sessionId = `ses_delete_stale_${status}`;
    const absentWorktree = path.join(repo, ".worktrees", "opencode-worktree-guardian", `guardian-session-ses-stale-${status}`);
    await git(repo, ["branch", branch, "main"]);
    const { stdout: head } = await git(repo, ["rev-parse", branch]);
    await recordSession(repo, DEFAULT_CONFIG, {
      session_id: sessionId,
      status,
      branch,
      worktree_path: absentWorktree,
      base_ref: "origin/main",
      head_commit: head,
    });

    const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, deleteBranch: true, config: DEFAULT_CONFIG, timestamp: `20260601T19${status.length}500` });
    assert.equal(plan.ok, true, status);
    assert.equal(plan.preflight.targetKind, "stale-branch", status);
    assert.equal(plan.preflight.ownershipProof, "terminal-session", status);

    const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId, deleteBranch: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: `20260601T19${status.length}500` });

    assert.equal(result.ok, true, status);
    assert.equal(result.status, "deleted", status);
    assert.equal(result.branchDeleted, true, status);
    assert.equal(result.worktreeRemoved, false, status);
    assert.equal(await branchExists(repo, branch), false, status);
  }
});

test("deleteBranch=true by deleted sessionId still requires abandonUnmerged for unmerged stale branch", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/delete-stale-session-abandon";
  const sessionId = "ses_delete_stale_session_abandon";
  const absentWorktree = path.join(repo, ".worktrees", "opencode-worktree-guardian", "guardian-session-ses-stale-session-abandon");
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, "stale-session-abandon.txt"), "unmerged stale session branch\n");
  await git(repo, ["add", "stale-session-abandon.txt"]);
  await git(repo, ["commit", "-m", "unmerged stale session abandon candidate"]);
  const { stdout: head } = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["checkout", "main"]);
  await recordSession(repo, DEFAULT_CONFIG, {
    session_id: sessionId,
    status: "deleted",
    branch,
    worktree_path: absentWorktree,
    base_ref: "origin/main",
    head_commit: head,
  });

  const blocked = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, deleteBranch: true, config: DEFAULT_CONFIG });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /not proven reachable/);
  assert.equal(blocked.preflight.targetKind, "stale-branch");
  assert.equal(blocked.preflight.unmergedCommitCount, 1);

  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, deleteBranch: true, abandonUnmerged: true, config: DEFAULT_CONFIG, timestamp: "20260601T190600" });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.preflight.targetKind, "stale-branch");
  assert.equal(plan.preflight.ancestryProven, false);
  assert.deepEqual(plan.preflight.unmergedCommits, [{ commit: head, subject: "unmerged stale session abandon candidate" }]);
});

test("deleteBranch=true deletes a stale branch when Guardian safety refs prove ownership", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/delete-stale-safety-ref";
  await git(repo, ["branch", branch, "main"]);
  const { stdout: head } = await git(repo, ["rev-parse", branch]);
  await git(repo, ["update-ref", "refs/opencode-guardian/ses_ref/guardian/delete-stale-safety-ref/20260601T191000", head]);

  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", branch, deleteBranch: true, config: DEFAULT_CONFIG, timestamp: "20260601T191000" });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.preflight.targetKind, "stale-branch");
  assert.equal(plan.preflight.ownershipProof, "safety-ref");
  assert.equal(plan.preflight.targetPath, null);
  assert.equal(plan.preflight.branch, branch);
  assert.equal(plan.preflight.head, head);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", branch, deleteBranch: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T191000" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "deleted");
  assert.equal(result.branchDeleted, true);
  assert.equal(result.worktreeRemoved, false);
  assert.equal(await branchExists(repo, branch), false);
  assert.match(result.safetyRef, /^refs\/opencode-guardian\/orphan-guardian-branch\/guardian\/delete-stale-safety-ref\//);
});

test("deleteBranch=true blocks Guardian-prefixed stale branches without ownership proof", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/delete-stale-unproved";
  await git(repo, ["branch", branch, "main"]);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", branch, deleteBranch: true, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /branch is not checked out/);
  assert.equal(await branchExists(repo, branch), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG })).safetyRefs.length, 0);
});

test("deleteBranch=true does not treat a parent branch safety ref as stale ownership proof", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/foo/bar";
  await git(repo, ["branch", branch, "main"]);
  const { stdout: head } = await git(repo, ["rev-parse", branch]);
  await git(repo, ["update-ref", "refs/opencode-guardian/ses_ref/guardian/foo/20260601T191500", head]);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", branch, deleteBranch: true, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /branch is not checked out/);
  assert.equal(await branchExists(repo, branch), true);
});

test("deleteBranch=true blocks terminal stale branch proof when recorded head differs", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/delete-stale-head-mismatch";
  const sessionId = "ses_delete_stale_head_mismatch";
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, "stale-head.txt"), "first head\n");
  await git(repo, ["add", "stale-head.txt"]);
  await git(repo, ["commit", "-m", "first stale head"]);
  const { stdout: recordedHead } = await git(repo, ["rev-parse", "HEAD"]);
  await fs.writeFile(path.join(repo, "stale-head.txt"), "second head\n");
  await git(repo, ["add", "stale-head.txt"]);
  await git(repo, ["commit", "-m", "second stale head"]);
  await git(repo, ["checkout", "main"]);
  await recordSession(repo, DEFAULT_CONFIG, {
    session_id: sessionId,
    status: "deleted",
    branch,
    worktree_path: path.join(repo, ".worktrees", "opencode-worktree-guardian", "guardian-session-ses-stale-head-mismatch"),
    base_ref: "origin/main",
    head_commit: recordedHead,
  });

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", branch, deleteBranch: true, abandonUnmerged: true, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /branch is not checked out/);
  assert.equal(await branchExists(repo, branch), true);
});
