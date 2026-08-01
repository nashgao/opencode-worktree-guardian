import {
  assert,
  branchExists,
  createRepoWithOrigin,
  DEFAULT_CONFIG,
  deleteWorktree,
  fs,
  git,
  guardianDeleteWorktree,
  guardianStatus,
  path,
  recordSession,
  test,
} from "./delete-fixtures.js";
import { buildSafetyRef, createSafetyRef, deleteBranchAtHead, deleteRemoteBranch, getHeadCommit } from "../src/git.ts";
import { guardianStart } from "../src/start.ts";
import { createRepo } from "./helpers.ts";

const ownedRoots: string[] = [];

test.after(async () => {
  const remaining = await Promise.all(ownedRoots.map((root) => fs.access(root).then(() => root, () => null)));
  assert.deepEqual(remaining.filter((root): root is string => root !== null), []);
});

async function createHook(repo: string, worktree: string, marker: string): Promise<void> {
  const hooks = path.join(repo, "reference-transaction-hooks");
  await fs.mkdir(hooks, { recursive: true });
  await fs.writeFile(path.join(hooks, "reference-transaction"), `#!/bin/sh\nprintf hook > ${JSON.stringify(marker)}\n`, "utf8");
  await fs.chmod(path.join(hooks, "reference-transaction"), 0o755);
  await git(worktree, ["config", "core.hooksPath", hooks]);
}

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

test("safety refs are create-only and preserve an existing collision", async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const head = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  const timestamp = "20260727T010101";
  const ref = buildSafetyRef("collision", "guardian/collision", timestamp);
  await git(repo, ["update-ref", ref, head]);

  await assert.rejects(createSafetyRef(repo, { sessionId: "collision", branch: "guardian/collision", commit: head, timestamp }));
  assert.equal((await git(repo, ["rev-parse", ref])).stdout, head);
});

test("reference transaction hook blocks local and remote cleanup ref deletion", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  ownedRoots.push(base);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/hook-cleanup";
  await git(repo, ["branch", branch]);
  await git(repo, ["push", "origin", branch]);
  const head = await getHeadCommit(repo);
  const marker = path.join(base, "cleanup-hook-ran");
  await createHook(repo, repo, marker);

  await assert.rejects(deleteBranchAtHead(repo, branch, head), /reference-transaction/i);
  await assert.rejects(deleteRemoteBranch(repo, "origin", branch, head), /reference-transaction/i);

  await assert.rejects(fs.access(marker));
  assert.equal((await git(repo, ["rev-parse", branch])).stdout, head);
  assert.equal((await git(repo, ["rev-parse", `origin/${branch}`])).stdout, head);
});

test("reference transaction hook blocks public branch-only deletion before its safety ref", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  ownedRoots.push(base);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "hook-branch-only", taskName: "hook-branch-only", createWorktree: true, config: DEFAULT_CONFIG });
  assert.equal(started.ok, true, JSON.stringify(started));
  const removePlan = await guardianDeleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "hook-branch-only", deleteBranch: false, config: DEFAULT_CONFIG });
  const removed = await guardianDeleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId: "hook-branch-only", deleteBranch: false, confirmToken: removePlan.confirmToken, config: DEFAULT_CONFIG });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  const plan = await guardianDeleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", branch: started.session.branch, deleteBranch: true, config: DEFAULT_CONFIG });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const marker = path.join(base, "branch-only-hook-ran");
  await createHook(repo, repo, marker);

  const result = await guardianDeleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", branch: started.session.branch, deleteBranch: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false, JSON.stringify(result));
  await assert.rejects(fs.access(marker));
  assert.equal((await git(repo, ["rev-parse", started.session.branch])).stdout, started.session.head_commit);
});
