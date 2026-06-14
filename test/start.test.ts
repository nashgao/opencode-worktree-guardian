import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianStatus } from "../src/recover.ts";
import { guardianStart } from "../src/tools.ts";
import { createRepo, createRepoWithOrigin, makeBranchCommit } from "./helpers.ts";

test("guardian_start refuses to record a session whose worktree is in a different git repository than repoRoot", async () => {
  const repo = await createRepo();
  const foreign = await createRepo();
  test.after(() => fs.rm(repo, { recursive: true, force: true }));
  test.after(() => fs.rm(foreign, { recursive: true, force: true }));
  await makeBranchCommit(foreign, "tooling/preserve-local-changes");

  const result = await guardianStart({ repoRoot: repo, cwd: foreign, sessionId: "ses_cross", taskName: "cross", config: DEFAULT_CONFIG });
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(String(result.reason), /different git repository/);

  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.sessions.some((session) => session.session_id === "ses_cross"), false);
});

test("guardian_start records a session on a real worktree of repoRoot", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));

  const result = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_same", taskName: "same", createWorktree: true, config: DEFAULT_CONFIG });
  assert.equal(result.ok, true);

  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.sessions.some((session) => session.session_id === "ses_same"), true);
});
