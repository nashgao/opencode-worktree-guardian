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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("guardian_done apply lands the session PR and removes its stale worktree and branch", async (t) => {
  const { repo } = await createRepoWithOrigin();
  const sessionId = "land-clean-session";
  const started = await guardianStart({
    repoRoot: repo,
    cwd: repo,
    sessionId,
    taskName: "land clean",
    createWorktree: true,
    config: DEFAULT_CONFIG,
  });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");

  await fs.writeFile(path.join(worktree, "feature.txt"), "landed by guardian_done\n", "utf8");
  await git(worktree, ["add", "feature.txt"]);
  await git(worktree, ["commit", "-m", "add guardian done landing fixture"]);
  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
  const fakeGh = await installFakeGh(t, { repo, branch, head });

  const result = await guardianDone({
    repoRoot: repo,
    cwd: worktree,
    sessionId,
    mode: "apply",
    confirm: true,
    timestamp: "2026-06-19T00:00:00.000Z",
    config: DEFAULT_CONFIG,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "landed-and-cleaned");
  assert.equal(result.lane, "session-finish");
  const pr = requireRecord(result.pr, "result.pr");
  assert.equal(pr.url, fakeGh.url);
  assert.equal(pr.number, 1);
  assert.equal(result.worktreeRemoved, true);
  assert.equal(result.branchDeleted, true);

  const log = await fs.readFile(fakeGh.logPath, "utf8");
  assert.match(log, /pr list/);
  assert.match(log, /pr create/);
  assert.match(log, /pr merge/);
  assert.doesNotMatch(log, /--admin/);
  assert.doesNotMatch(log, /--delete-branch/);

  await git(repo, ["fetch", "origin", "main"]);
  await git(repo, ["merge-base", "--is-ancestor", head, "origin/main"]);
  const worktrees = (await git(repo, ["worktree", "list", "--porcelain"])).stdout;
  assert.doesNotMatch(worktrees, new RegExp(escapeRegExp(worktree)));
  await assert.rejects(git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]));
});

test("guardian_done apply commits dirty session work before landing and cleanup", async (t) => {
  const { repo } = await createRepoWithOrigin();
  const sessionId = "land-clean-dirty-session";
  const commitMessage = "feat: complete dirty session";
  const started = await guardianStart({
    repoRoot: repo,
    cwd: repo,
    sessionId,
    taskName: "land dirty",
    createWorktree: true,
    config: DEFAULT_CONFIG,
  });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");
  await fs.writeFile(path.join(worktree, "dirty-session.txt"), "committed by guardian_done\n", "utf8");
  const fakeGh = await installFakeGh(t, { repo, branch, dynamicHead: true });

  const result = await guardianDone({
    repoRoot: repo,
    cwd: worktree,
    sessionId,
    mode: "apply",
    confirm: true,
    commitMessage,
    timestamp: "2026-06-19T00:00:00.000Z",
    config: DEFAULT_CONFIG,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "landed-and-cleaned");
  assert.equal(result.commitMessage, commitMessage);
  assert.equal(typeof result.commit, "string");
  const commit = requireString(result.commit, "result.commit");
  const subject = (await git(repo, ["log", "-1", "--format=%s", commit])).stdout;
  assert.equal(subject, commitMessage);
  const log = await fs.readFile(fakeGh.logPath, "utf8");
  assert.match(log, /pr merge/);
  await git(repo, ["fetch", "origin", "main"]);
  await git(repo, ["merge-base", "--is-ancestor", commit, "origin/main"]);
  const worktrees = (await git(repo, ["worktree", "list", "--porcelain"])).stdout;
  assert.doesNotMatch(worktrees, new RegExp(escapeRegExp(worktree)));
  await assert.rejects(git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]));
});

test("guardian_done active-session apply reports cleanup sweep plan without deleting unrelated candidates", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const staleBranch = "guardian/post-finish-clean-candidate";
  await git(repo, ["checkout", "-b", staleBranch]);
  await fs.writeFile(path.join(repo, "stale-candidate.txt"), "stale candidate\n", "utf8");
  await git(repo, ["add", "stale-candidate.txt"]);
  await git(repo, ["commit", "-m", "add stale cleanup candidate"]);
  await git(repo, ["checkout", "main"]);
  await git(repo, ["merge", "--no-ff", staleBranch, "-m", "merge stale cleanup candidate"]);
  await git(repo, ["push", "origin", "main"]);
  const staleWorktree = path.join(repo, ".worktrees", path.basename(repo), "post-finish-clean-candidate");
  await git(repo, ["worktree", "add", staleWorktree, staleBranch]);
  const sessionId = "land-clean-planned-maintenance";
  const started = await guardianStart({
    repoRoot: repo,
    cwd: repo,
    sessionId,
    taskName: "partial maintenance",
    createWorktree: true,
    config: DEFAULT_CONFIG,
  });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");
  await fs.writeFile(path.join(worktree, "feature.txt"), "landed before partial maintenance\n", "utf8");
  await git(worktree, ["add", "feature.txt"]);
  await git(worktree, ["commit", "-m", "add partial maintenance fixture"]);
  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
  await installFakeGh(t, { repo, branch, head });

  const result = await guardianDone({
    repoRoot: repo,
    cwd: worktree,
    sessionId,
    mode: "apply",
    confirm: true,
    timestamp: "2026-06-19T00:00:00.000Z",
    config: DEFAULT_CONFIG,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "landed-and-cleaned");
  assert.equal(result.worktreeRemoved, true);
  assert.equal(result.branchDeleted, true);
  const cleanupSweep = requireRecord(result.cleanupSweep, "result.cleanupSweep");
  assert.equal(cleanupSweep.ok, true);
  assert.equal(cleanupSweep.status, "planned");
  assert.equal(cleanupSweep.candidateCount, 1);
  assert.equal(cleanupSweep.cleanedCount, 0);
  assert.match(String(cleanupSweep.reason), /separate guardian_finish_workflow apply confirmation/);
  await git(repo, ["fetch", "origin", "main"]);
  await git(repo, ["merge-base", "--is-ancestor", head, "origin/main"]);
  await assert.rejects(fs.access(worktree));
  await assert.rejects(git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]));
  await fs.access(staleWorktree);
  await git(repo, ["rev-parse", "--verify", `refs/heads/${staleBranch}`]);
});
