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
  git,
  guardianStatus,
  path,
  recordSession,
  test,
  worktreePaths,
} from "./delete-fixtures.js";
import { proveCleanCompletionUniverse } from "../src/clean-completion-universe.ts";

test("abandonUnmerged=true is required for unmerged stale branch deletion", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/delete-stale-abandon";
  const sessionId = "ses_delete_stale_abandon";
  const absentWorktree = path.join(repo, ".worktrees", "opencode-worktree-guardian", "guardian-session-ses-stale-abandon");
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, "stale-abandon.txt"), "unmerged stale branch\n");
  await git(repo, ["add", "stale-abandon.txt"]);
  await git(repo, ["commit", "-m", "unmerged stale abandon candidate"]);
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

  const blocked = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", branch, deleteBranch: true, config: DEFAULT_CONFIG });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /not proven reachable/);
  assert.equal(blocked.preflight.targetKind, "stale-branch");
  assert.equal(blocked.preflight.unmergedCommitCount, 1);

  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", branch, deleteBranch: true, abandonUnmerged: true, config: DEFAULT_CONFIG, timestamp: "20260601T192000" });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.preflight.targetKind, "stale-branch");
  assert.equal(plan.preflight.ancestryProven, false);
  assert.deepEqual(plan.preflight.unmergedCommits, [{ commit: head, subject: "unmerged stale abandon candidate" }]);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", branch, deleteBranch: true, abandonUnmerged: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T192000" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "abandoned");
  assert.equal(result.branchDeleted, true);
  assert.equal(await branchExists(repo, branch), false);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const session = findSession(status, sessionId);
  assert.equal(session.status, "abandoned");
  assert.equal(session.branch_only_delete, true);
  assert.equal(session.abandoned_branch, branch);
  assert.deepEqual(session.unmerged_commits, [{ commit: head, subject: "unmerged stale abandon candidate" }]);
});

test("deleteBranch=true blocks stale branch cleanup when explicit targets conflict", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/delete-stale-conflict";
  const conflictingBranch = "guardian/delete-stale-other";
  await git(repo, ["branch", branch, "main"]);
  await git(repo, ["branch", conflictingBranch, "main"]);
  const { stdout: head } = await git(repo, ["rev-parse", branch]);
  await recordSession(repo, DEFAULT_CONFIG, {
    session_id: "ses_delete_stale_conflict",
    status: "deleted",
    branch: conflictingBranch,
    worktree_path: path.join(repo, ".worktrees", "opencode-worktree-guardian", "guardian-session-ses-stale-conflict"),
    base_ref: "origin/main",
    head_commit: head,
  });

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_delete_stale_conflict", branch, deleteBranch: true, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /target inputs conflict/);
  assert.equal(await branchExists(repo, branch), true);
  assert.equal(await branchExists(repo, conflictingBranch), true);
});

test("deleteBranch=true blocks stale branch cleanup when branch is paired with unknown session", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/delete-stale-unknown-session";
  const sessionId = "ses_delete_stale_unknown_session";
  await git(repo, ["branch", branch, "main"]);
  const { stdout: head } = await git(repo, ["rev-parse", branch]);
  await recordSession(repo, DEFAULT_CONFIG, {
    session_id: sessionId,
    status: "deleted",
    branch,
    worktree_path: path.join(repo, ".worktrees", "opencode-worktree-guardian", "guardian-session-ses-stale-unknown-session"),
    base_ref: "origin/main",
    head_commit: head,
  });

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_missing", branch, deleteBranch: true, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /target inputs conflict/);
  assert.match(result.reason, /provide exactly one/);
  assert.equal(await branchExists(repo, branch), true);
});

test("deleteBranch=true deletes a merged local non-Guardian branch through plan/apply", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "feature/delete-merged-local";
  await git(repo, ["branch", branch, "main"]);
  const { stdout: head } = await git(repo, ["rev-parse", branch]);

  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", branch, deleteBranch: true, config: DEFAULT_CONFIG, timestamp: "20260601T201000" });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.preflight.targetKind, "merged-branch");
  assert.equal(plan.preflight.ownershipProof, "ancestry-proof");
  assert.equal(plan.preflight.targetPath, null);
  assert.equal(plan.preflight.branch, branch);
  assert.equal(plan.preflight.head, head);
  assert.equal(plan.preflight.ancestryProven, true);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", branch, deleteBranch: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T201000" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "deleted");
  assert.equal(result.branchDeleted, true);
  assert.equal(result.worktreeRemoved, false);
  assert.match(result.safetyRef, /^refs\/opencode-guardian\/merged-local-branch\/feature\/delete-merged-local\//);
  assert.equal(await branchExists(repo, branch), false);
});

test("branch-only merged cleanup safety refs permit a stable clean-completion proof", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "feature/delete-merged-clean-proof";
  await git(repo, ["branch", branch, "main"]);
  const { stdout: head } = await git(repo, ["rev-parse", branch]);
  await recordSession(repo, DEFAULT_CONFIG, {
    session_id: "ses_delete_merged_clean_proof_baseline",
    status: "deleted",
    branch: "guardian/old-clean-proof",
    worktree_path: path.join(repo, ".worktrees", "opencode-worktree-guardian", "guardian-old-clean-proof"),
    base_ref: "origin/main",
    head_commit: head,
  });

  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", branch, deleteBranch: true, config: DEFAULT_CONFIG, timestamp: "20260601T201500" });
  assert.equal(plan.ok, true);
  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", branch, deleteBranch: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T201500" });
  assert.equal(result.ok, true);
  assert.equal(await branchExists(repo, branch), false);
  assert.equal(result.safetyRef.endsWith(`/commit/${head}/20260601T201500`), true);

  const proof = await proveCleanCompletionUniverse({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(proof.status, "stable", proof.reason);
});

test("deleteBranch=true blocks merged local branch cleanup when branch is checked out", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "feature/delete-checked-out-local";
  await git(repo, ["checkout", "-b", branch]);
  await git(repo, ["checkout", "main"]);
  const worktree = path.join(base, "checked-out-feature");
  await git(repo, ["worktree", "add", worktree, branch]);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", branch, deleteBranch: true, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /outside the Guardian worktree root|checked out/);
  assert.equal(await branchExists(repo, branch), true);
});

test("apply blocks when ignored target files change after allowIgnoredFiles plan", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_delete_ignored_token", "delete ignored token", "guardian/delete-ignored-token");
  await fs.writeFile(path.join(start.session.worktree_path, ".gitignore"), "ignored-output/\n");
  await git(start.session.worktree_path, ["add", ".gitignore"]);
  await git(start.session.worktree_path, ["commit", "-m", "ignore generated output for token"]);
  await fs.mkdir(path.join(start.session.worktree_path, "ignored-output"), { recursive: true });
  await fs.writeFile(path.join(start.session.worktree_path, "ignored-output", "first.log"), "first\n");
  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_delete_ignored_token", allowIgnoredFiles: true, config: DEFAULT_CONFIG });

  await fs.writeFile(path.join(start.session.worktree_path, "ignored-output", "second.log"), "second\n");
  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId: "ses_delete_ignored_token", allowIgnoredFiles: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /confirm token/i);
  assertNoExpectedToken(result);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal(await branchExists(repo, "guardian/delete-ignored-token"), true);
});

test("deleteBranch=true reports partial success when branch deletion fails after worktree removal", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_delete_partial", "delete partial", "guardian/delete-partial");
  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", branch: "guardian/delete-partial", deleteBranch: true, config: DEFAULT_CONFIG, timestamp: "20260601T140000" });
  const lockPath = path.join(repo, ".git", "refs", "heads", "guardian", "delete-partial.lock");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, "locked\n");

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", branch: "guardian/delete-partial", deleteBranch: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T140000" });

  assert.equal(result.ok, false);
  assert.equal(result.status, "partial");
  assert.equal(result.branchDeleted, false);
  assert.equal(result.worktreeRemoved, true);
  assert.match(result.safetyRef, /^refs\/opencode-guardian\/ses_delete_partial\/guardian\/delete-partial\//);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), false);
  assert.equal(await branchExists(repo, "guardian/delete-partial"), true);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const session = findSession(status, "ses_delete_partial");
  assert.equal(session.status, "deleted");
  assert.equal(session.branch_delete_failed, true);
  assert.equal(session.deleted_branch, null);
});
