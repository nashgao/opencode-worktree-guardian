import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianFinish } from "../src/finish.ts";
import { getGuardianPaths, readState } from "../src/state.ts";
import { guardianStart } from "../src/tools.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

test("guardian_finish retries a failed push with its exact safety ref", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_finish_retry", taskName: "finish retry", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  await fs.writeFile(path.join(worktree, "retry.txt"), "retry\n");
  await git(worktree, ["add", "retry.txt"]);
  await git(worktree, ["commit", "-m", "finish retry"]);
  const commit = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  const timestamp = "20260728T120000";
  const updater = path.join(base, "finish-retry-updater");
  await git(base, ["clone", remote, updater]);
  await git(updater, ["config", "user.email", "guardian@example.test"]);
  await git(updater, ["config", "user.name", "Guardian Test"]);
  await git(updater, ["checkout", "-b", started.session.branch]);
  await fs.writeFile(path.join(updater, "remote-retry.txt"), "remote\n");
  await git(updater, ["add", "remote-retry.txt"]);
  await git(updater, ["commit", "-m", "create divergent retry branch"]);
  await git(updater, ["push", "origin", started.session.branch]);

  const blocked = await guardianFinish({ repoRoot: repo, cwd: worktree, sessionId: started.session.session_id, timestamp });

  assert.equal(blocked.ok, false, JSON.stringify(blocked));
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reason, "push failed");
  if (typeof blocked.safetyRef !== "string") throw new Error("blocked finish did not return a safety ref");
  await git(updater, ["push", "origin", `:${started.session.branch}`]);
  const retried = await guardianFinish({ repoRoot: repo, cwd: worktree, sessionId: started.session.session_id, timestamp });

  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(retried.safetyRef, blocked.safetyRef);
  assert.equal((await git(remote, ["rev-parse", `refs/heads/${started.session.branch}`])).stdout, commit);
  const state = await readState(await getGuardianPaths(repo), { repoRoot: repo, config: DEFAULT_CONFIG });
  const safetyRefs = state.sessions[started.session.session_id]?.safety_refs ?? [];
  assert.equal(safetyRefs.filter((ref) => ref === blocked.safetyRef).length, 1);
});
