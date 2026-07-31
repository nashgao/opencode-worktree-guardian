import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { guardianStart } from "../src/start.ts";
import { getGuardianPaths, readState, recordSession } from "../src/state.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepoWithOrigin, createTempDir, git } from "./helpers.ts";
import { installFakeGh } from "./delete-fixtures.ts";

const execFileAsync = promisify(execFile);

type DoneResult = Record<string, unknown> & {
  readonly candidates?: readonly { readonly targetKind: string }[];
  readonly commitMessage?: string;
  readonly dirtyFiles?: readonly string[];
  readonly dirtySnapshot?: { readonly paths: readonly string[] };
  readonly lane?: string;
  readonly reason?: string;
  readonly status?: string;
  readonly suggestedCommands?: readonly string[];
  readonly worktreePath?: string;
};

function asDone(result: Record<string, unknown>): DoneResult {
  return result as DoneResult;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(`${name} must be a non-empty string`);
}

async function shadowOriginMain(repo: string, commit: string): Promise<void> {
  await git(repo, ["update-ref", "refs/heads/origin/main", commit]);
}

async function withFetchMarker<T>(marker: string, action: () => Promise<T>): Promise<T> {
  const tools = await createTempDir("guardian-fetch-marker-");
  const realGit = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
  await fs.writeFile(path.join(tools, "git"), `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = fetch ]; then : > ${JSON.stringify(marker)}; fi\ndone\nexec ${JSON.stringify(realGit)} "$@"\n`);
  await fs.chmod(path.join(tools, "git"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${tools}${path.delimiter}${originalPath ?? ""}`;
  try {
    return await action();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await fs.rm(tools, { recursive: true, force: true });
  }
}

async function setupDirtyPrimaryAndSession(sessionId: string) {
  const { base, repo } = await createRepoWithOrigin();
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: sessionId, createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(repo, "primary-target.txt"), "primary dirt\n");
  await fs.writeFile(path.join(started.session.worktree_path, "session-dirt.txt"), "session dirt\n");
  return { base, repo, started };
}

test("guardian_done explicit session target wins from dirty primary cwd", async (t) => {
  const { base, repo, started } = await setupDirtyPrimaryAndSession("ses_done_target_session");
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_done_target_session", commitMessage: "feat: finish session work" }));

  assert.equal(result.ok, true);
  assert.equal(result.status, "planned");
  assert.equal(result.lane, "session-finish");
  assert.equal(result.worktreePath, started.session.worktree_path);
  assert.deepEqual(result.dirtyFiles, ["session-dirt.txt"]);
  assert.equal(result.commitMessage, "feat: finish session work");
});

test("guardian_done bare dirty primary plus dirty session needs explicit target selection", async (t) => {
  const { base, repo, started } = await setupDirtyPrimaryAndSession("ses_done_target_ambiguous");
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: ambiguous work" }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "needs-selection");
  assert.equal(result.lane, "select-target");
  assert.match(String(result.reason), /multiple dirty implementation targets/);
  assert.deepEqual(result.candidates?.map((candidate) => candidate.targetKind).sort(), ["primary", "session"]);
  assert.ok(result.suggestedCommands?.includes("guardian_done primary=true commitMessage=..."));
  assert.ok(result.suggestedCommands?.includes(`guardian_done branch=${started.session.branch} commitMessage=...`));
});

test("guardian_done primary=true selects dirty primary when an active session is also dirty", async (t) => {
  const { base, repo } = await setupDirtyPrimaryAndSession("ses_done_target_primary");
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", primary: true, commitMessage: "feat: publish primary work" }));

  assert.equal(result.ok, true);
  assert.equal(result.status, "planned");
  assert.equal(result.lane, "primary-main-publish");
  assert.deepEqual(result.dirtySnapshot?.paths, ["primary-target.txt"]);
  assert.equal(result.commitMessage, "feat: publish primary work");
});

test("guardian_done apply lands an indexed removal while its ignored file remains in the worktree", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "land-clean-indexed-removal-session";
  const commitMessage = "fix: remove tracked stats from index";
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
    taskName: "land indexed removal",
    createWorktree: true,
    config: DEFAULT_CONFIG,
  });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");
  const worktreeStatsPath = path.join(worktree, ".claude", "stats", "commits.json");
  await fs.mkdir(path.dirname(worktreeStatsPath), { recursive: true });
  await fs.writeFile(worktreeStatsPath, "{\"commits\":[]}\n", "utf8");
  await git(worktree, ["rm", "--cached", "--", ".claude/stats/commits.json"]);
  await assert.doesNotReject(fs.access(worktreeStatsPath));
  const fakeGh = await installFakeGh(t, { repo, branch, dynamicHead: true });

  const blockedRequest = { repoRoot: repo, cwd: worktree, sessionId, commitMessage, timestamp: "2026-06-19T00:00:00.000Z", config: DEFAULT_CONFIG };
  const branchBefore = (await git(worktree, ["rev-parse", branch])).stdout;
  const remoteMainBefore = (await git(repo, ["rev-parse", "origin/main"])).stdout;
  const remoteBranchBefore = (await git(repo, ["ls-remote", "--heads", "origin", branch])).stdout;
  const safetyRefsBefore = (await git(repo, ["for-each-ref", "--format=%(refname)", "refs/opencode-guardian"])).stdout;
  const ignoredBytesBefore = await fs.readFile(worktreeStatsPath, "utf8");
  const blocked = await guardianDone({ ...blockedRequest, mode: "plan" });
  assert.equal(blocked.ok, false, JSON.stringify(blocked));
  assert.deepEqual({
    status: blocked.status,
    reason: requireString(blocked.reason, "blocked.reason"),
    branch: (await git(worktree, ["rev-parse", branch])).stdout,
    remoteMain: (await git(repo, ["rev-parse", "origin/main"])).stdout,
    remoteBranch: (await git(repo, ["ls-remote", "--heads", "origin", branch])).stdout,
    safetyRefs: (await git(repo, ["for-each-ref", "--format=%(refname)", "refs/opencode-guardian"])).stdout,
    ignoredBytes: await fs.readFile(worktreeStatsPath, "utf8"),
    fakeGhInvoked: await fs.access(fakeGh.logPath).then(() => true, () => false),
    worktreePresent: await fs.access(worktree).then(() => true, () => false),
    branchPresent: await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]).then(() => true, () => false),
  }, {
    status: "blocked",
    reason: "worktree has ignored files",
    branch: branchBefore,
    remoteMain: remoteMainBefore,
    remoteBranch: remoteBranchBefore,
    safetyRefs: safetyRefsBefore,
    ignoredBytes: ignoredBytesBefore,
    fakeGhInvoked: false,
    worktreePresent: true,
    branchPresent: true,
  });

  // When
  const request = {
    repoRoot: repo,
    cwd: worktree,
    sessionId,
    allowIgnoredFiles: true,
    commitMessage,
    timestamp: "2026-06-19T00:00:00.000Z",
    config: DEFAULT_CONFIG,
  };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");
  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });

  // Then
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "landed-and-cleaned");
  const commit = (await git(repo, ["rev-parse", "origin/main"])).stdout.trim();
  await git(repo, ["fetch", "origin", "main"]);
  await git(repo, ["merge-base", "--is-ancestor", commit, "origin/main"]);
  await assert.rejects(git(repo, ["cat-file", "-e", `${commit}:.claude/stats/commits.json`]));
  assert.equal(result.worktreeRemoved, true);
  assert.equal(result.branchDeleted, true);
  await assert.rejects(fs.access(worktree));
  await assert.rejects(git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]));
});

test("primary publish preflight ignores a local origin/main shadow", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const localHead = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  const tree = (await git(repo, ["rev-parse", "HEAD^{tree}"])).stdout;
  const remoteAdvance = (await git(repo, ["commit-tree", tree, "-p", localHead, "-m", "remote advance"])).stdout;
  await git(repo, ["push", "origin", `${remoteAdvance}:refs/heads/main`]);
  await git(repo, ["fetch", "origin"]);
  await shadowOriginMain(repo, localHead);
  await fs.writeFile(path.join(repo, "primary-dirty.txt"), "dirty\n");

  const result = await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: authority publish", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(String(result.reason), /not synced/);
});

test("guardian_done blocks overlapping trusted remote namespaces before primary publish fetch", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "primary-overlap.txt"), "dirty\n");
  const marker = path.join(base, "primary-overlap-fetch-ran");
  const config = { ...DEFAULT_CONFIG, trustedUpstreamRemotes: ["origin/main"] };
  const result = await withFetchMarker(marker, () => guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: overlap", config }));
  assert.equal(result.ok, false);
  assert.match(String(result.error), /remote namespaces overlap/);
  await assert.rejects(fs.access(marker));
});

test("guardian_done blocks an unrecorded same-OID dirty-commit safety ref", async (t) => {
  const { base, repo } = await createRepoWithOrigin(); t.after(() => fs.rm(base, { recursive: true, force: true })); const sessionId = "reservation-unrecorded";
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: sessionId, createWorktree: true, config: DEFAULT_CONFIG }); const worktree = started.session.worktree_path; const branch = started.session.branch;
  await fs.writeFile(path.join(worktree, "feature.txt"), "feature\n", "utf8"); await installFakeGh(t, { repo, branch, dynamicHead: true }); const request = { repoRoot: repo, cwd: worktree, sessionId, commitMessage: "feat: reserve safety ref", timestamp: "2026-07-29T03:00:00.000Z", config: DEFAULT_CONFIG };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan"); const safetyRef = requireString(plan.safetyRef, "plan.safetyRef"); const expectedHead = (await git(worktree, ["rev-parse", "HEAD"])).stdout; await git(repo, ["update-ref", safetyRef, expectedHead]);
  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });
  assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.status, "blocked"); assert.match(requireString(result.error, "result.error"), /reservation/i);
  assert.equal((await git(repo, ["rev-parse", safetyRef])).stdout, expectedHead); assert.equal((await git(worktree, ["rev-parse", "HEAD"])).stdout, expectedHead);
});

test("guardian_done blocks a same-OID reservation owned by another session", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "reservation-owner-mismatch";
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: sessionId, createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  const branch = started.session.branch;
  await fs.writeFile(path.join(worktree, "feature.txt"), "feature\n", "utf8");
  await installFakeGh(t, { repo, branch, dynamicHead: true });
  const request = { repoRoot: repo, cwd: worktree, sessionId, commitMessage: "feat: reserve safety ref", timestamp: "2026-07-29T04:30:00.000Z", config: DEFAULT_CONFIG };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");
  const safetyRef = requireString(plan.safetyRef, "plan.safetyRef");
  const expectedHead = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  await git(repo, ["update-ref", safetyRef, expectedHead]);
  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });
  const session = requireRecord(state.sessions[sessionId], "session");
  await recordSession(repo, DEFAULT_CONFIG, {
    ...session,
    session_id: sessionId,
    dirty_commit_safety_ref_reservation: {
      session_id: "another-session",
      branch: requireString(session.branch, "session.branch"),
      expected_head: expectedHead,
      safety_ref: safetyRef,
      confirm_token: requireString(plan.confirmToken, "plan.confirmToken"),
      reserved_at: "2026-07-29T04:30:01.000Z",
    },
  });

  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.match(requireString(result.error, "result.error"), /reservation/i);
  assert.equal((await git(worktree, ["rev-parse", "HEAD"])).stdout, expectedHead);
});
