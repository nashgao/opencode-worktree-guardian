import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { guardianStart } from "../src/tools.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

test("guardian_done reattaches a closed Guardian worktree without caller-supplied session id", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_closed", taskName: "done closed", createWorktree: true, config: DEFAULT_CONFIG });
  const closed = await guardianDone({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: "ses_done_closed", timestamp: "20260609T040000" });
  assert.equal(closed.ok, true);
  assert.equal(closed.status, "pr-suggested");
  await fs.writeFile(path.join(started.session.worktree_path, "after-close.txt"), "after close\n");
  await git(started.session.worktree_path, ["add", "after-close.txt"]);
  await git(started.session.worktree_path, ["commit", "-m", "add work after closed session"]);

  const result = await guardianDone({ repoRoot: repo, cwd: started.session.worktree_path, timestamp: "20260609T040404" });

  assert.equal(result.ok, true);
  assert.equal(result.lane, "session-finish");
  assert.equal(result.status, "pr-suggested");
  assert.equal(result.reattached, true);
  if (!isRecordLike(result.preflight)) throw new Error("guardian_done result is missing preflight details");
  assert.equal(result.preflight.currentWorktree, started.session.worktree_path);
  assert.equal(result.preflight.sessionOwnedWorktree, true);
  const sessionId = result.preflight.sessionId;
  if (typeof sessionId !== "string") throw new Error("reattached finish did not report a session id");
  assert.match(sessionId, /^ses_recovered_guardian-done-closed/);
});
