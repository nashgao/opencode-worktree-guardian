import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { guardianStart } from "../src/start.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepoWithOrigin, git, installFakeGh } from "./helpers.ts";

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

test("guardian_done active-session plan is read-only and previews land-and-clean", async () => {
  const sessionId = "land-clean-plan";
  const { repo, worktree, branch, head } = await createCommittedSession(sessionId, "plan-preview");
  const result = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.equal(result.status, "planned");
  assert.equal(result.action, "land-and-clean");
  assert.equal(result.branch, branch);
  assert.equal(result.head, head);
  assert.equal(result.nextAction, "guardian_done mode=apply confirm=true");
  await assertWorktreePresent(repo, worktree);
  await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  await assert.rejects(git(repo, ["merge-base", "--is-ancestor", head, "origin/main"]));
});


test("guardian_done cleans already-merged sessions without creating a PR", async (t) => {
  const sessionId = "land-clean-already-merged";
  const { repo, worktree, branch, head } = await createCommittedSession(sessionId, "already-merged");
  await git(repo, ["merge", "--ff-only", branch]);
  await git(repo, ["push", "origin", "main"]);
  const fakeGh = await installFakeGh(t, { repo, branch, head });

  const result = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "apply", confirm: true, config: DEFAULT_CONFIG, timestamp: "20260624T120000" });

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

test("guardian_done reuses an existing open PR before cleanup", async (t) => {
  const sessionId = "land-clean-existing-pr";
  const { repo, worktree, branch, head } = await createCommittedSession(sessionId, "existing-pr");
  const fakeGh = await installFakeGh(t, { repo, branch, head, existingPr: true });
  const result = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "apply", confirm: true, config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.equal(result.status, "landed-and-cleaned");
  const log = await fs.readFile(fakeGh.logPath, "utf8");
  assert.match(log, /pr list/);
  assert.doesNotMatch(log, /pr create/);
  assert.match(log, /pr merge/);
  await assert.rejects(git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]));
});

test("guardian_done leaves worktree and branch intact when PR merge is waiting", async (t) => {
  const sessionId = "land-clean-waiting";
  const { repo, worktree, branch, head } = await createCommittedSession(sessionId, "merge-waiting");
  const fakeGh = await installFakeGh(t, { repo, branch, head, mergeFails: true });
  const result = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "apply", confirm: true, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.equal(result.status, "waiting");
  assert.equal(result.worktreeRemoved, undefined);
  assert.equal(result.branchDeleted, undefined);
  const log = await fs.readFile(fakeGh.logPath, "utf8");
  assert.match(log, /pr merge/);
  await assertWorktreePresent(repo, worktree);
  await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  await assert.rejects(git(repo, ["merge-base", "--is-ancestor", head, "origin/main"]));
});

test("guardian_done blocks dirty session apply without an explicit commit message", async () => {
  const sessionId = "land-clean-dirty-no-message";
  const { repo, worktree, branch, head } = await createCommittedSession(sessionId, "dirty-no-message");
  await fs.writeFile(path.join(worktree, "uncommitted.txt"), "needs a message\n", "utf8");

  const result = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "apply", confirm: true, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(String(result.reason), /commitMessage/);
  await assertWorktreePresent(repo, worktree);
  await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  await assert.rejects(git(repo, ["merge-base", "--is-ancestor", head, "origin/main"]));
});

test("guardian_done only uses admin bypass when allowAdminBypass is explicit", async (t) => {
  const sessionId = "land-clean-admin";
  const { repo, worktree, branch, head } = await createCommittedSession(sessionId, "admin-bypass");
  const fakeGh = await installFakeGh(t, { repo, branch, head, expectAdmin: true });
  const result = await guardianDone({
    repoRoot: repo,
    cwd: worktree,
    sessionId,
    mode: "apply",
    confirm: true,
    allowAdminBypass: true,
    config: DEFAULT_CONFIG,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "landed-and-cleaned");
  assert.equal(result.adminBypass, true);
  const log = await fs.readFile(fakeGh.logPath, "utf8");
  assert.match(log, /--admin/);
  await assert.rejects(git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]));
});
