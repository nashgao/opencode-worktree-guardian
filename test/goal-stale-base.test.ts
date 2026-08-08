import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianGoal } from "../src/goal.ts";
import { guardianStart } from "../src/start.ts";
import { isRecordLike } from "../src/types.ts";
import { installFakeGh } from "./delete-fixtures.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(`${name} must be a non-empty string`);
}

function goalRecords(value: unknown, key: string): Array<Record<string, unknown>> {
  const record = requireRecord(value, "guardian_goal result");
  const entries = record[key];
  return Array.isArray(entries) ? entries.filter(isRecordLike) : [];
}

test("guardian_goal inherits guardian_done's stale-base publication block", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "ses_goal_stale_base";
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "goal stale base", createWorktree: true, config: DEFAULT_CONFIG });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");
  await fs.writeFile(path.join(worktree, "goal-feature.txt"), "feature\n");
  await git(worktree, ["add", "goal-feature.txt"]);
  await git(worktree, ["commit", "-m", "add stale goal fixture"]);
  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  const fakeGh = await installFakeGh(t, { repo, branch, head });
  const updater = path.join(base, "goal-stale-updater");
  await git(base, ["clone", remote, updater]);
  await git(updater, ["config", "user.email", "guardian@example.test"]);
  await git(updater, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(updater, "base-advance.txt"), "base advance\n");
  await git(updater, ["add", "base-advance.txt"]);
  await git(updater, ["commit", "-m", "advance base before goal"]);
  await git(updater, ["push", "origin", "main"]);

  const result = requireRecord(await guardianGoal({ repoRoot: repo, cwd: worktree, sessionId, mode: "plan", config: DEFAULT_CONFIG }), "guardian_goal result");

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  const doneStep = goalRecords(result, "steps").find((step) => step.tool === "guardian_done");
  assert.match(String(doneStep?.reason), /base.*ancestor/i);
  assert.equal(await fs.access(fakeGh.logPath).then(() => true, () => false), false);
  await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
});
