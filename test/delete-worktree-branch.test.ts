import {
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
  recordSession,
  test,
  worktreePaths,
} from "./delete-fixtures.js";

async function commitUnmerged(worktree: string): Promise<string> {
  await fs.writeFile(path.join(worktree, "unmerged.txt"), "unmerged\n");
  await git(worktree, ["add", "unmerged.txt"]);
  await git(worktree, ["commit", "-m", "unmerged abandonment candidate"]);
  return (await git(worktree, ["rev-parse", "HEAD"])).stdout;
}

async function advancedCommit(repo: string, head: string): Promise<string> {
  const tree = (await git(repo, ["rev-parse", `${head}^{tree}`])).stdout;
  return (await git(repo, ["commit-tree", tree, "-p", head, "-m", "advance abandonment branch"])).stdout;
}

test("worktree abandonment preserves a branch advanced after plan", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "final-review-worktree-cas";
  const branch = "guardian/final-review-worktree-cas";
  const started = await createGuardianWorktree(repo, sessionId, "worktree CAS", branch);
  const head = await commitUnmerged(started.session.worktree_path);
  const advanced = await advancedCommit(repo, head);
  const request = { repoRoot: repo, cwd: repo, sessionId, deleteBranch: true, abandonUnmerged: true, config: DEFAULT_CONFIG, timestamp: "20260730T010101" };
  const plan = await deleteWorktree({ ...request, mode: "plan" });

  const result = await deleteWorktree({ ...request, mode: "apply", confirmToken: plan.confirmToken }, {
    afterSafetyRefCreated: async () => {
      await git(repo, ["update-ref", `refs/heads/${branch}`, advanced]);
    },
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "partial");
  assert.equal(result.worktreeRemoved, true);
  assert.equal(result.branchDeleted, false);
  assert.equal(await branchExists(repo, branch), true);
  assert.equal((await git(repo, ["rev-parse", `refs/heads/${branch}`])).stdout, advanced);
});

test("apply creates a safety ref, removes only the worktree, and keeps the branch by default", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_delete_apply", "delete apply", "guardian/delete-apply");
  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", targetPath: start.session.worktree_path, config: DEFAULT_CONFIG, timestamp: "20260601T120000" });

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", targetPath: start.session.worktree_path, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T120000" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "deleted");
  assert.equal(result.branchDeleted, false);
  assert.equal(result.worktreeRemoved, true);
  assert.match(result.safetyRef, /^refs\/opencode-guardian\/ses_delete_apply\/guardian\/delete-apply\//);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), false);
  assert.equal(await branchExists(repo, "guardian/delete-apply"), true);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.safetyRefs.some((ref: Record<string, unknown>) => ref.name === result.safetyRef), true);
  const session = findSession(status, "ses_delete_apply");
  assert.equal(session.status, "deleted");
  assert.deepEqual(session.safety_refs, [result.safetyRef]);
  assert.equal(status.orphanedSessions.some((candidate: Record<string, unknown>) => candidate.session_id === "ses_delete_apply"), false);
});

test("implicit worktree-only deletion blocks before stranding an unmerged branch", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/delete-implicit-retain-unmerged";
  const sessionId = "ses_delete_implicit_retain_unmerged";
  const start = await createGuardianWorktree(repo, sessionId, "implicit retain unmerged", branch);
  await fs.writeFile(path.join(start.session.worktree_path, "feature.txt"), "unmerged but retained\n");
  await git(start.session.worktree_path, ["add", "feature.txt"]);
  await git(start.session.worktree_path, ["commit", "-m", "unmerged retained branch"]);
  const { stdout: head } = await git(start.session.worktree_path, ["rev-parse", "HEAD"]);

  const blocked = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, config: DEFAULT_CONFIG });

  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /deleteBranch was not specified/);
  assert.equal(blocked.preflight.ancestryProven, false);
  assert.equal(blocked.preflight.unmergedCommitCount, 1);
  assert.deepEqual(blocked.preflight.unmergedCommits, [{ commit: head, subject: "unmerged retained branch" }]);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal(await branchExists(repo, branch), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG })).safetyRefs.length, 0);

  const explicitRetain = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, deleteBranch: false, config: DEFAULT_CONFIG });
  assert.equal(explicitRetain.ok, true);
  assert.equal(explicitRetain.status, "planned");
  assert.equal(explicitRetain.preflight.deleteBranch, false);
  assert.equal(explicitRetain.preflight.ancestryProven, false);
  assert.equal(explicitRetain.preflight.unmergedCommitCount, 1);
});

test("abandonUnmerged=true plans and applies explicit unmerged worktree abandon", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/delete-abandon-unmerged";
  const sessionId = "ses_delete_abandon_unmerged";
  const start = await createGuardianWorktree(repo, sessionId, "abandon unmerged", branch);
  await fs.writeFile(path.join(start.session.worktree_path, "feature.txt"), "abandoned but recoverable\n");
  await git(start.session.worktree_path, ["add", "feature.txt"]);
  await git(start.session.worktree_path, ["commit", "-m", "unmerged abandon candidate"]);
  const { stdout: head } = await git(start.session.worktree_path, ["rev-parse", "HEAD"]);

  const blocked = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, deleteBranch: true, config: DEFAULT_CONFIG });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /not proven reachable/);
  assert.equal(blocked.preflight.ancestryProven, false);
  assert.equal(blocked.preflight.unmergedCommitCount, 1);

  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, deleteBranch: true, abandonUnmerged: true, config: DEFAULT_CONFIG, timestamp: "20260601T180000" });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.preflight.abandonUnmerged, true);
  assert.equal(plan.preflight.ancestryProven, false);
  assert.equal(plan.preflight.unmergedCommitCount, 1);
  assert.deepEqual(plan.preflight.unmergedCommits, [{ commit: head, subject: "unmerged abandon candidate" }]);

  const mismatched = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId, deleteBranch: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T180000" });
  assert.equal(mismatched.ok, false);
  assert.match(mismatched.reason, /not proven reachable/);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal(await branchExists(repo, branch), true);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId, deleteBranch: true, abandonUnmerged: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T180000" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "abandoned");
  assert.equal(result.branchDeleted, true);
  assert.equal(result.worktreeRemoved, true);
  assert.equal(result.abandonUnmerged, true);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), false);
  assert.equal(await branchExists(repo, branch), false);
  assert.match(result.safetyRef, /^refs\/opencode-guardian\/ses_delete_abandon_unmerged\/guardian\/delete-abandon-unmerged\//);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const session = findSession(status, sessionId);
  assert.equal(session.status, "abandoned");
  assert.equal(session.deleted_worktree_path, start.session.worktree_path);
  assert.equal(session.deleted_branch, branch);
  assert.equal(session.abandon_unmerged, true);
  assert.equal(session.abandoned_branch, branch);
  assert.deepEqual(session.unmerged_commits, [{ commit: head, subject: "unmerged abandon candidate" }]);
});

test("abandonUnmerged=true requires deleteBranch=true", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", abandonUnmerged: true, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /requires deleteBranch=true/);
});

test("abandonUnmerged=true blocks when unmerged commit evidence cannot be listed", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/delete-abandon-missing-base";
  const sessionId = "ses_delete_abandon_missing_base";
  const start = await createGuardianWorktree(repo, sessionId, "abandon missing base", branch);
  await fs.writeFile(path.join(start.session.worktree_path, "feature.txt"), "unmerged without base\n");
  await git(start.session.worktree_path, ["add", "feature.txt"]);
  await git(start.session.worktree_path, ["commit", "-m", "unmerged without listed base"]);

  await recordSession(repo, DEFAULT_CONFIG, {
    ...start.session,
    base_ref: "origin/missing-base",
  });

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, deleteBranch: true, abandonUnmerged: true, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /unmerged commits could not be listed/);
  assert.equal(result.preflight.ancestryProven, false);
  assert.equal(result.preflight.unmergedCommitCount, 0);
  assert.equal(typeof result.preflight.unmergedCommitError, "string");
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal(await branchExists(repo, branch), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG })).safetyRefs.length, 0);
});

test("deleteBranch=true deletes an ancestor branch with non-force branch deletion", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_delete_branch", "delete branch", "guardian/delete-branch");
  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", branch: "guardian/delete-branch", deleteBranch: true, config: DEFAULT_CONFIG });

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", branch: "guardian/delete-branch", deleteBranch: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.equal(result.branchDeleted, true);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), false);
  assert.equal(await branchExists(repo, "guardian/delete-branch"), false);
});

test("worktree deletion removes a racing symbolic branch without mutating its protected referent", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/symbolic-delete-race";
  const protectedBranch = "main";
  const started = await createGuardianWorktree(repo, "ses_symbolic_delete_race", "symbolic delete race", branch);
  const protectedHead = (await git(repo, ["rev-parse", `refs/heads/${protectedBranch}`])).stdout;
  const request = { repoRoot: repo, cwd: repo, mode: "plan" as const, branch, deleteBranch: true, config: DEFAULT_CONFIG, timestamp: "20260730T020202" };
  const plan = await deleteWorktree(request);

  const result = await deleteWorktree({ ...request, mode: "apply", confirmToken: plan.confirmToken }, {
    afterSafetyRefCreated: async () => {
      await git(repo, ["symbolic-ref", `refs/heads/${branch}`, `refs/heads/${protectedBranch}`]);
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "deleted");
  assert.equal(result.worktreeRemoved, true);
  assert.equal(result.branchDeleted, true);
  await assert.rejects(git(repo, ["symbolic-ref", "--no-recurse", `refs/heads/${branch}`]));
  assert.equal((await git(repo, ["rev-parse", `refs/heads/${protectedBranch}`])).stdout, protectedHead);
  assert.equal((await worktreePaths(repo)).includes(started.session.worktree_path), false);
});

test("deleteBranch=true deletes a Guardian orphan branch when the recorded worktree is absent", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/delete-orphan-branch";
  const sessionId = "ses_delete_orphan_branch";
  const absentWorktree = path.join(repo, ".worktrees", "opencode-worktree-guardian", "guardian-session-ses-orphan");
  await git(repo, ["branch", branch, "main"]);
  const { stdout: head } = await git(repo, ["rev-parse", branch]);
  await recordSession(repo, DEFAULT_CONFIG, {
    session_id: sessionId,
    status: "active",
    branch,
    worktree_path: absentWorktree,
    base_ref: "origin/main",
    head_commit: head,
  });
  await fs.writeFile(path.join(repo, "orphan-branch-stashed.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "orphan branch stash"]);

  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, deleteBranch: true, config: DEFAULT_CONFIG, timestamp: "20260601T160000" });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.preflight.targetKind, "orphan-branch");
  assert.equal(plan.preflight.targetPath, absentWorktree);
  assert.equal(plan.preflight.branch, branch);
  assert.equal(plan.preflight.head, head);
  assert.equal(plan.preflight.worktreeListed, false);
  assert.equal(plan.preflight.stashCount, 1);
  assert.equal(Array.isArray(plan.preflight.stashes) ? plan.preflight.stashes.length : 0, 1);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId, deleteBranch: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T160000" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "deleted");
  assert.equal(result.branchDeleted, true);
  assert.equal(result.worktreeRemoved, false);
  assert.equal(await branchExists(repo, branch), false);
  assert.match(result.safetyRef, /^refs\/opencode-guardian\/ses_delete_orphan_branch\/guardian\/delete-orphan-branch\//);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const session = findSession(status, sessionId);
  assert.equal(session.status, "deleted");
  assert.equal(session.deleted_worktree_path, absentWorktree);
  assert.equal(session.deleted_branch, branch);
  assert.equal(session.branch_only_delete, true);
  assert.equal(status.stateBranchesWithoutWorktrees.includes(branch), false);
});
