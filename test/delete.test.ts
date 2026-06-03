import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDeleteWorktree } from "../src/delete.ts";
import { guardianStatus } from "../src/recover.ts";
import { recordSession } from "../src/state.ts";
import { guardianStart } from "../src/tools.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

type DeleteResult = Record<string, unknown> & {
  ok: boolean;
  status: string;
  reason?: string;
  confirmToken?: string;
  safetyRef?: string;
  branchDeleted?: boolean;
  preflight: Record<string, unknown>;
  report: Record<string, unknown>;
};

async function createGuardianWorktree(repo: string, sessionId: string, taskName = sessionId, branch = `guardian/${sessionId}`) {
  return guardianStart({
    repoRoot: repo,
    cwd: repo,
    sessionId,
    taskName,
    branch,
    createWorktree: true,
    config: DEFAULT_CONFIG,
  });
}

async function worktreePaths(repo: string) {
  const result = await git(repo, ["worktree", "list", "--porcelain"]);
  return result.stdout.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
}

async function branchExists(repo: string, branch: string) {
  return git(repo, ["show-ref", "--verify", `refs/heads/${branch}`]).then(() => true, () => false);
}

async function deleteWorktree(input: Record<string, unknown>) {
  return guardianDeleteWorktree(input) as Promise<DeleteResult>;
}

function assertNoExpectedToken(result: Record<string, unknown>) {
  assert.equal(Object.hasOwn(result, "expectedToken"), false);
  assert.equal(JSON.stringify(result).includes("expectedToken"), false);
}

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

  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_delete_allow_ignored", allowIgnoredFiles: true, config: DEFAULT_CONFIG, timestamp: "20260601T150000" });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.preflight.allowIgnoredFiles, true);
  assert.deepEqual(plan.preflight.ignoredFiles, [".claude/", "data/"]);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId: "ses_delete_allow_ignored", allowIgnoredFiles: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T150000" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "deleted");
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), false);
  assert.equal(await branchExists(repo, "guardian/delete-ignored"), true);
  assert.match(result.safetyRef, /^refs\/opencode-guardian\/ses_delete_allow_ignored\/guardian\/delete-ignored\//);
});

test("stash inventory blocks deletion before safety refs", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_delete_stash");
  await fs.writeFile(path.join(repo, "stashed.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "delete test stash"]);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_delete_stash", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /stash inventory/);
  assert.equal(result.preflight.stashCount, 1);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG })).safetyRefs.length, 0);
});

test("protected branches and primary/current worktrees are blocked", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const protectedStart = await createGuardianWorktree(repo, "ses_delete_protected", "delete protected", "develop");
  const currentStart = await createGuardianWorktree(repo, "ses_delete_current");

  assert.equal(protectedStart.ok, false);
  assert.match(protectedStart.reason, /protected/);

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

test("apply creates a safety ref, removes only the worktree, and keeps the branch by default", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_delete_apply", "delete apply", "guardian/delete-apply");
  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", targetPath: start.session.worktree_path, config: DEFAULT_CONFIG });

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", targetPath: start.session.worktree_path, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T120000" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "deleted");
  assert.equal(result.branchDeleted, false);
  assert.match(result.safetyRef, /^refs\/opencode-guardian\/ses_delete_apply\/guardian\/delete-apply\//);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), false);
  assert.equal(await branchExists(repo, "guardian/delete-apply"), true);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.safetyRefs.some((ref: Record<string, unknown>) => ref.name === result.safetyRef), true);
  const session = status.sessions.find((candidate: Record<string, unknown>) => candidate.session_id === "ses_delete_apply");
  assert.equal(session.status, "deleted");
  assert.deepEqual(session.safety_refs, [result.safetyRef]);
  assert.equal(status.orphanedSessions.some((candidate: Record<string, unknown>) => candidate.session_id === "ses_delete_apply"), false);
});

test("deleteBranch=true requires ancestry proof before any removal", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_delete_unmerged", "delete unmerged", "guardian/delete-unmerged");
  await fs.writeFile(path.join(start.session.worktree_path, "feature.txt"), "unmerged\n");
  await git(start.session.worktree_path, ["add", "feature.txt"]);
  await git(start.session.worktree_path, ["commit", "-m", "unmerged feature"]);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_delete_unmerged", deleteBranch: true, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /not proven reachable/);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal(await branchExists(repo, "guardian/delete-unmerged"), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG })).safetyRefs.length, 0);
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
  assert.equal(result.abandonUnmerged, true);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), false);
  assert.equal(await branchExists(repo, branch), false);
  assert.match(result.safetyRef, /^refs\/opencode-guardian\/ses_delete_abandon_unmerged\/guardian\/delete-abandon-unmerged\//);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const session = status.sessions.find((candidate: Record<string, unknown>) => candidate.session_id === sessionId);
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

  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, deleteBranch: true, config: DEFAULT_CONFIG, timestamp: "20260601T160000" });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.preflight.targetKind, "orphan-branch");
  assert.equal(plan.preflight.targetPath, absentWorktree);
  assert.equal(plan.preflight.branch, branch);
  assert.equal(plan.preflight.head, head);
  assert.equal(plan.preflight.worktreeListed, false);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId, deleteBranch: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T160000" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "deleted");
  assert.equal(result.branchDeleted, true);
  assert.equal(result.worktreeRemoved, false);
  assert.equal(await branchExists(repo, branch), false);
  assert.match(result.safetyRef, /^refs\/opencode-guardian\/ses_delete_orphan_branch\/guardian\/delete-orphan-branch\//);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const session = status.sessions.find((candidate: Record<string, unknown>) => candidate.session_id === sessionId);
  assert.equal(session.status, "deleted");
  assert.equal(session.deleted_worktree_path, absentWorktree);
  assert.equal(session.deleted_branch, branch);
  assert.equal(session.branch_only_delete, true);
  assert.equal(status.stateBranchesWithoutWorktrees.includes(branch), false);
});

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
  const session = status.sessions.find((candidate: Record<string, unknown>) => candidate.session_id === sessionId);
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
  await recordSession(repo, DEFAULT_CONFIG, {
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
  const session = status.sessions.find((candidate: Record<string, unknown>) => candidate.session_id === sessionId);
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
  await recordSession(repo, DEFAULT_CONFIG, {
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
  const session = status.sessions.find((candidate: Record<string, unknown>) => candidate.session_id === sessionId);
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
  const session = status.sessions.find((candidate: Record<string, unknown>) => candidate.session_id === sessionId);
  assert.equal(session.status, "deleted");
  assert.equal(session.deleted_worktree_path, absentWorktree);
  assert.equal(session.deleted_branch, branch);
  assert.equal(session.branch_only_delete, true);
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
  const branch = "foo";
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
  const session = status.sessions.find((candidate: Record<string, unknown>) => candidate.session_id === sessionId);
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
  const session = status.sessions.find((candidate: Record<string, unknown>) => candidate.session_id === "ses_delete_partial");
  assert.equal(session.status, "deleted");
  assert.equal(session.branch_delete_failed, true);
  assert.equal(session.deleted_branch, null);
});
