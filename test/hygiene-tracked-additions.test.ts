import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { listTrackedAddedPaths } from "../src/hygiene-candidates.ts";
import { guardianHygiene } from "../src/hygiene.ts";
import { guardianStart } from "../src/start.ts";
import type { GuardianConfig } from "../src/types.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

const STRICT_GOAL_CONFIG: GuardianConfig = {
  ...DEFAULT_CONFIG,
  goal: { ...DEFAULT_CONFIG.goal, hygieneCompletion: "no-unprotected-residue" },
};

function record(value: unknown, name: string): Record<string, unknown> {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

test("tracked additions are deterministic and bound to the selected baseline", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const baseline = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  await fs.writeFile(path.join(repo, "z-debug.png"), "z\n");
  await fs.writeFile(path.join(repo, "a-debug.png"), "a\n");
  await git(repo, ["add", "--", "z-debug.png", "a-debug.png"]);

  const staged = await listTrackedAddedPaths(repo, baseline);
  await git(repo, ["commit", "-m", "test: add tracked artifacts"]);
  const committed = await listTrackedAddedPaths(repo, baseline);
  const currentBaseline = (await git(repo, ["rev-parse", "HEAD"])).stdout;

  assert.deepEqual(staged, ["a-debug.png", "z-debug.png"]);
  assert.deepEqual(committed, staged);
  assert.deepEqual(await listTrackedAddedPaths(repo, currentBaseline), []);
});

test("guardian_hygiene exposes tracked-added reviewables for a recorded session", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "ses_hygiene_tracked_added";
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, createWorktree: true, config: STRICT_GOAL_CONFIG });
  const session = record(started.session, "started.session");
  const worktree = String(session.worktree_path);
  const artifact = "screenshots/direct-scan.png";
  await fs.mkdir(path.join(worktree, "screenshots"), { recursive: true });
  await fs.writeFile(path.join(worktree, artifact), "scan\n");
  await git(worktree, ["add", "--", artifact]);

  const scan = record(await guardianHygiene({ repoRoot: worktree, cwd: worktree, sessionId, config: STRICT_GOAL_CONFIG }), "hygiene scan");
  const summary = record(scan.summary, "hygiene summary");
  const candidates = Array.isArray(scan.reviewableCandidates) ? scan.reviewableCandidates.filter(isRecordLike) : [];

  assert.equal(summary.trackedAddedCandidateCount, 1);
  assert.equal(summary.trackedBaselineCommit, session.started_head_commit);
  assert.equal(candidates[0]?.path, artifact);
  assert.equal(candidates[0]?.status, "tracked-added");
});

test("protected paths do not acknowledge tracked additions", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "ses_hygiene_protected_tracked";
  const config: GuardianConfig = { ...STRICT_GOAL_CONFIG, protectedPaths: ["screenshots"] };
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, createWorktree: true, config });
  const session = record(started.session, "started.session");
  const worktree = String(session.worktree_path);
  const artifact = "screenshots/protected-debug.png";
  await fs.mkdir(path.join(worktree, "screenshots"), { recursive: true });
  await fs.writeFile(path.join(worktree, artifact), "protected scan\n");
  await git(worktree, ["add", "--", artifact]);

  const scan = record(await guardianHygiene({ repoRoot: worktree, cwd: worktree, sessionId, config }), "hygiene scan");
  const summary = record(scan.summary, "hygiene summary");
  const candidates = Array.isArray(scan.reviewableCandidates) ? scan.reviewableCandidates.filter(isRecordLike) : [];

  assert.equal(summary.trackedAddedCandidateCount, 1);
  assert.equal(summary.reviewableCandidateCount, 1);
  assert.equal(candidates[0]?.path, artifact);
  assert.equal(candidates[0]?.status, "tracked-added");
});
