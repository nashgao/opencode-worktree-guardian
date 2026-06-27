import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import plugin from "../src/index.ts";
import { getGuardianPaths, readState, recordSession } from "../src/state.ts";
import type { GuardianSession } from "../src/types.ts";
import { createRepoWithOrigin, git, seedSession } from "./helpers.ts";

type LooseRecord = Record<string, unknown>;

function isLooseRecord(value: unknown): value is LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordValue(value: unknown): LooseRecord {
  if (!isLooseRecord(value)) throw new TypeError("expected record");
  return value;
}

function createClient(records: Array<LooseRecord>) {
  return {
    app: {
      async log(event: { readonly body: LooseRecord }) {
        records.push(event.body);
      },
    },
  };
}

function requireSession(session: GuardianSession | undefined): GuardianSession {
  assert.ok(session);
  return session;
}

function findSession(sessions: readonly GuardianSession[], sessionId: string): GuardianSession {
  return requireSession(sessions.find((session) => session.session_id === sessionId));
}

async function enableLazyAutoStart(repo: string) {
  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({ autoStartMode: "lazy" }));
  await git(repo, ["add", ".opencode/worktree-guardian.json"]);
  await git(repo, ["commit", "-m", "enable lazy guardian auto start"]);
}

test("session idle auto-finish uses default create-pr mode when repo opts in", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { guardianStatus } = await import("../src/recover.ts");
  const { repo } = await createRepoWithOrigin();
  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({ autoFinish: true }));
  const { git } = await import("./helpers.ts");
  await git(repo, ["add", ".opencode/worktree-guardian.json"]);
  await git(repo, ["commit", "-m", "add guardian config"]);
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_idle_finish", taskName: "idle finish", createWorktree: true, config: { ...DEFAULT_CONFIG, autoFinish: true } });
  await fs.writeFile(path.join(started.session.worktree_path, "feature.txt"), "idle finish\n");
  await git(started.session.worktree_path, ["add", "feature.txt"]);
  await git(started.session.worktree_path, ["commit", "-m", "add idle finish"]);
  const records: Array<LooseRecord> = [];
  const hooks = await plugin.server({ client: { app: { async log(event: { readonly body: LooseRecord }) { records.push(event.body); } } }, directory: repo, worktree: repo });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_idle_finish" } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_idle_finish" } } });
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(findSession(status.sessions, "ses_idle_finish").status, "preserved");
  assert.equal(records.filter((record: LooseRecord) => record.message === "event").length, 1);
});

test("session idle auto-finish retries after failed finish", async (t) => {
  const path = await import("node:path");
  const { git } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { guardianStatus } = await import("../src/recover.ts");
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({ autoFinish: true }));
  await git(repo, ["add", ".opencode/worktree-guardian.json"]);
  await git(repo, ["commit", "-m", "enable guardian auto finish"]);

  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_idle_retry_finish", taskName: "idle retry", createWorktree: true, config: { ...DEFAULT_CONFIG, autoFinish: true } });
  await fs.writeFile(path.join(started.session.worktree_path, "feature.txt"), "idle retry\n");
  await git(started.session.worktree_path, ["add", "feature.txt"]);
  await git(started.session.worktree_path, ["commit", "-m", "add idle retry"]);
  const dirtyPath = path.join(started.session.worktree_path, "dirty.txt");
  await fs.writeFile(dirtyPath, "dirty\n");

  const records: Array<LooseRecord> = [];
  const hooks = await plugin.server({ client: createClient(records), directory: repo, worktree: repo });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_idle_retry_finish" } } });

  const firstEvents = records.filter((record) => record.message === "event");
  assert.equal(firstEvents.length, 1);
  const firstAutoFinish = recordValue(firstEvents[0].autoFinish);
  assert.equal(firstAutoFinish.ok, false);
  assert.match(String(firstAutoFinish.reason), /uncommitted changes|dirty/i);
  let status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(findSession(status.sessions, "ses_idle_retry_finish").status, "active");

  await fs.rm(dirtyPath);
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_idle_retry_finish" } } });

  const events = records.filter((record) => record.message === "event");
  assert.equal(events.length, 2);
  const secondAutoFinish = recordValue(events[1].autoFinish);
  assert.equal(secondAutoFinish.ok, true);
  assert.equal(secondAutoFinish.status, "pr-suggested");
  status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(findSession(status.sessions, "ses_idle_retry_finish").status, "preserved");
});

test("session idle auto-finish blocks poisoned primary protected ownership with repair guidance", async (t) => {
  const path = await import("node:path");
  const { git } = await import("./helpers.ts");
  const { guardianStatus } = await import("../src/recover.ts");
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({ autoFinish: true }));
  await git(repo, ["add", ".opencode/worktree-guardian.json"]);
  await git(repo, ["commit", "-m", "enable guardian auto finish"]);
  const { stdout: commit } = await git(repo, ["rev-parse", "HEAD"]);
  await seedSession(repo, {
    session_id: "ses_idle_poisoned_finish",
    status: "active",
    branch: "main",
    worktree_path: repo,
    base_ref: "origin/main",
    head_commit: commit,
    safety_refs: [],
  });

  const records: Array<LooseRecord> = [];
  const hooks = await plugin.server({ client: createClient(records), directory: repo, worktree: repo });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_idle_poisoned_finish" } } });

  const events = records.filter((record) => record.message === "event");
  assert.equal(events.length, 1);
  const autoFinish = recordValue(events[0].autoFinish);
  assert.equal(autoFinish.ok, false);
  assert.equal(autoFinish.status, "blocked");
  assert.match(String(autoFinish.reason), /createWorktree=true/);
  assert.equal(autoFinish.suggestedCommand, "guardian_start createWorktree=true");
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(findSession(status.sessions, "ses_idle_poisoned_finish").status, "active");
  assert.equal(status.poisonedSessions.some((session: LooseRecord) => session.session_id === "ses_idle_poisoned_finish"), true);
});


test("session idle auto-finish uses the recorded worktree when host context is repo root", async (t) => {
  const path = await import("node:path");
  const { guardianStart } = await import("../src/tools.ts");
  const { guardianStatus } = await import("../src/recover.ts");
  const { git } = await import("./helpers.ts");
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({ autoFinish: true }));
  await git(repo, ["add", ".opencode/worktree-guardian.json"]);
  await git(repo, ["commit", "-m", "enable guardian auto finish"]);

  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_idle_recorded_worktree", taskName: "idle recorded worktree", createWorktree: true, config: { ...DEFAULT_CONFIG, autoFinish: true } });
  const records: Array<LooseRecord> = [];
  const hooks = await plugin.server({ client: createClient(records), directory: repo, worktree: repo });

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_idle_recorded_worktree" } } });

  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const session = findSession(status.sessions, "ses_idle_recorded_worktree");
  assert.equal(session.status, "preserved");
  assert.equal(session.worktree_path, started.session.worktree_path);
  assert.equal(records.filter((record) => record.message === "event").length, 1);
});
