import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { acquireStateLock, getGuardianPaths, readState, recordSession } from "../src/state.ts";
import { createRepo } from "./helpers.ts";

test("state is repo-local under .git/opencode-guardian and records events", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  assert.match(paths.statePath, /\.git\/opencode-guardian\/state\.json$/);
  assert.match(paths.eventsPath, /\.git\/opencode-guardian\/events\.jsonl$/);
  assert.match(paths.lockPath, /\.git\/opencode-guardian\/state\.lock$/);

  const state = await recordSession(repo, DEFAULT_CONFIG, {
    session_id: "ses_state",
    status: "active",
    branch: "guardian/state",
    worktree_path: repo,
    base_ref: "origin/main",
    safety_refs: [],
  });

  assert.equal(state.state_version, 1);
  assert.equal(state.sessions.ses_state.state_version, 1);
  const persisted = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(persisted.sessions.ses_state.branch, "guardian/state");
  const events = await fs.readFile(paths.eventsPath, "utf8");
  assert.match(events, /session_recorded/);
});

test("state lock times out instead of guessing", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  const release = await acquireStateLock(paths, { timeoutMs: 100 });
  await assert.rejects(() => acquireStateLock(paths, { timeoutMs: 50 }), /Timed out acquiring/);
  await release();
});

test("malformed state fails closed", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(paths.statePath, JSON.stringify({ schema_version: "1.0.0", state_version: "bad", sessions: [] }));
  await assert.rejects(() => readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG }), /Invalid guardian state/);
});

test("state and event symlinks are refused", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  await fs.mkdir(paths.dir, { recursive: true });
  const target = `${paths.statePath}.target`;
  await fs.writeFile(target, "{}");
  await fs.symlink(target, paths.statePath);
  await assert.rejects(() => readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG }), /symlink/);
});

test("concurrent state updates serialize and events remain jsonl", async () => {
  const repo = await createRepo();
  await Promise.all(Array.from({ length: 5 }, (_, index) => recordSession(repo, DEFAULT_CONFIG, {
    session_id: `ses_concurrent_${index}`,
    status: "active",
    branch: `guardian/concurrent-${index}`,
    worktree_path: repo,
    base_ref: "origin/main",
    safety_refs: [],
  })));
  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(Object.keys(state.sessions).length, 5);
  const events = (await fs.readFile(paths.eventsPath, "utf8")).trim().split("\n");
  assert.equal(events.length, 5);
  for (const line of events) assert.doesNotThrow(() => JSON.parse(line));
});
