import {
  assert,
  branchExists,
  createRepoWithOrigin,
  DEFAULT_CONFIG,
  deleteWorktree,
  findSession,
  fs,
  git,
  guardianStatus,
  path,
  recordSession,
  seedSession,
  test,
  worktreePaths,
} from "./delete-fixtures.js";
import { createRef, createSafetyRef } from "../src/git.ts";

test("abandonUnmerged=true abandons an unmerged Guardian orphan branch when the recorded worktree is absent", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/delete-orphan-abandon";
  const sessionId = "ses_delete_orphan_abandon";
  const absentWorktree = path.join(repo, ".worktrees", "opencode-worktree-guardian", "guardian-session-ses-orphan-abandon");
  await git(repo, ["branch", branch, "main"]);
  await git(repo, ["checkout", branch]);
  await fs.writeFile(path.join(repo, "orphan-abandon.txt"), "unmerged orphan\n");
  await git(repo, ["add", "orphan-abandon.txt"]);
  await git(repo, ["commit", "-m", "unmerged orphan abandon candidate"]);
  const { stdout: head } = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["checkout", "main"]);
  await recordSession(repo, DEFAULT_CONFIG, {
    session_id: sessionId,
    status: "active",
    branch,
    worktree_path: absentWorktree,
    base_ref: "origin/main",
    head_commit: head,
  });

  const blocked = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, deleteBranch: true, config: DEFAULT_CONFIG });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /not proven reachable/);
  assert.equal(await branchExists(repo, branch), true);

  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, deleteBranch: true, abandonUnmerged: true, config: DEFAULT_CONFIG, timestamp: "20260601T181000" });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.preflight.targetKind, "orphan-branch");
  assert.equal(plan.preflight.abandonUnmerged, true);
  assert.equal(plan.preflight.ancestryProven, false);
  assert.deepEqual(plan.preflight.unmergedCommits, [{ commit: head, subject: "unmerged orphan abandon candidate" }]);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId, deleteBranch: true, abandonUnmerged: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T181000" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "abandoned");
  assert.equal(result.branchDeleted, true);
  assert.equal(result.worktreeRemoved, false);
  assert.equal(result.abandonUnmerged, true);
  assert.equal(await branchExists(repo, branch), false);
  assert.match(result.safetyRef, /^refs\/opencode-guardian\/ses_delete_orphan_abandon\/guardian\/delete-orphan-abandon\//);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const session = findSession(status, sessionId);
  assert.equal(session.status, "abandoned");
  assert.equal(session.deleted_worktree_path, absentWorktree);
  assert.equal(session.deleted_branch, branch);
  assert.equal(session.branch_only_delete, true);
  assert.equal(session.abandon_unmerged, true);
  assert.deepEqual(session.unmerged_commits, [{ commit: head, subject: "unmerged orphan abandon candidate" }]);
});

test("deleteBranch=true deletes only the branch when Guardian state records the primary repo path", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/delete-poisoned-root";
  const sessionId = "ses_delete_poisoned_root";
  await git(repo, ["branch", branch, "main"]);
  const { stdout: head } = await git(repo, ["rev-parse", branch]);
  await seedSession(repo, {
    session_id: sessionId,
    status: "active",
    branch,
    worktree_path: repo,
    base_ref: "origin/main",
    head_commit: head,
  });

  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, deleteBranch: true, config: DEFAULT_CONFIG, timestamp: "20260601T170000" });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.preflight.targetKind, "orphan-branch");
  assert.equal(plan.preflight.targetPath, repo);
  assert.equal(plan.preflight.branch, branch);
  assert.equal(plan.preflight.head, head);
  assert.equal(plan.preflight.worktreeListed, false);
  assert.equal((await worktreePaths(repo)).includes(repo), true);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId, deleteBranch: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T170000" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "deleted");
  assert.equal(result.branchDeleted, true);
  assert.equal(result.worktreeRemoved, false);
  assert.equal(await branchExists(repo, branch), false);
  assert.equal((await worktreePaths(repo)).includes(repo), true);
  assert.match(result.safetyRef, /^refs\/opencode-guardian\/ses_delete_poisoned_root\/guardian\/delete-poisoned-root\//);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const session = findSession(status, sessionId);
  assert.equal(session.status, "deleted");
  assert.equal(session.deleted_worktree_path, repo);
  assert.equal(session.deleted_branch, branch);
  assert.equal(session.branch_only_delete, true);
});

test("deleteBranch=true deletes an explicit branch for poisoned primary repo state without deleting the worktree", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/delete-poisoned-root-by-branch";
  const sessionId = "ses_delete_poisoned_root_by_branch";
  await git(repo, ["branch", branch, "main"]);
  const { stdout: head } = await git(repo, ["rev-parse", branch]);
  await seedSession(repo, {
    session_id: sessionId,
    status: "active",
    branch,
    worktree_path: repo,
    base_ref: "origin/main",
    head_commit: head,
  });

  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", branch, deleteBranch: true, config: DEFAULT_CONFIG, timestamp: "20260601T171000" });

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.preflight.targetKind, "orphan-branch");
  assert.equal(plan.preflight.targetPath, repo);
  assert.equal(plan.preflight.branch, branch);
  assert.equal(plan.preflight.worktreeListed, false);
  assert.equal((await worktreePaths(repo)).includes(repo), true);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", branch, deleteBranch: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T171000" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "deleted");
  assert.equal(result.branchDeleted, true);
  assert.equal(result.worktreeRemoved, false);
  assert.equal(await branchExists(repo, branch), false);
  assert.equal((await worktreePaths(repo)).includes(repo), true);
});

test("deleteBranch=true deletes a stale branch when terminal Guardian state proves ownership", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/delete-stale-terminal";
  const sessionId = "ses_delete_stale_terminal";
  const absentWorktree = path.join(repo, ".worktrees", "opencode-worktree-guardian", "guardian-session-ses-stale-terminal");
  await git(repo, ["branch", branch, "main"]);
  const { stdout: head } = await git(repo, ["rev-parse", branch]);
  await recordSession(repo, DEFAULT_CONFIG, {
    session_id: sessionId,
    status: "deleted",
    branch,
    worktree_path: absentWorktree,
    base_ref: "origin/main",
    head_commit: head,
  });

  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", branch, deleteBranch: true, config: DEFAULT_CONFIG, timestamp: "20260601T190000" });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.preflight.targetKind, "stale-branch");
  assert.equal(plan.preflight.ownershipProof, "terminal-session");
  assert.equal(plan.preflight.targetPath, absentWorktree);
  assert.equal(plan.preflight.branch, branch);
  assert.equal(plan.preflight.head, head);
  assert.equal(plan.preflight.worktreeListed, false);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", branch, deleteBranch: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T190000" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "deleted");
  assert.equal(result.branchDeleted, true);
  assert.equal(result.worktreeRemoved, false);
  assert.equal(await branchExists(repo, branch), false);
  assert.match(result.safetyRef, /^refs\/opencode-guardian\/ses_delete_stale_terminal\/guardian\/delete-stale-terminal\//);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const session = findSession(status, sessionId);
  assert.equal(session.status, "deleted");
  assert.equal(session.deleted_worktree_path, absentWorktree);
  assert.equal(session.deleted_branch, branch);
  assert.equal(session.branch_only_delete, true);
});

test("deleteBranch=true plans stale branch cleanup from deleted sessionId", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/delete-stale-by-session";
  const sessionId = "ses_delete_stale_by_session";
  const absentWorktree = path.join(repo, ".worktrees", "opencode-worktree-guardian", "guardian-session-ses-stale-by-session");
  await git(repo, ["branch", branch, "main"]);
  const { stdout: head } = await git(repo, ["rev-parse", branch]);
  await recordSession(repo, DEFAULT_CONFIG, {
    session_id: sessionId,
    status: "deleted",
    branch,
    worktree_path: absentWorktree,
    base_ref: "origin/main",
    head_commit: head,
  });

  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, deleteBranch: true, config: DEFAULT_CONFIG, timestamp: "20260601T190500" });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.preflight.targetKind, "stale-branch");
  assert.equal(plan.preflight.ownershipProof, "terminal-session");
  assert.equal(plan.preflight.sessionId, sessionId);
  assert.equal(plan.preflight.targetPath, absentWorktree);
  assert.equal(plan.preflight.branch, branch);
  assert.equal(plan.preflight.head, head);
  assert.equal(plan.preflight.worktreeListed, false);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId, deleteBranch: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T190500" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "deleted");
  assert.equal(result.branchDeleted, true);
  assert.equal(result.worktreeRemoved, false);
  assert.equal(await branchExists(repo, branch), false);
  assert.match(result.safetyRef, /^refs\/opencode-guardian\/ses_delete_stale_by_session\/guardian\/delete-stale-by-session\//);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const session = findSession(status, sessionId);
  assert.equal(session.status, "deleted");
  assert.equal(session.deleted_worktree_path, absentWorktree);
  assert.equal(session.deleted_branch, branch);
  assert.equal(session.branch_only_delete, true);
});

test("branch-only deletion blocks a non-protected symbolic branch ref before planning", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/symbolic-delete-target";
  const protectedBranch = "main";
  await git(repo, ["branch", branch, protectedBranch]);
  await git(repo, ["symbolic-ref", `refs/heads/${branch}`, `refs/heads/${protectedBranch}`]);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", branch, deleteBranch: true, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.match(String(result.reason), /symbolic branch ref/i);
  assert.equal((await git(repo, ["symbolic-ref", "--no-recurse", `refs/heads/${branch}`])).stdout, `refs/heads/${protectedBranch}`);
  assert.equal(await branchExists(repo, protectedBranch), true);
});

test("create-only ref writes reject symbolic targets without mutating their referent", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const protectedRef = "refs/heads/main";
  const protectedHead = (await git(repo, ["rev-parse", protectedRef])).stdout;
  const genericRef = "refs/opencode-guardian/create-ref-symref";
  const safetyRef = "refs/opencode-guardian/create-safety-ref-symref";
  await git(repo, ["symbolic-ref", genericRef, protectedRef]);
  await git(repo, ["symbolic-ref", safetyRef, protectedRef]);

  await assert.rejects(createRef(repo, genericRef, protectedHead));
  await assert.rejects(createSafetyRef(repo, { ref: safetyRef, commit: protectedHead }));

  assert.equal((await git(repo, ["symbolic-ref", "--no-recurse", genericRef])).stdout, protectedRef);
  assert.equal((await git(repo, ["symbolic-ref", "--no-recurse", safetyRef])).stdout, protectedRef);
  assert.equal((await git(repo, ["rev-parse", protectedRef])).stdout, protectedHead);
});
