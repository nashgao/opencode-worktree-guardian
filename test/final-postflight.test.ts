import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { runFinalCleanupPostflight } from "../src/final-postflight.ts";
import { guardianFinish } from "../src/finish.ts";
import { guardianFinishWorkflow } from "../src/workflow.ts";
import { workflowResult } from "./workflow-test-support.ts";
import { createSafetyRef } from "../src/git.ts";
import { guardianStatus } from "../src/recover.ts";
import { guardianStart } from "../src/start.ts";
import { isRecordLike, type GuardianSession } from "../src/types.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";
import { installFakeGh } from "./delete-fixtures.ts";

const execFileAsync = promisify(execFile);

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(`${name} must be a non-empty string`);
}

function requireSession(session: GuardianSession | undefined): GuardianSession {
  assert.ok(session);
  return session;
}

function findSession(sessions: readonly GuardianSession[], sessionId: string): GuardianSession {
  return requireSession(sessions.find((session) => session.session_id === sessionId));
}

async function pathExists(target: string) {
  return fs.access(target).then(() => true, () => false);
}

async function gitBlobBytes(repo: string, commit: string, filePath: string): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["-C", repo, "show", `${commit}:${filePath}`], { encoding: "buffer" });
  return stdout;
}

test("final postflight blocks safety-reffed commits that are absent from final base", async () => {
  const { repo } = await createRepoWithOrigin();
  await fs.writeFile(path.join(repo, "feature.go"), "package main\n");
  await git(repo, ["add", "feature.go"]);
  await git(repo, ["commit", "-m", "fix: local behavior"]);
  const dropped = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  const safetyRef = await createSafetyRef(repo, { sessionId: "discard-local-main-divergence", branch: "main", commit: dropped, timestamp: "20260628T134058" });

  await git(repo, ["reset", "--keep", "origin/main"]);

  const result = await runFinalCleanupPostflight({
    repoRoot: repo,
    config: DEFAULT_CONFIG,
    requiredCommits: [{ commit: dropped, source: "main", reason: "local main commit must survive cleanup" }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.deepEqual((result.droppedCommits as Array<{ commit: string; safetyRefs: string[] }>).map((entry) => entry.commit), [dropped]);
  assert.match(JSON.stringify(result.blockers), /dropped-required-commit/);
  assert.match(JSON.stringify(result.blockers), new RegExp(safetyRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("final postflight treats explicit discard confirmation differently from preservation", async () => {
  const { repo } = await createRepoWithOrigin();
  await fs.writeFile(path.join(repo, "discarded.go"), "package main\n");
  await git(repo, ["add", "discarded.go"]);
  await git(repo, ["commit", "-m", "chore: discarded scratch"]);
  const discarded = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  await createSafetyRef(repo, { sessionId: "discard-local-main-divergence", branch: "main", commit: discarded, timestamp: "20260628T134058" });
  await git(repo, ["reset", "--keep", "origin/main"]);

  const result = await runFinalCleanupPostflight({
    repoRoot: repo,
    config: DEFAULT_CONFIG,
    requiredCommits: [{ commit: discarded, source: "main", discardConfirmed: true, discardEvidence: { reviewed: true } }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "passed");
  assert.equal((result.droppedCommits as Array<{ commit: string }>).length, 1);
});

test("final postflight allows the resolved upstream remote branch by default", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const gitlab = path.join(base, "gitlab.git");
  await execFileAsync("git", ["init", "--bare", gitlab]);
  await git(repo, ["remote", "add", "gitlab", gitlab]);
  await git(repo, ["push", "-u", "gitlab", "main:trunk"]);
  await git(repo, ["branch", "--set-upstream-to", "gitlab/trunk", "main"]);

  const result = await runFinalCleanupPostflight({
    repoRoot: repo,
    config: { ...DEFAULT_CONFIG, trustedUpstreamRemotes: ["gitlab"] },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "passed");
});

test("final postflight reports stash inventory without blocking by default", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "postflight-stashed.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "postflight stash"]);

  const result = await runFinalCleanupPostflight({ repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "passed");
  assert.equal(Array.isArray(result.stashes) ? result.stashes.length : 0, 1);
  assert.equal((result.blockers as Array<{ kind: string }>).some((blocker) => blocker.kind === "stashes"), false);
});

test("guardian_finish_workflow reports stash inventory without blocking by default", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "stashed.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "workflow stash"]);
  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(typeof plan.confirmToken, "string");
  assert.equal(plan.preflight.candidateScanStatus, "completed");
  assert.equal(plan.preflight.stashCount, 1);
  assert.equal(plan.preflight.stashes?.length, 1);
});

test("final postflight blocks stash inventory under strict policy", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "postflight-stashed-strict.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "strict postflight stash"]);
  const config = { ...DEFAULT_CONFIG, requireEmptyStashInventory: true };

  const result = await runFinalCleanupPostflight({ repoRoot: repo, config });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal((result.blockers as Array<{ kind: string }>).some((blocker) => blocker.kind === "stashes"), true);
});

test("guardian_done apply commits a tracked ignored stats file before landing and cleanup", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "land-clean-tracked-ignored-session";
  const commitMessage = "fix: commit tracked ignored stats";
  const statsPath = path.join(repo, ".claude", "stats", "commits.json");
  await fs.mkdir(path.dirname(statsPath), { recursive: true });
  await fs.writeFile(statsPath, "{\"commits\":[]}\n", "utf8");
  await git(repo, ["add", ".claude/stats/commits.json"]);
  await git(repo, ["commit", "-m", "track guardian stats fixture"]);
  await fs.writeFile(path.join(repo, ".gitignore"), ".claude/\n", "utf8");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore guardian runtime state"]);
  await git(repo, ["push", "origin", "main"]);
  const started = await guardianStart({
    repoRoot: repo,
    cwd: repo,
    sessionId,
    taskName: "land tracked ignored stats",
    createWorktree: true,
    config: DEFAULT_CONFIG,
  });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");
  const worktreeStatsPath = path.join(worktree, ".claude", "stats", "commits.json");
  await fs.mkdir(path.dirname(worktreeStatsPath), { recursive: true });
  await fs.writeFile(worktreeStatsPath, "{\"commits\":[\"finished\"]}\n", "utf8");
  const approvedStatsBytes = await fs.readFile(worktreeStatsPath);
  await installFakeGh(t, { repo, branch, dynamicHead: true });

  // When
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

  // Then
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "landed-and-cleaned");
  assert.equal(result.commitMessage, commitMessage);
  const commit = requireString(result.commit, "result.commit");
  await git(repo, ["fetch", "origin", "main"]);
  await git(repo, ["merge-base", "--is-ancestor", commit, "origin/main"]);
  assert.deepEqual(await gitBlobBytes(repo, commit, ".claude/stats/commits.json"), approvedStatsBytes);
  assert.equal(result.worktreeRemoved, true);
  assert.equal(result.branchDeleted, true);
  await assert.rejects(fs.access(worktree));
  await assert.rejects(git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]));
});

test("merge-to-base cleanup avoids ambiguous branch-delete commands for valid branch names", async () => {
  const source = await fs.readFile(new URL("../src/finish-merge-to-base.ts", import.meta.url), "utf8");

  assert.match(source, /deleteBranchAtHead\(repoRoot, branch, commit\)/);
  assert.doesNotMatch(source, /runGit\(repoRoot, \["branch", "-d", branch\]\)/);
});

test("merge-to-base cleanup preserves an advanced branch after worktree removal", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const config = { ...DEFAULT_CONFIG, finishMode: "merge-to-base" };
  const start = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_merge_cleanup_advanced", taskName: "merge cleanup advanced", createWorktree: true, config });
  await fs.writeFile(path.join(start.session.worktree_path, "merged.txt"), "merged\n");
  await git(start.session.worktree_path, ["add", "merged.txt"]);
  await git(start.session.worktree_path, ["commit", "-m", "add merged file"]);
  const { stdout: commit } = await git(start.session.worktree_path, ["rev-parse", "HEAD"]);
  const { stdout: tree } = await git(repo, ["rev-parse", `${commit}^{tree}`]);
  const { stdout: advancedCommit } = await git(repo, ["commit-tree", tree, "-p", commit, "-m", "advance branch after cleanup removal"]);
  const gitWrapper = path.join(base, "git-wrapper");
  await fs.mkdir(gitWrapper);
  await fs.writeFile(path.join(gitWrapper, "git"), `#!/bin/sh
if [ "$3" = "worktree" ] && [ "$4" = "remove" ] && [ "$5" = "$GUARDIAN_RACE_WORKTREE" ]; then
  /usr/bin/git "$@" || exit $?
  exec /usr/bin/git -C "$GUARDIAN_RACE_REPO" update-ref "refs/heads/$GUARDIAN_RACE_BRANCH" "$GUARDIAN_RACE_HEAD"
fi
exec /usr/bin/git "$@"
`);
  await fs.chmod(path.join(gitWrapper, "git"), 0o755);
  const originalPath = process.env.PATH;
  const originalRaceWorktree = process.env.GUARDIAN_RACE_WORKTREE;
  const originalRaceRepo = process.env.GUARDIAN_RACE_REPO;
  const originalRaceBranch = process.env.GUARDIAN_RACE_BRANCH;
  const originalRaceHead = process.env.GUARDIAN_RACE_HEAD;
  process.env.PATH = `${gitWrapper}${path.delimiter}${originalPath ?? ""}`;
  process.env.GUARDIAN_RACE_WORKTREE = start.session.worktree_path;
  process.env.GUARDIAN_RACE_REPO = repo;
  process.env.GUARDIAN_RACE_BRANCH = start.session.branch;
  process.env.GUARDIAN_RACE_HEAD = advancedCommit;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalRaceWorktree === undefined) delete process.env.GUARDIAN_RACE_WORKTREE;
    else process.env.GUARDIAN_RACE_WORKTREE = originalRaceWorktree;
    if (originalRaceRepo === undefined) delete process.env.GUARDIAN_RACE_REPO;
    else process.env.GUARDIAN_RACE_REPO = originalRaceRepo;
    if (originalRaceBranch === undefined) delete process.env.GUARDIAN_RACE_BRANCH;
    else process.env.GUARDIAN_RACE_BRANCH = originalRaceBranch;
    if (originalRaceHead === undefined) delete process.env.GUARDIAN_RACE_HEAD;
    else process.env.GUARDIAN_RACE_HEAD = originalRaceHead;
  });

  const result = await guardianFinish({ repoRoot: repo, cwd: start.session.worktree_path, sessionId: "ses_merge_cleanup_advanced", config, allowMergeToBase: true, allowCleanup: true });

  assert.equal(result.ok, false);
  assert.equal(result.status, "partial");
  assert.equal(result.worktreeRemoved, true);
  assert.equal(result.branchDeleted, false);
  assert.match(String(result.reason), /worktree deleted but branch deletion failed/);
  assert.equal(await pathExists(start.session.worktree_path), false);
  assert.equal((await git(repo, ["rev-parse", `refs/heads/${start.session.branch}`])).stdout, advancedCommit);
  const status = await guardianStatus({ repoRoot: repo, config });
  const session = findSession(status.sessions, "ses_merge_cleanup_advanced");
  assert.equal(session.status, "finished");
  assert.equal(session.deleted_worktree_path, start.session.worktree_path);
  assert.equal(session.deleted_branch, null);
  assert.equal(session.branch_delete_failed, true);
});
