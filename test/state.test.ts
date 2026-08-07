import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { checkpointSession, getGuardianPaths, readState, recordSession, updateState, withStateTransaction, writeReportAtomic } from "../src/state.ts";
import { guardianStart } from "../src/start.ts";
import { createRepo, createRepoWithOrigin, git } from "./helpers.ts";

function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(`${name} must be a non-empty string`);
}

test("state is repo-local under .git/opencode-guardian and records events", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  assert.match(paths.statePath, /\.git\/opencode-guardian\/state\.json$/);
  assert.match(paths.eventsPath, /\.git\/opencode-guardian\/events\.jsonl$/);
  assert.match(paths.reportPath, /\.git\/opencode-guardian\/report\.html$/);
  assert.match(paths.lockPath, /\.git\/opencode-guardian\/state\.lock$/);
  assert.equal(paths.lockRef, "refs/opencode-guardian/locks/state");
  assert.match(paths.lockTmpDir, /\.git\/opencode-guardian\/lock-tmp$/);
  assert.match(paths.lockTombstonesDir, /\.git\/opencode-guardian\/lock-tombstones$/);

  const state = await recordSession(repo, DEFAULT_CONFIG, {
    session_id: "ses_state",
    status: "active",
    branch: "guardian/state",
    worktree_path: path.join(repo, ".worktrees", "state"),
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
  let releaseOwner: (() => void) | undefined;
  const ownerReady = new Promise<void>((resolve) => { releaseOwner = resolve; });
  let ownerAcquired: (() => void) | undefined;
  const acquired = new Promise<void>((resolve) => { ownerAcquired = resolve; });
  const owner = withStateTransaction(paths, async () => {
    ownerAcquired?.();
    await ownerReady;
  });
  await acquired;
  await assert.rejects(() => withStateTransaction(paths, async () => {}, { timeoutMs: 50 }), /Timed out acquiring/);
  releaseOwner?.();
  await owner;
});

test("state transactions reject nested acquisition instead of waiting", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  await withStateTransaction(paths, async () => {
    await assert.rejects(() => withStateTransaction(paths, async () => {}), /non-reentrant/);
  });
});

test("updateState cannot reacquire the lock from inside a public state transaction", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  await withStateTransaction(paths, async () => {
    await assert.rejects(() => updateState(repo, DEFAULT_CONFIG, (state) => state, { paths }), /non-reentrant/);
  });
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

test("recordSession does not persist state when event recording is refused", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  await fs.mkdir(paths.dir, { recursive: true });
  const target = `${paths.eventsPath}.target`;
  await fs.writeFile(target, "");
  await fs.symlink(target, paths.eventsPath);

  await assert.rejects(() => recordSession(repo, DEFAULT_CONFIG, {
    session_id: "ses_atomic",
    status: "active",
    branch: "guardian/atomic",
    worktree_path: path.join(repo, ".worktrees", "atomic"),
    base_ref: "origin/main",
    safety_refs: [],
  }), /events symlink/);

  const state = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(state.sessions.ses_atomic, undefined);
});

test("report writes are atomic and refuse symlinks", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  await writeReportAtomic(paths, "<html></html>\n");
  assert.equal(await fs.readFile(paths.reportPath, "utf8"), "<html></html>\n");

  await fs.rm(paths.reportPath);
  const target = `${paths.reportPath}.target`;
  await fs.writeFile(target, "target");
  await fs.symlink(target, paths.reportPath);
  await assert.rejects(() => writeReportAtomic(paths, "<html></html>\n"), /report symlink/);
});

test("concurrent state updates serialize and events remain jsonl", async () => {
  const repo = await createRepo();
  await Promise.all(Array.from({ length: 5 }, (_, index) => recordSession(repo, DEFAULT_CONFIG, {
    session_id: `ses_concurrent_${index}`,
    status: "active",
    branch: `guardian/concurrent-${index}`,
    worktree_path: path.join(repo, ".worktrees", `concurrent-${index}`),
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

test("recordSession refuses an active session whose worktree is a different git repository", async () => {
  const repo = await createRepo();
  const foreign = await createRepo();
  await assert.rejects(() => recordSession(repo, DEFAULT_CONFIG, {
    session_id: "ses_xrepo",
    status: "active",
    branch: "guardian/xrepo",
    worktree_path: foreign,
    base_ref: "origin/main",
    safety_refs: [],
  }), /different git repository/);
  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(state.sessions.ses_xrepo, undefined);
});

test("recordSession rejects a symlink spelling of the primary worktree", { skip: process.platform === "win32" }, async () => {
  const repo = await createRepo();
  const primaryAlias = path.join(path.dirname(repo), `${path.basename(repo)}-primary-alias`);
  await fs.symlink(repo, primaryAlias, "dir");

  await assert.rejects(() => recordSession(repo, DEFAULT_CONFIG, {
    session_id: "ses_primary_alias",
    status: "active",
    branch: "guardian/primary-alias",
    worktree_path: primaryAlias,
    base_ref: "origin/main",
    safety_refs: [],
  }), /primary repository worktree/);
});

test("checkpointSession accepts an alias-equivalent recorded worktree", { skip: process.platform === "win32" }, async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_checkpoint_alias", taskName: "checkpoint alias", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = requireString(started.session.worktree_path, "started.session.worktree_path");
  const worktreeAlias = path.join(base, "checkpoint-worktree-alias");
  await fs.symlink(worktree, worktreeAlias, "dir");
  const expectedHead = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  await updateState(repo, DEFAULT_CONFIG, (state) => {
    const session = state.sessions.ses_checkpoint_alias;
    if (!session) throw new Error("checkpoint alias fixture session is missing");
    state.sessions.ses_checkpoint_alias = { ...session, head_commit: "stale" };
    return state;
  });

  await checkpointSession(repo, DEFAULT_CONFIG, "ses_checkpoint_alias", { expectedWorktreePath: worktreeAlias });

  const session = (await readState(await getGuardianPaths(repo), { repoRoot: repo, config: DEFAULT_CONFIG })).sessions.ses_checkpoint_alias;
  assert.equal(session?.head_commit, expectedHead);
});

test("recordSession supersedes an active session with an alias-equivalent worktree", { skip: process.platform === "win32" }, async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_superseded_alias", taskName: "superseded alias", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = requireString(started.session.worktree_path, "started.session.worktree_path");
  const worktreeAlias = path.join(base, "superseded-worktree-alias");
  await fs.symlink(worktree, worktreeAlias, "dir");

  await recordSession(repo, DEFAULT_CONFIG, {
    session_id: "ses_alias_replacement",
    status: "active",
    branch: requireString(started.session.branch, "started.session.branch"),
    worktree_path: worktreeAlias,
    base_ref: "origin/main",
    safety_refs: [],
  });

  const state = await readState(await getGuardianPaths(repo), { repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(state.sessions.ses_superseded_alias?.status, "superseded");
  assert.equal(state.sessions.ses_superseded_alias?.superseded_by, "ses_alias_replacement");
});
