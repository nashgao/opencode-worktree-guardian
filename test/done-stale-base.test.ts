import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
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

async function createCommittedSession(sessionId: string, taskName: string) {
  const { repo } = await createRepoWithOrigin();
  const started = await guardianStart({
    repoRoot: repo,
    cwd: repo,
    sessionId,
    taskName,
    createWorktree: true,
    config: DEFAULT_CONFIG,
  });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");
  await fs.writeFile(path.join(worktree, `${taskName}.txt`), `${taskName}\n`, "utf8");
  await git(worktree, ["add", "."]);
  await git(worktree, ["commit", "-m", `add ${taskName}`]);
  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
  return { repo, worktree, branch, head };
}

async function assertWorktreePresent(repo: string, worktree: string): Promise<void> {
  const worktrees = (await git(repo, ["worktree", "list", "--porcelain"])).stdout;
  assert.match(worktrees, new RegExp(worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

test("guardian_done plan blocks a stale session before PR publication", async (t) => {
  const sessionId = "land-clean-stale-plan";
  const { repo, worktree, branch, head } = await createCommittedSession(sessionId, "stale-plan");
  const remote = (await git(repo, ["remote", "get-url", "origin"])).stdout;
  const updater = path.join(path.dirname(repo), "land-clean-stale-plan-updater");
  await git(repo, ["clone", remote, updater]);
  await git(updater, ["config", "user.email", "guardian@example.test"]);
  await git(updater, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(updater, "base-advance.txt"), "base advance\n", "utf8");
  await git(updater, ["add", "base-advance.txt"]);
  await git(updater, ["commit", "-m", "advance base before done plan"]);
  await git(updater, ["push", "origin", "main"]);
  const fakeGh = await installFakeGh(t, { repo, branch, head });

  const result = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "plan", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.match(String(result.reason), /base.*ancestor/i);
  assert.equal(await fs.access(fakeGh.logPath).then(() => true, () => false), false);
  await assertWorktreePresent(repo, worktree);
  await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
});

test("guardian_done apply rejects base movement after a fresh plan before PR publication", async (t) => {
  const sessionId = "land-clean-base-movement";
  const { repo, worktree, branch, head } = await createCommittedSession(sessionId, "base-movement");
  const fakeGh = await installFakeGh(t, { repo, branch, head });
  const request = { repoRoot: repo, cwd: worktree, sessionId, config: DEFAULT_CONFIG };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");
  const remote = (await git(repo, ["remote", "get-url", "origin"])).stdout;
  const updater = path.join(path.dirname(repo), "land-clean-base-movement-updater");
  await git(repo, ["clone", remote, updater]);
  await git(updater, ["config", "user.email", "guardian@example.test"]);
  await git(updater, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(updater, "base-advance.txt"), "base advance\n", "utf8");
  await git(updater, ["add", "base-advance.txt"]);
  await git(updater, ["commit", "-m", "advance base after done plan"]);
  await git(updater, ["push", "origin", "main"]);

  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.match(String(result.reason), /plan changed|base.*ancestor/i);
  assert.equal(await fs.access(fakeGh.logPath).then(() => true, () => false), false);
  await assertWorktreePresent(repo, worktree);
  await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
});

test("guardian_done plans and cleans a session contained by a merge commit without creating a PR", async (t) => {
  const sessionId = "land-clean-already-merged";
  const { repo, worktree, branch, head } = await createCommittedSession(sessionId, "already-merged");
  await git(repo, ["merge", "--no-ff", branch, "-m", "merge already-landed session"]);
  await git(repo, ["push", "origin", "main"]);
  const fakeGh = await installFakeGh(t, { repo, branch, head });
  const plan = requireRecord(await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "plan", config: DEFAULT_CONFIG, timestamp: "20260624T120000" }), "plan");

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.action, "already-landed-clean");
  assert.equal(typeof plan.confirmToken, "string");
  await assertWorktreePresent(repo, worktree);
  assert.equal(await fs.access(fakeGh.logPath).then(() => true, () => false), false);

  const result = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken"), config: DEFAULT_CONFIG, timestamp: "20260624T120000" });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "already-landed-and-cleaned");
  assert.equal(result.worktreeRemoved, true);
  assert.equal(result.branchDeleted, true);
  const log = await fs.readFile(fakeGh.logPath, "utf8").catch(() => "");
  assert.equal(log, "");
  await assert.rejects(fs.access(worktree));
  await assert.rejects(git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]));
  assert.equal((await git(repo, ["merge-base", "--is-ancestor", head, "origin/main"]).then(() => true, () => false)), true);
});
