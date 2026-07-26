import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianUnblockFinish } from "../src/unblock-finish.ts";
import { guardianStart } from "../src/tools.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("expected string");
  return value;
}

async function createWorktreeWithReviewArtifact(sessionId = "ses_unblock_review", branch?: string) {
  const { base, repo } = await createRepoWithOrigin();
  const start = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: sessionId, branch, createWorktree: true, config: DEFAULT_CONFIG });
  const reviewPath = path.join(start.session.worktree_path, ".milestones", "reviews", "source-facts-query-endpoint-hardening-impl-rating-20260602.md");
  await fs.mkdir(path.dirname(reviewPath), { recursive: true });
  await fs.writeFile(reviewPath, "# Source Facts Rating\n\n## Score: 87/100\n");
  return { base, repo, start, relativeReviewPath: ".milestones/reviews/source-facts-query-endpoint-hardening-impl-rating-20260602.md" };
}

test("plan reports stash inventory without blocking by default", async (t) => {
  const { base, repo, start } = await createWorktreeWithReviewArtifact("ses_unblock_stash_advisory");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.appendFile(path.join(repo, "README.md"), "stash advisory\n");
  await git(repo, ["stash", "push", "-m", "unblock advisory stash"]);

  const result = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, mode: "plan", config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.equal(result.preflight.stashCount, 1);
  assert.equal(Array.isArray(result.preflight.stashes) ? result.preflight.stashes.length : 0, 1);
});

test("strict stash policy blocks unblock plan and apply before commit", async (t) => {
  const { base, repo, start } = await createWorktreeWithReviewArtifact("ses_unblock_stash_strict");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.appendFile(path.join(repo, "README.md"), "stash strict\n");
  await git(repo, ["stash", "push", "-m", "unblock strict stash"]);
  const config = { ...DEFAULT_CONFIG, requireEmptyStashInventory: true };
  const headBefore = (await git(start.session.worktree_path, ["rev-parse", "HEAD"])).stdout;

  const plan = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, mode: "plan", config });
  const apply = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, mode: "apply", confirmToken: "invalid", config });

  assert.equal(plan.ok, false);
  assert.match(requireString(plan.reason), /stash inventory/);
  assert.equal(plan.preflight.stashCount, 1);
  assert.equal(apply.ok, false);
  assert.match(requireString(apply.reason), /stash inventory/);
  assert.equal((await git(start.session.worktree_path, ["rev-parse", "HEAD"])).stdout, headBefore);
});
