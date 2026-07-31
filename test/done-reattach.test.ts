import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { guardianFinish } from "../src/finish.ts";
import { guardianStatus } from "../src/recover.ts";
import { updateState } from "../src/state.ts";
import { guardianStart } from "../src/tools.ts";
import { isRecordLike, type GuardianConfig } from "../src/types.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";
import { installFakeGh } from "./delete-fixtures.ts";

type LooseRecord = Record<string, unknown>;

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(`${name} must be a non-empty string`);
}

type SessionFixtureOptions = {
  readonly t: TestContext;
  readonly sessionId: string;
  readonly taskName: string;
};

async function createSessionFixture(options: SessionFixtureOptions) {
  const { base, repo } = await createRepoWithOrigin();
  options.t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = requireRecord(await guardianStart({
    repoRoot: repo,
    cwd: repo,
    sessionId: options.sessionId,
    taskName: options.taskName,
    createWorktree: true,
    config: DEFAULT_CONFIG,
  }), "started");
  const session = requireRecord(started.session, "started.session");
  return {
    repo,
    worktree: requireString(session.worktree_path, "started.session.worktree_path"),
    branch: requireString(session.branch, "started.session.branch"),
  };
}

async function guardianRefNames(repo: string) {
  const { stdout } = await git(repo, ["for-each-ref", "--format=%(refname)", "refs/opencode-guardian"]);
  return stdout.length === 0 ? [] : stdout.split("\n");
}

async function shadowOriginMain(repo: string, commit: string): Promise<void> {
  await git(repo, ["update-ref", "refs/heads/origin/main", commit]);
}

test("guardian_finish plan recovers an unrecorded Guardian worktree without recording state", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_finish_plan_closed", taskName: "finish plan closed", createWorktree: true, config: DEFAULT_CONFIG });
  const closed = await guardianFinish({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: "ses_finish_plan_closed", timestamp: "20260609T035000" });
  assert.equal(closed.ok, true);
  assert.equal(closed.status, "pr-suggested");
  await fs.writeFile(path.join(started.session.worktree_path, "after-finish-plan.txt"), "after finish plan\n");
  await git(started.session.worktree_path, ["add", "after-finish-plan.txt"]);
  await git(started.session.worktree_path, ["commit", "-m", "add work after finish plan"]);

  const plan = await guardianFinish({ repoRoot: repo, cwd: started.session.worktree_path, mode: "plan", finishMode: "preserve-only", timestamp: "20260609T035100" });

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.preflight.sessionRecorded, false);
  assert.equal(plan.preflight.sessionRecovered, true);
  const sessionId = plan.preflight.sessionId;
  if (typeof sessionId !== "string") throw new Error("planned recovery did not report a session id");
  assert.match(sessionId, /^ses_recovered_guardian-finish-plan-closed/);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.activeSessions.some((session: LooseRecord) => session.session_id === sessionId), false);
  assert.equal(status.terminalSessions.some((session: LooseRecord) => session.session_id === sessionId), false);
  assert.deepEqual(await guardianRefNames(repo), [closed.safetyRef]);
});

test("guardian_done reattaches a closed Guardian worktree without caller-supplied session id", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_closed", taskName: "done closed", createWorktree: true, config: DEFAULT_CONFIG });
  const closed = await guardianFinish({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: "ses_done_closed", timestamp: "20260609T040000" });
  assert.equal(closed.ok, true);
  assert.equal(closed.status, "pr-suggested");
  await fs.writeFile(path.join(started.session.worktree_path, "after-close.txt"), "after close\n");
  await git(started.session.worktree_path, ["add", "after-close.txt"]);
  await git(started.session.worktree_path, ["commit", "-m", "add work after closed session"]);

  const plan = await guardianDone({ repoRoot: repo, cwd: started.session.worktree_path, timestamp: "20260609T040404" });

  assert.equal(plan.ok, true);
  assert.equal(plan.lane, "session-finish");
  assert.equal(plan.status, "planned");
  assert.equal(plan.action, "reattach-and-finish");
  assert.equal(plan.reattached, true);
  assert.equal(plan.worktree, started.session.worktree_path);
  assert.equal(plan.nextAction, "guardian_done mode=apply confirm=true");
  if (!isRecordLike(plan.preflight)) throw new Error("guardian_done plan result is missing preflight details");
  assert.equal(plan.preflight.sessionRecorded, false);
  assert.equal(plan.preflight.sessionRecovered, true);
  assert.equal(plan.preflight.sessionOwnedWorktree, true);
  assert.deepEqual(plan.preflight.blockingDirtyFiles, []);
  const sessionId = plan.sessionId;
  if (typeof sessionId !== "string") throw new Error("reattached finish did not report a session id");
  assert.match(sessionId, /^ses_recovered_guardian-done-closed/);
  const plannedStatus = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(plannedStatus.activeSessions.some((session: LooseRecord) => session.session_id === sessionId), false);
  assert.equal(plannedStatus.terminalSessions.some((session: LooseRecord) => session.session_id === sessionId), false);

  const result = await guardianDone({ repoRoot: repo, cwd: started.session.worktree_path, mode: "apply", confirm: true, timestamp: "20260609T040404" });

  assert.equal(result.ok, true);
  assert.equal(result.lane, "session-finish");
  assert.equal(result.status, "pr-suggested");
  assert.equal(result.reattached, true);
  if (!isRecordLike(result.preflight)) throw new Error("guardian_done apply result is missing preflight details");
  assert.equal(result.preflight.currentWorktree, started.session.worktree_path);
  assert.equal(result.preflight.sessionOwnedWorktree, true);
  assert.equal(result.preflight.sessionId, sessionId);
});

test("guardian_done reattach plan reports dirty blockers without recording a recovered session", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_closed_dirty", taskName: "done closed dirty", createWorktree: true, config: DEFAULT_CONFIG });
  const closed = await guardianFinish({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: "ses_done_closed_dirty", timestamp: "20260609T040606" });
  assert.equal(closed.ok, true);
  assert.equal(closed.status, "pr-suggested");
  await fs.writeFile(path.join(started.session.worktree_path, "dirty-after-close.txt"), "dirty after close\n");
  await git(started.session.worktree_path, ["add", "dirty-after-close.txt"]);
  await updateState(repo, DEFAULT_CONFIG, (state) => {
    delete state.sessions.ses_done_closed_dirty;
    return state;
  });

  const result = await guardianDone({ repoRoot: repo, cwd: started.session.worktree_path, timestamp: "20260609T040707" });

  assert.equal(result.ok, false);
  assert.equal(result.lane, "session-finish");
  assert.equal(result.status, "blocked");
  assert.equal(result.action, "reattach-and-finish");
  assert.equal(result.reattached, true);
  assert.match(String(result.reason), /uncommitted changes/);
  if (!isRecordLike(result.preflight)) throw new Error("guardian_done dirty plan result is missing preflight details");
  assert.equal(result.preflight.sessionRecorded, false);
  assert.equal(result.preflight.sessionRecovered, true);
  assert.deepEqual(result.preflight.blockingDirtyFiles, ["dirty-after-close.txt"]);
  const sessionId = result.sessionId;
  if (typeof sessionId !== "string") throw new Error("dirty reattach plan did not report a session id");
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.activeSessions.some((session: LooseRecord) => session.session_id === sessionId), false);
  assert.equal(status.terminalSessions.some((session: LooseRecord) => session.session_id === sessionId), false);
  assert.deepEqual(await guardianRefNames(repo), [closed.safetyRef]);
});

test("guardian_done blocks changed content at the same planned dirty path", async (t) => {
  // Given
  const sessionId = "land-clean-same-path-content";
  const { repo, worktree, branch } = await createSessionFixture({ t, sessionId, taskName: "same path content" });
  const dirtyPath = path.join(worktree, "feature.txt");
  await fs.writeFile(dirtyPath, "planned\n", "utf8");
  const fakeGh = await installFakeGh(t, { repo, branch, dynamicHead: true });
  const request = { repoRoot: repo, cwd: worktree, sessionId, commitMessage: "feat: planned content", config: DEFAULT_CONFIG };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");
  const refsBefore = (await git(repo, ["for-each-ref", "--format=%(refname)", "refs/opencode-guardian"])).stdout;
  const remoteMainBefore = (await git(repo, ["rev-parse", "origin/main"])).stdout;

  // When
  await fs.writeFile(dirtyPath, "changed after plan\n", "utf8");
  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });

  // Then
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.match(requireString(result.reason, "result.reason"), /plan changed/);
  await fs.access(worktree);
  await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  assert.equal((await git(repo, ["rev-parse", "origin/main"])).stdout, remoteMainBefore);
  assert.equal((await git(repo, ["for-each-ref", "--format=%(refname)", "refs/opencode-guardian"])).stdout, refsBefore);
  assert.equal(await fs.access(fakeGh.logPath).then(() => true, () => false), false);
});

test("guardian_done blocks a changed status at the planned dirty path", async (t) => {
  // Given
  const sessionId = "land-clean-same-path-status";
  const { repo, worktree, branch } = await createSessionFixture({ t, sessionId, taskName: "same path status" });
  const dirtyPath = path.join(worktree, "feature.txt");
  await fs.writeFile(dirtyPath, "planned\n", "utf8");
  const fakeGh = await installFakeGh(t, { repo, branch, dynamicHead: true });
  const request = { repoRoot: repo, cwd: worktree, sessionId, commitMessage: "feat: planned status", config: DEFAULT_CONFIG };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");
  const refsBefore = (await git(repo, ["for-each-ref", "--format=%(refname)", "refs/opencode-guardian"])).stdout;

  // When
  await fs.rm(dirtyPath);
  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });

  // Then
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.match(requireString(result.reason, "result.reason"), /plan changed/);
  await fs.access(worktree);
  await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  assert.equal((await git(repo, ["for-each-ref", "--format=%(refname)", "refs/opencode-guardian"])).stdout, refsBefore);
  assert.equal(await fs.access(fakeGh.logPath).then(() => true, () => false), false);
});

test("guardian_done blocks an advanced remote base after plan", async (t) => {
  const sessionId = "land-clean-advanced-base";
  const { repo, worktree, branch } = await createSessionFixture({ t, sessionId, taskName: "advanced base" });
  await fs.writeFile(path.join(worktree, "feature.txt"), "feature\n");
  const fakeGh = await installFakeGh(t, { repo, branch, dynamicHead: true });
  const request = { repoRoot: repo, cwd: worktree, sessionId, commitMessage: "feat: base drift", config: DEFAULT_CONFIG };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");
  await fs.writeFile(path.join(repo, "base.txt"), "advanced\n");
  await git(repo, ["add", "base.txt"]);
  await git(repo, ["commit", "-m", "advance remote base"]);
  await git(repo, ["push", "origin", "main"]);
  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });
  assert.equal(result.ok, false, JSON.stringify(result));
  await fs.access(worktree);
  await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  assert.equal(await fs.access(fakeGh.logPath).then(() => true, () => false), false);
});

test("guardian_finish blocks overlapping trusted remote namespaces before finish planning", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "authority-overlap-finish", taskName: "authority overlap finish", createWorktree: true, config: DEFAULT_CONFIG });
  assert.equal(started.ok, true, JSON.stringify(started));
  const config = { ...DEFAULT_CONFIG, finishMode: "merge-to-base", trustedUpstreamRemotes: ["origin/main"] } satisfies GuardianConfig;

  const result = await guardianFinish({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: "authority-overlap-finish", mode: "plan", allowMergeToBase: true, config });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(String(result.error), /remote namespaces overlap/);
});

test("merge-to-base proof ignores a local origin/main shadow", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const config = { ...DEFAULT_CONFIG, finishMode: "merge-to-base" } satisfies GuardianConfig;
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "authority-finish", taskName: "authority finish", createWorktree: true, config });
  assert.equal(started.ok, true, JSON.stringify(started));
  await fs.writeFile(path.join(started.session.worktree_path, "finish.txt"), "finish\n");
  await git(started.session.worktree_path, ["add", "finish.txt"]);
  await git(started.session.worktree_path, ["commit", "-m", "finish authority"]);
  const head = (await git(started.session.worktree_path, ["rev-parse", "HEAD"])).stdout;
  await shadowOriginMain(repo, head);
  const tools = path.join(base, "no-op-push");
  await fs.mkdir(tools);
  await fs.writeFile(path.join(tools, "git"), "#!/bin/sh\nif [ \"$3\" = push ]; then exit 0; fi\nexec /usr/bin/git \"$@\"\n");
  await fs.chmod(path.join(tools, "git"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${tools}${path.delimiter}${originalPath ?? ""}`;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  const result = await guardianFinish({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: "authority-finish", config, allowMergeToBase: true });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(String(result.reason), /not proven reachable/);
});
