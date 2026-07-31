import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { formatGuardianOutput } from "../src/plugin/readable-output.ts";
import { guardianStart } from "../src/start.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";
import { installFakeGh } from "./delete-fixtures.ts";

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

async function remoteBranchExists(repo: string, branch: string): Promise<boolean> {
  const result = await git(repo, ["ls-remote", "--heads", "origin", branch]);
  return result.stdout.length > 0;
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

  const request = {
    repoRoot: repo,
    cwd: worktree,
    sessionId,
    timestamp: "2026-06-19T00:00:00.000Z",
    config: DEFAULT_CONFIG,
  };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");
  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });

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

test("guardian_done session apply retains advisory stash inventory", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "land-clean-stash-session";
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "land clean stash", createWorktree: true, config: DEFAULT_CONFIG });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");
  await fs.writeFile(path.join(worktree, "feature-stash.txt"), "feature\n");
  await git(worktree, ["add", "feature-stash.txt"]);
  await git(worktree, ["commit", "-m", "add stash advisory fixture"]);
  await fs.writeFile(path.join(repo, "session-stashed.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "session finish stash"]);
  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
  await installFakeGh(t, { repo, branch, head });

  const plan = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "plan", config: DEFAULT_CONFIG });
  const result = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken"), config: DEFAULT_CONFIG });

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.stashCount, 1);
  assert.equal(result.ok, true);
  assert.equal(result.status, "landed-and-cleaned");
  assert.equal(result.lane, "session-finish");
  assert.equal(result.stashCount, 1);
  assert.equal(Array.isArray(result.stashes) ? result.stashes.length : 0, 1);
  assert.match(formatGuardianOutput("guardian_done", result), /\[WARN\] repository stash inventory: 1/);
});

test("guardian_done strict stash policy blocks before session branch or base mutation", async (t) => {
  const { repo } = await createRepoWithOrigin();
  const sessionId = "land-clean-stash-strict-session";
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "strict land clean stash", createWorktree: true, config: DEFAULT_CONFIG });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");
  await fs.writeFile(path.join(worktree, "feature-stash-strict.txt"), "feature\n");
  await git(worktree, ["add", "feature-stash-strict.txt"]);
  await git(worktree, ["commit", "-m", "add strict stash fixture"]);
  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
  await installFakeGh(t, { repo, branch, head });
  await fs.writeFile(path.join(repo, "session-stashed-strict.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "strict session finish stash"]);
  const remoteMainBefore = (await git(repo, ["rev-parse", "origin/main"])).stdout.trim();
  const config = { ...DEFAULT_CONFIG, requireEmptyStashInventory: true };

  const result = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "apply", confirm: true, config });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(String(result.reason), /stash inventory/);
  assert.equal(result.stashCount, 1);
  assert.equal(await remoteBranchExists(repo, branch), false);
  assert.equal((await git(repo, ["rev-parse", "origin/main"])).stdout.trim(), remoteMainBefore);
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

  const request = {
    repoRoot: repo,
    cwd: worktree,
    sessionId,
    commitMessage,
    timestamp: "2026-06-19T00:00:00.000Z",
    config: DEFAULT_CONFIG,
  };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");
  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });

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

test("guardian_done active-session apply cleans unrelated safe cleanup candidates", async (t) => {
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

  const request = {
    repoRoot: repo,
    cwd: worktree,
    sessionId,
    timestamp: "2026-06-19T00:00:00.000Z",
    config: DEFAULT_CONFIG,
  };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");
  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "landed-and-cleaned");
  assert.equal(result.worktreeRemoved, true);
  assert.equal(result.branchDeleted, true);
  const cleanupSweep = requireRecord(result.cleanupSweep, "result.cleanupSweep");
  assert.equal(cleanupSweep.ok, true);
  assert.equal(cleanupSweep.status, "cleaned");
  assert.equal(cleanupSweep.candidateCount, 2);
  assert.equal(cleanupSweep.cleanedCount, 2);
  await git(repo, ["fetch", "origin", "main"]);
  await git(repo, ["merge-base", "--is-ancestor", head, "origin/main"]);
  await assert.rejects(fs.access(worktree));
  await assert.rejects(git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]));
  assert.equal(await remoteBranchExists(repo, branch), false);
  await assert.rejects(fs.access(staleWorktree));
  await assert.rejects(git(repo, ["rev-parse", "--verify", `refs/heads/${staleBranch}`]));
});

test("guardian_done preserves the session when a PR merge advances base beyond the approved head", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "land-clean-unapproved-base-descendant";
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "unapproved base descendant", createWorktree: true, config: DEFAULT_CONFIG });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");
  await fs.writeFile(path.join(worktree, "feature.txt"), "feature\n", "utf8");
  await git(worktree, ["add", "feature.txt"]);
  await git(worktree, ["commit", "-m", "add approved feature"]);
  const hooksPath = path.resolve(repo, (await git(repo, ["rev-parse", "--git-path", "hooks"])).stdout);
  await fs.mkdir(hooksPath, { recursive: true });
  const hookPath = path.join(hooksPath, "post-merge");
  await fs.writeFile(hookPath, "#!/bin/sh\nset -eu\nprintf 'unapproved\\n' > unapproved.txt\ngit add -- unapproved.txt\ngit commit -m 'unapproved base advance' >/dev/null\n", "utf8");
  await fs.chmod(hookPath, 0o755);
  await installFakeGh(t, { repo, branch, dynamicHead: true });
  const request = { repoRoot: repo, cwd: worktree, sessionId, config: DEFAULT_CONFIG };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");

  // When
  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });

  // Then
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.match(requireString(result.reason, "result.reason"), /approved topology/);
  await git(repo, ["cat-file", "-e", "origin/main:unapproved.txt"]);
  await fs.access(worktree);
  await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
});
