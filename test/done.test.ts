import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { guardianStatus } from "../src/recover.ts";
import { guardianStart } from "../src/tools.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

type DoneResult = Record<string, any>;

function asDone(result: Record<string, unknown>): DoneResult {
  return result as DoneResult;
}

async function pathExists(filePath: string) {
  return fs.access(filePath).then(() => true, () => false);
}

async function makeMergedCleanupCandidate(repo: string) {
  const branch = "guardian/done-cleanup";
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, "done-cleanup.txt"), "cleanup\n");
  await git(repo, ["add", "done-cleanup.txt"]);
  await git(repo, ["commit", "-m", "add done cleanup"]);
  await git(repo, ["checkout", "main"]);
  await git(repo, ["merge", "--no-ff", branch, "-m", "merge done cleanup"]);
  await git(repo, ["push", "origin", "main"]);
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), "done-cleanup");
  await git(repo, ["worktree", "add", worktreePath, branch]);
  return { branch, worktreePath };
}

test("guardian_done delegates recorded session worktrees to guardian_finish", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_session", taskName: "done session", createWorktree: true, config: DEFAULT_CONFIG });

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: "ses_done_session", timestamp: "20260609T010101" }));

  assert.equal(result.ok, true);
  assert.equal(result.lane, "session-finish");
  assert.equal(result.status, "pr-suggested");
  assert.equal(result.preflight.sessionOwnedWorktree, true);
  assert.equal(result.preflight.currentWorktree, started.session.worktree_path);
});

test("guardian_done plans cleanup-only on clean primary main", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const candidate = await makeMergedCleanupCandidate(repo);

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(result.ok, true);
  assert.equal(result.lane, "cleanup-only");
  assert.equal(result.status, "planned");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].branch, candidate.branch);
  assert.equal(typeof result.confirmToken, "string");
  assert.equal(await pathExists(candidate.worktreePath), true);
});

test("guardian_done plans dirty primary-main publish with token-bound dirty files", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "done-feature.txt"), "feature\n");

  const plan = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: done feature" }));

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.lane, "primary-main-publish");
  assert.equal(plan.commitMessage, "feat: done feature");
  assert.equal(typeof plan.confirmToken, "string");
  assert.match(plan.nextAction, /confirm=true/);
  assert.doesNotMatch(plan.nextAction, /confirmToken|sessionId/);
  assert.deepEqual(plan.dirtySnapshot.paths, ["done-feature.txt"]);
});

test("guardian_done blocks dirty primary-main publish without commit message", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "done-feature.txt"), "feature\n");

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /commitMessage is required/);
  assert.deepEqual(result.dirtyFiles, ["done-feature.txt"]);
});

test("guardian_done blocks stale dirty-primary tokens after file content changes", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const featurePath = path.join(repo, "done-feature.txt");
  await fs.writeFile(featurePath, "feature\n");
  const plan = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: done feature" }));
  await fs.writeFile(featurePath, "changed\n");

  const apply = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "apply", commitMessage: "feat: done feature", confirmToken: plan.confirmToken }));

  assert.equal(apply.ok, false);
  assert.equal(apply.status, "blocked");
  assert.match(apply.reason, /plan changed; rerun plan/);
  await assert.rejects(() => git(repo, ["rev-parse", "--verify", "refs/opencode-guardian/primary-main/main/20260609T010101"]));
});

test("guardian_done applies dirty primary-main publish and returns fresh cleanup plan", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const candidate = await makeMergedCleanupCandidate(repo);
  await fs.writeFile(path.join(repo, "done-publish.txt"), "publish\n");
  const plan = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: done publish" }));

  const apply = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "apply", commitMessage: "feat: done publish", confirmToken: plan.confirmToken, timestamp: "20260609T010101" }));

  assert.equal(apply.ok, true);
  assert.equal(apply.status, "published");
  assert.equal(apply.lane, "primary-main-publish");
  assert.match(apply.safetyRef, /refs\/opencode-guardian\/primary-main\/main\/20260609T010101/);
  assert.equal(apply.cleanupPlan.status, "planned");
  assert.equal(apply.cleanupPlan.candidates.length, 1);
  assert.equal(apply.cleanupPlan.candidates[0].branch, candidate.branch);
  assert.equal(await pathExists(candidate.worktreePath), true);
  const { stdout: remoteMain } = await git(repo, ["rev-parse", "origin/main"]);
  assert.equal(remoteMain, apply.commit);
});



test("guardian_done plans dirty primary publish when an active session owns another lane", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_wrong_lane", taskName: "done wrong lane", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(repo, "wrong-lane.txt"), "primary dirt\n");

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_done_wrong_lane", commitMessage: "feat: publish primary work" }));

  assert.equal(result.ok, true);
  assert.equal(result.status, "planned");
  assert.equal(result.lane, "primary-main-publish");
  assert.deepEqual(result.dirtySnapshot.paths, ["wrong-lane.txt"]);
  assert.equal(result.commitMessage, "feat: publish primary work");
  assert.equal(typeof result.confirmToken, "string");
  assert.equal(await pathExists(started.session.worktree_path), true);
});

test("guardian_done still requires an explicit message for dirty primary publish when a session owns another lane", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_wrong_lane_no_message", taskName: "done wrong lane no message", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(repo, "wrong-lane.txt"), "primary dirt\n");

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_done_wrong_lane_no_message" }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /commitMessage is required/);
  assert.deepEqual(result.dirtyFiles, ["wrong-lane.txt"]);
});

test("guardian_done finishes the active session from primary cwd when primary is clean", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_primary_cwd", taskName: "done primary cwd", createWorktree: true, config: DEFAULT_CONFIG });

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, sessionId: "ses_done_primary_cwd", timestamp: "20260609T020202" }));

  assert.equal(result.ok, true);
  assert.equal(result.lane, "session-finish");
  assert.equal(result.status, "pr-suggested");
  assert.equal(result.preflight.currentWorktree, started.session.worktree_path);
  assert.equal(result.preflight.sessionOwnedWorktree, true);
});

test("guardian_done reattaches a new session inside an existing Guardian worktree", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_lost_original", taskName: "done lost original", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(started.session.worktree_path, "reattached.txt"), "reattached\n");
  await git(started.session.worktree_path, ["add", "reattached.txt"]);
  await git(started.session.worktree_path, ["commit", "-m", "add reattached work"]);

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: "ses_done_new_session", timestamp: "20260609T030303" }));

  assert.equal(result.ok, true);
  assert.equal(result.lane, "session-finish");
  assert.equal(result.status, "pr-suggested");
  assert.equal(result.reattached, true);
  assert.equal(result.preflight.sessionId, "ses_done_new_session");
  assert.equal(result.preflight.currentWorktree, started.session.worktree_path);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.terminalSessions.some((session: Record<string, unknown>) => session.session_id === "ses_done_new_session" && session.status === "preserved"), true);
  assert.equal(status.terminalSessions.some((session: Record<string, unknown>) => session.session_id === "ses_done_lost_original" && session.status === "superseded"), true);
});

test("guardian_done blocks protected primary rescue scenarios outside base branch", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await git(repo, ["checkout", "-b", "production"]);
  const config = { ...DEFAULT_CONFIG, protectedBranches: [...DEFAULT_CONFIG.protectedBranches, "production"] };

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", config }));

  assert.equal(result.ok, false);
  assert.equal(result.lane, "primary-rescue-recommended");
  assert.match(result.reason, /rescue it to a Guardian worktree/);
  assert.deepEqual(result.suggestedCommands, ["guardian_start createWorktree=true", "guardian_status"]);
});
