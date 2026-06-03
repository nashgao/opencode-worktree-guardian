import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { getGuardianPaths, readState, writeStateAtomic } from "../src/state.ts";
import { guardianUnblockFinish } from "../src/unblock-finish.ts";
import { guardianStart } from "../src/tools.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

async function createWorktreeWithReviewArtifact(sessionId = "ses_unblock_review", branch?: string) {
  const { base, repo } = await createRepoWithOrigin();
  const start = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: sessionId, branch, createWorktree: true, config: DEFAULT_CONFIG });
  const reviewPath = path.join(start.session.worktree_path, ".milestones", "reviews", "source-facts-query-endpoint-hardening-impl-rating-20260602.md");
  await fs.mkdir(path.dirname(reviewPath), { recursive: true });
  await fs.writeFile(reviewPath, "# Source Facts Rating\n\n## Score: 87/100\n");
  return { base, repo, start, relativeReviewPath: ".milestones/reviews/source-facts-query-endpoint-hardening-impl-rating-20260602.md" };
}

async function addReviewArtifact(worktreePath: string, name = "source-facts-query-endpoint-hardening-impl-rating-20260602.md") {
  const reviewPath = path.join(worktreePath, ".milestones", "reviews", name);
  await fs.mkdir(path.dirname(reviewPath), { recursive: true });
  await fs.writeFile(reviewPath, "# Source Facts Rating\n\n## Score: 87/100\n");
  return `.milestones/reviews/${name}`;
}

async function forgetRecordedSession(repo: string, sessionId: string) {
  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });
  delete state.sessions[sessionId];
  await writeStateAtomic(paths, state);
}

async function updateRecordedSession(repo: string, sessionId: string, update: Record<string, unknown>) {
  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });
  state.sessions[sessionId] = { ...state.sessions[sessionId], ...update };
  await writeStateAtomic(paths, state);
}

test("plan proposes committing only review artifact blockers", async (t) => {
  const { base, repo, start, relativeReviewPath } = await createWorktreeWithReviewArtifact();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const result: any = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, mode: "plan", config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.equal(result.status, "planned");
  assert.equal(result.action, "commit-review-artifacts");
  assert.equal(typeof result.confirmToken, "string");
  assert.deepEqual(result.preflight.reviewArtifactPaths, [relativeReviewPath]);
  assert.deepEqual(result.preflight.otherDirtyPaths, []);
});

test("apply commits review artifacts with a fresh confirm token", async (t) => {
  const { base, repo, start, relativeReviewPath } = await createWorktreeWithReviewArtifact("ses_unblock_apply");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const plan: any = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, mode: "plan", config: DEFAULT_CONFIG });

  const result: any = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, mode: "apply", confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260602T030303" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "applied");
  assert.deepEqual(result.committedPaths, [relativeReviewPath]);
  assert.match(result.safetyRef, /ses_unblock_apply/);
  assert.equal((await git(start.session.worktree_path, ["status", "--porcelain"])).stdout, "");
  assert.match((await git(start.session.worktree_path, ["log", "-1", "--format=%s"])).stdout, /implementation rating/);
});

test("plan allows recorded descriptive feature branches", async (t) => {
  const { base, repo, start, relativeReviewPath } = await createWorktreeWithReviewArtifact("ses_unblock_recorded_feature", "feature/source-facts-hardening");
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const result: any = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, mode: "plan", config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.equal(result.status, "planned");
  assert.equal(result.preflight.targetSource, "state");
  assert.equal(result.preflight.branch, "feature/source-facts-hardening");
  assert.deepEqual(result.preflight.reviewArtifactPaths, [relativeReviewPath]);
});

test("apply allows unrecorded descriptive branch under Guardian worktree root", async (t) => {
  const { base, repo, start, relativeReviewPath } = await createWorktreeWithReviewArtifact("ses_unblock_feature_apply", "feature/unblock-review-artifacts");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await forgetRecordedSession(repo, start.session.session_id);
  const plan: any = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, branch: start.session.branch, mode: "plan", config: DEFAULT_CONFIG });

  const result: any = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, branch: start.session.branch, mode: "apply", confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260602T050505" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "applied");
  assert.deepEqual(result.committedPaths, [relativeReviewPath]);
  assert.equal((await git(start.session.worktree_path, ["status", "--porcelain"])).stdout, "");
});

test("plan resolves an unrecorded session by explicit branch", async (t) => {
  const { base, repo, start, relativeReviewPath } = await createWorktreeWithReviewArtifact("ses_unblock_branch_plan");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await forgetRecordedSession(repo, start.session.session_id);

  const result: any = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, branch: start.session.branch, mode: "plan", config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.equal(result.status, "planned");
  assert.equal(result.preflight.sessionRecorded, false);
  assert.equal(result.preflight.targetSource, "branch");
  assert.equal(result.preflight.branch, start.session.branch);
  assert.equal(result.preflight.worktreePath, start.session.worktree_path);
  assert.deepEqual(result.preflight.reviewArtifactPaths, [relativeReviewPath]);
});

test("apply resolves an unrecorded session by explicit branch and records state", async (t) => {
  const { base, repo, start, relativeReviewPath } = await createWorktreeWithReviewArtifact("ses_unblock_branch_apply");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await forgetRecordedSession(repo, start.session.session_id);
  const plan: any = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, branch: start.session.branch, mode: "plan", config: DEFAULT_CONFIG });

  const result: any = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, branch: start.session.branch, mode: "apply", confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260602T040404" });
  const state = await readState(await getGuardianPaths(repo), { repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.equal(result.status, "applied");
  assert.deepEqual(result.committedPaths, [relativeReviewPath]);
  assert.equal(state.sessions[start.session.session_id].branch, start.session.branch);
  assert.equal(state.sessions[start.session.session_id].worktree_path, start.session.worktree_path);
  assert.equal((await git(start.session.worktree_path, ["status", "--porcelain"])).stdout, "");
});

test("plan resolves an unrecorded session by explicit worktreePath", async (t) => {
  const { base, repo, start, relativeReviewPath } = await createWorktreeWithReviewArtifact("ses_unblock_path_plan");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await forgetRecordedSession(repo, start.session.session_id);

  const result: any = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, worktreePath: start.session.worktree_path, mode: "plan", config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.equal(result.status, "planned");
  assert.equal(result.preflight.sessionRecorded, false);
  assert.equal(result.preflight.targetSource, "worktreePath");
  assert.equal(result.preflight.worktreePath, start.session.worktree_path);
  assert.equal(result.preflight.branch, start.session.branch);
  assert.deepEqual(result.preflight.reviewArtifactPaths, [relativeReviewPath]);
});

test("plan blocks explicit worktreePath and branch mismatch", async (t) => {
  const first = await createWorktreeWithReviewArtifact("ses_unblock_path_mismatch_a");
  t.after(() => fs.rm(first.base, { recursive: true, force: true }));
  const second = await guardianStart({ repoRoot: first.repo, cwd: first.repo, sessionId: "ses_unblock_path_mismatch_b", taskName: "mismatch b", createWorktree: true, config: DEFAULT_CONFIG });
  await forgetRecordedSession(first.repo, first.start.session.session_id);

  const result: any = await guardianUnblockFinish({ repoRoot: first.repo, sessionId: first.start.session.session_id, worktreePath: first.start.session.worktree_path, branch: second.session.branch, mode: "plan", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /branch does not match/);
});

test("plan blocks primary protected worktree targets", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const relativeReviewPath = await addReviewArtifact(repo, "main-impl-rating-20260602.md");

  const result: any = await guardianUnblockFinish({ repoRoot: repo, sessionId: "ses_unblock_main", worktreePath: repo, mode: "plan", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /primary repository|protected/);
  assert.equal(result.preflight.reviewArtifactPaths.includes(relativeReviewPath), false);
});

test("plan blocks explicit protected branch targets", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await addReviewArtifact(repo, "protected-impl-rating-20260602.md");

  const result: any = await guardianUnblockFinish({ repoRoot: repo, sessionId: "ses_unblock_protected", branch: "main", mode: "plan", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /primary repository|protected/);
});

test("plan blocks descriptive branch targets outside Guardian worktree root", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const featurePath = path.join(base, "feature-worktree");
  await git(repo, ["worktree", "add", "-b", "feature/unblock", featurePath, "origin/main"]);
  await addReviewArtifact(featurePath, "feature-impl-rating-20260602.md");

  const result: any = await guardianUnblockFinish({ repoRoot: repo, sessionId: "ses_unblock_feature", branch: "feature/unblock", mode: "plan", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /outside Guardian worktree root/);
});

test("plan blocks recorded state pointing at protected main", async (t) => {
  const { base, repo, start } = await createWorktreeWithReviewArtifact("ses_unblock_poison_main");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await addReviewArtifact(repo, "poison-main-impl-rating-20260602.md");
  await updateRecordedSession(repo, start.session.session_id, { worktree_path: repo, branch: "main" });

  const result: any = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, mode: "plan", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /primary repository|protected/);
});

test("apply blocks stale confirm tokens after artifact content changes", async (t) => {
  const { base, repo, start } = await createWorktreeWithReviewArtifact("ses_unblock_stale");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const plan: any = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, mode: "plan", config: DEFAULT_CONFIG });
  await fs.appendFile(path.join(start.session.worktree_path, ".milestones/reviews/source-facts-query-endpoint-hardening-impl-rating-20260602.md"), "changed\n");

  const result: any = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, mode: "apply", confirmToken: plan.confirmToken, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /confirm token/i);
  assert.notEqual((await git(start.session.worktree_path, ["status", "--porcelain"])).stdout, "");
});

test("plan blocks recorded state paths that are not checked-out worktrees", async (t) => {
  const { base, repo, start } = await createWorktreeWithReviewArtifact("ses_unblock_stale_state");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await updateRecordedSession(repo, start.session.session_id, { worktree_path: path.join(base, "not-a-worktree") });

  const result: any = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, mode: "plan", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /not checked out/);
});

test("plan blocks recorded branch mismatch against checked-out worktree", async (t) => {
  const { base, repo, start } = await createWorktreeWithReviewArtifact("ses_unblock_branch_mismatch");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await updateRecordedSession(repo, start.session.session_id, { branch: "guardian/different" });

  const result: any = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, mode: "plan", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /branch does not match/);
});

test("plan blocks source-to-review renames as non-review dirty state", async (t) => {
  const { base, repo, start } = await createWorktreeWithReviewArtifact("ses_unblock_rename");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourcePath = path.join(start.session.worktree_path, "source-change.txt");
  const reviewPath = path.join(start.session.worktree_path, ".milestones", "reviews", "renamed-impl-rating-20260602.md");
  await fs.writeFile(sourcePath, "source content\n");
  await git(start.session.worktree_path, ["add", "source-change.txt"]);
  await git(start.session.worktree_path, ["commit", "-m", "add source fixture"]);
  await fs.mkdir(path.dirname(reviewPath), { recursive: true });
  await fs.rename(sourcePath, reviewPath);
  await git(start.session.worktree_path, ["add", "-A"]);

  const result: any = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, mode: "plan", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /non-review artifacts/);
  assert.equal(result.preflight.reviewArtifactPaths.includes(".milestones/reviews/renamed-impl-rating-20260602.md"), false);
  assert.equal(result.preflight.otherDirtyPaths.includes(".milestones/reviews/renamed-impl-rating-20260602.md"), true);
});

test("plan blocks review artifact symlinks", async (t) => {
  const { base, repo, start } = await createWorktreeWithReviewArtifact("ses_unblock_symlink");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.rm(path.join(start.session.worktree_path, ".milestones/reviews/source-facts-query-endpoint-hardening-impl-rating-20260602.md"));
  await fs.symlink("../../README.md", path.join(start.session.worktree_path, ".milestones/reviews/source-facts-query-endpoint-hardening-impl-rating-20260602.md"));

  const result: any = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, mode: "plan", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /no committable review artifacts|non-review artifacts/);
});

test("plan blocks mixed source dirty files", async (t) => {
  const { base, repo, start } = await createWorktreeWithReviewArtifact("ses_unblock_mixed");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(start.session.worktree_path, "src.rs"), "source change\n");

  const result: any = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, mode: "plan", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /non-review artifacts/);
  assert.deepEqual(result.otherDirtyPaths, ["src.rs"]);
}
);
