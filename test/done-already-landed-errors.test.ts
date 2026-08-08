import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { planAlreadyLandedCleanup } from "../src/done-land-clean-already-landed.ts";
import { sessionLandCleanPreflight } from "../src/done-land-clean-consent.ts";
import { guardianStart } from "../src/start.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

test("guardian_done retains the child cleanup blocker for a clean already-landed session", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "ses_done_clean_cleanup_error";
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "clean cleanup error", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  const branch = started.session.branch;
  await fs.writeFile(path.join(worktree, "landed.txt"), "landed\n", "utf8");
  await git(worktree, ["add", "landed.txt"]);
  await git(worktree, ["commit", "-m", "add clean landed fixture"]);
  await git(repo, ["merge", "--ff-only", branch]);
  await git(repo, ["push", "origin", "main"]);
  const config = { ...DEFAULT_CONFIG, protectedBranches: [...DEFAULT_CONFIG.protectedBranches, branch] };

  const preflight = await sessionLandCleanPreflight({ input: { mode: "plan" }, repoRoot: repo, cwd: worktree, sessionId, session: started.session, config: DEFAULT_CONFIG });
  if (preflight.ok !== true) throw new Error(preflight.reason);
  const result = requireRecord(await planAlreadyLandedCleanup({ input: { mode: "plan" }, repoRoot: repo, cwd: worktree, sessionId, session: started.session, config }, preflight, preflight.baseRef), "result");

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.doesNotMatch(String(result.reason), /commitMessage/);
  assert.equal(result.childCleanupReason, "protected branches cannot be deleted by guardian_delete_worktree");
  const cleanup = requireRecord(result.cleanup, "result.cleanup");
  assert.equal(cleanup.reason, result.childCleanupReason);
  await fs.access(worktree);
  await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
});
