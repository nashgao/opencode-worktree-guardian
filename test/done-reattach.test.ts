import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { guardianFinish } from "../src/finish.ts";
import { guardianStatus } from "../src/recover.ts";
import { updateState } from "../src/state.ts";
import { guardianStart } from "../src/tools.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

type LooseRecord = Record<string, unknown>;

async function guardianRefNames(repo: string) {
  const { stdout } = await git(repo, ["for-each-ref", "--format=%(refname)", "refs/opencode-guardian"]);
  return stdout.length === 0 ? [] : stdout.split("\n");
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

  const result = await guardianDone({ repoRoot: repo, cwd: started.session.worktree_path, mode: "apply", confirm: true, timestamp: "20260609T040505" });

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
