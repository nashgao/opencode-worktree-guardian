import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { guardianStart } from "../src/start.ts";
import { getGuardianPaths, readState, recordSession } from "../src/state.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";
import { installFakeGh } from "./delete-fixtures.ts";

type AlreadyLandedDirtyFixture = {
  readonly base: string;
  readonly repo: string;
  readonly branch: string;
  readonly worktree: string;
  readonly head: string;
  readonly featureFile: string;
  readonly remoteMain: string;
};

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(`${name} must be a non-empty string`);
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  return git(repo, ["rev-parse", "--verify", branch]).then(() => true, () => false);
}

async function guardianRefNames(repo: string): Promise<readonly string[]> {
  const { stdout } = await git(repo, ["for-each-ref", "--format=%(refname)", "refs/opencode-guardian"]);
  return stdout.length === 0 ? [] : stdout.split("\n");
}

async function createAdvisoryStash(repo: string, name: string): Promise<void> {
  await fs.writeFile(path.join(repo, name), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", name]);
}

async function makeAlreadyLandedDirtySession(options: { readonly sessionId: string; readonly finalWorktreeContent: string }): Promise<AlreadyLandedDirtyFixture> {
  const { base, repo } = await createRepoWithOrigin();
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: options.sessionId, taskName: "done redundant dirty", createWorktree: true, config: DEFAULT_CONFIG });
  const session = requireRecord(started.session, "started.session");
  const branch = requireString(session.branch, "started.session.branch");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const featureFile = "redundant-dirty.txt";
  await fs.writeFile(path.join(worktree, featureFile), "landed content\n");
  await git(worktree, ["add", featureFile]);
  await git(worktree, ["commit", "-m", "add redundant dirty fixture"]);
  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  await git(repo, ["merge", "--no-ff", branch, "-m", "merge redundant dirty fixture"]);
  await git(repo, ["push", "origin", "main"]);
  await fs.writeFile(path.join(repo, featureFile), "advanced base content\n");
  await git(repo, ["add", featureFile]);
  await git(repo, ["commit", "-m", "advance redundant dirty base"]);
  await git(repo, ["push", "origin", "main"]);
  await fs.writeFile(path.join(worktree, featureFile), options.finalWorktreeContent);
  const remoteMain = (await git(repo, ["rev-parse", "origin/main"])).stdout;
  return { base, repo, branch, worktree, head, featureFile, remoteMain };
}

test("guardian_done apply cleans already-landed redundant dirty sessions without creating a PR", async (t) => {
  const fixture = await makeAlreadyLandedDirtySession({ sessionId: "ses_done_apply_redundant_dirty", finalWorktreeContent: "advanced base content\n" });
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  await createAdvisoryStash(fixture.repo, "already-landed-redundant-stash");
  const plan = await guardianDone({ repoRoot: fixture.repo, cwd: fixture.repo, mode: "plan", timestamp: "20260609T080808", config: DEFAULT_CONFIG });
  const planRecord = requireRecord(plan, "plan");

  const apply = await guardianDone({ repoRoot: fixture.repo, cwd: fixture.repo, mode: "apply", confirm: true, confirmToken: requireString(planRecord.confirmToken, "plan.confirmToken"), timestamp: "20260609T080808", config: DEFAULT_CONFIG });
  const applyRecord = requireRecord(apply, "apply");

  assert.equal(planRecord.action, "already-landed-clean");
  assert.equal(planRecord.stashCount, 1);
  assert.equal(Array.isArray(planRecord.stashes) ? planRecord.stashes.length : 0, 1);
  assert.equal(applyRecord.ok, true, JSON.stringify(applyRecord));
  assert.equal(applyRecord.status, "already-landed-and-cleaned");
  assert.equal(applyRecord.action, "already-landed-clean");
  assert.equal(applyRecord.branch, fixture.branch);
  assert.equal(applyRecord.head, fixture.head);
  assert.equal(applyRecord.stashCount, 1);
  assert.equal(Array.isArray(applyRecord.stashes) ? applyRecord.stashes.length : 0, 1);
  assert.deepEqual(applyRecord.dirtyFiles, [fixture.featureFile]);
  assert.equal(applyRecord.worktreeRemoved, true);
  assert.equal(applyRecord.branchDeleted, true);
  assert.equal(await pathExists(fixture.worktree), false);
  assert.equal(await branchExists(fixture.repo, fixture.branch), false);
  assert.equal((await git(fixture.repo, ["rev-parse", "origin/main"])).stdout, fixture.remoteMain);
  const cleanup = requireRecord(applyRecord.cleanup, "apply.cleanup");
  const safetyRef = requireString(cleanup.safetyRef, "apply.cleanup.safetyRef");
  const dirtySnapshotRef = requireString(cleanup.dirtySnapshotRef, "apply.cleanup.dirtySnapshotRef");
  const refs = await guardianRefNames(fixture.repo);
  assert.ok(refs.includes(safetyRef));
  assert.ok(refs.includes(dirtySnapshotRef));
  assert.equal(cleanup.dirtySnapshotFileCount, 1);
  assert.deepEqual(cleanup.dirtySnapshotFiles, [fixture.featureFile]);
});

test("guardian_done plans redundant dirty cleanup when ignored-file consent is explicit", async (t) => {
  const fixture = await makeAlreadyLandedDirtySession({ sessionId: "ses_done_redundant_ignored", finalWorktreeContent: "advanced base content\n" }); t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const excludesFile = path.join(fixture.base, "ignored-files"); await fs.writeFile(excludesFile, ".claude/\n", "utf8"); await git(fixture.worktree, ["config", "core.excludesfile", excludesFile]);
  await fs.mkdir(path.join(fixture.worktree, ".claude"), { recursive: true }); await fs.writeFile(path.join(fixture.worktree, ".claude", "session.log"), "ignored\n", "utf8");
  const plan = requireRecord(await guardianDone({ repoRoot: fixture.repo, cwd: fixture.repo, mode: "plan", allowIgnoredFiles: true, timestamp: "20260609T081818", config: DEFAULT_CONFIG }), "plan");
  assert.equal(plan.ok, true, JSON.stringify(plan)); assert.equal(plan.status, "planned"); assert.equal(plan.action, "already-landed-clean"); assert.equal(typeof plan.confirmToken, "string");
  assert.equal(await pathExists(fixture.worktree), true); assert.equal(await branchExists(fixture.repo, fixture.branch), true);
});

test("guardian_done preserves already-landed sessions with non-redundant dirty work", async (t) => {
  const fixture = await makeAlreadyLandedDirtySession({ sessionId: "ses_done_keep_unique_dirty", finalWorktreeContent: "unique user work\n" });
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  await createAdvisoryStash(fixture.repo, "non-redundant-dirty-stash");

  const result = await guardianDone({ repoRoot: fixture.repo, cwd: fixture.repo, mode: "plan", timestamp: "20260609T090909", config: DEFAULT_CONFIG });
  const resultRecord = requireRecord(result, "result");

  assert.equal(resultRecord.ok, false);
  assert.equal(resultRecord.status, "blocked");
  assert.match(requireString(resultRecord.reason, "result.reason"), /could not be proven redundant/);
  assert.equal(resultRecord.branch, fixture.branch);
  assert.equal(resultRecord.stashCount, 1);
  assert.equal(Array.isArray(resultRecord.stashes) ? resultRecord.stashes.length : 0, 1);
  assert.deepEqual(resultRecord.dirtyFiles, [fixture.featureFile]);
  assert.equal(await pathExists(fixture.worktree), true);
  assert.equal(await branchExists(fixture.repo, fixture.branch), true);
  assert.equal((await git(fixture.repo, ["rev-parse", "origin/main"])).stdout, fixture.remoteMain);
  assert.deepEqual(await guardianRefNames(fixture.repo), []);
});

test("guardian_done rejects already-landed cleanup without confirmation before preflight", async (t) => {
  const fixture = await makeAlreadyLandedDirtySession({ sessionId: "ses_done_already_landed_no_confirm", finalWorktreeContent: "advanced base content\n" });
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  await createAdvisoryStash(fixture.repo, "already-landed-no-confirm-stash");

  const result = requireRecord(await guardianDone({ repoRoot: fixture.repo, cwd: fixture.repo, mode: "apply", timestamp: "20260609T091010", config: DEFAULT_CONFIG }), "result");

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(requireString(result.reason, "result.reason"), /confirm=true/);
  assert.equal(result.confirmationRequired, true);
  assert.equal(result.tokenChecked, false);
});

test("guardian_done retains advisory stash inventory when dirty work needs a commit message", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "land-clean-stash-no-message";
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "stash no message", createWorktree: true, config: DEFAULT_CONFIG });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  await fs.writeFile(path.join(worktree, "dirty.txt"), "needs a message\n");
  await createAdvisoryStash(repo, "missing-message-stash");

  const result = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "plan", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(String(result.reason), /commitMessage/);
  assert.equal(result.stashCount, 1);
  assert.equal(Array.isArray(result.stashes) ? result.stashes.length : 0, 1);
});

test("guardian_done rejects ordinary cleanup without confirmation before preflight", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "land-clean-stash-no-confirm";
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "stash no confirm", createWorktree: true, config: DEFAULT_CONFIG });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  await createAdvisoryStash(repo, "ordinary-no-confirm-stash");

  const result = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "apply", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(String(result.reason), /confirm=true/);
  assert.equal(result.confirmationRequired, true);
  assert.equal(result.tokenChecked, false);
});

test("guardian_done proves redundant dirty work against current remote base, not stale session base_ref", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "ses_done_stale_base_ref_dirty";
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "done stale base ref dirty", createWorktree: true, config: DEFAULT_CONFIG });
  const session = requireRecord(started.session, "started.session");
  const branch = requireString(session.branch, "started.session.branch");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const featureFile = "stale-base-ref-dirty.txt";
  await fs.writeFile(path.join(worktree, featureFile), "landed content\n");
  await git(worktree, ["add", featureFile]);
  await git(worktree, ["commit", "-m", "add stale base ref dirty fixture"]);
  await git(repo, ["merge", "--no-ff", branch, "-m", "merge stale base ref dirty fixture"]);
  await git(repo, ["checkout", "-b", "stale-base-ref-proof-base"]);
  await fs.writeFile(path.join(repo, featureFile), "stale proof base content\n");
  await git(repo, ["add", featureFile]);
  await git(repo, ["commit", "-m", "advance stale proof base"]);
  await git(repo, ["checkout", "main"]);
  await git(repo, ["push", "origin", "main"]);
  await fs.writeFile(path.join(repo, featureFile), "advanced base content\n");
  await git(repo, ["add", featureFile]);
  await git(repo, ["commit", "-m", "advance current base away from stale proof"]);
  await git(repo, ["push", "origin", "main"]);
  await fs.writeFile(path.join(worktree, featureFile), "stale proof base content\n");
  await recordSession(repo, DEFAULT_CONFIG, {
    ...session,
    session_id: sessionId,
    status: "active",
    branch,
    worktree_path: worktree,
    base_ref: "stale-base-ref-proof-base",
  });

  const result = await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", timestamp: "20260609T100101", config: DEFAULT_CONFIG });
  const resultRecord = requireRecord(result, "result");

  assert.equal(resultRecord.ok, false);
  assert.equal(resultRecord.status, "blocked");
  assert.match(requireString(resultRecord.reason, "result.reason"), /could not be proven redundant/);
  assert.equal(resultRecord.branch, branch);
  assert.deepEqual(resultRecord.dirtyFiles, [featureFile]);
  const cleanup = requireRecord(resultRecord.cleanup, "result.cleanup");
  const preflight = requireRecord(cleanup.preflight, "result.cleanup.preflight");
  assert.equal(preflight.baseRef, "origin/main");
  assert.notEqual(preflight.baseRef, "stale-base-ref-proof-base");
  assert.equal(await pathExists(worktree), true);
  assert.equal(await branchExists(repo, branch), true);
  assert.deepEqual(await guardianRefNames(repo), []);
});

test("guardian_done reports recovery without publication when reservation persistence fails", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "reservation-state-failure";
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: sessionId, createWorktree: true, config: DEFAULT_CONFIG });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");
  await fs.writeFile(path.join(worktree, "feature.txt"), "feature\n", "utf8");
  await installFakeGh(t, { repo, branch, dynamicHead: true });
  const request = { repoRoot: repo, cwd: worktree, sessionId, commitMessage: "feat: reserve safety ref", timestamp: "2026-07-29T05:00:00.000Z", config: DEFAULT_CONFIG };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");
  const oldHead = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  const sourceIndexTree = (await git(worktree, ["write-tree"])).stdout;
  const safetyRef = requireString(plan.safetyRef, "plan.safetyRef");
  const paths = await getGuardianPaths(repo);
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.rm(paths.eventsPath, { force: true });
  await fs.writeFile(`${paths.eventsPath}.target`, "", "utf8");
  await fs.symlink(`${paths.eventsPath}.target`, paths.eventsPath);

  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });
  const state = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "partial");
  assert.equal(result.recoveryRequired, true);
  assert.equal(requireString(result.safetyRef, "result.safetyRef"), safetyRef);
  assert.equal((await git(repo, ["rev-parse", safetyRef])).stdout, oldHead);
  assert.equal((await git(worktree, ["rev-parse", "HEAD"])).stdout, oldHead);
  assert.equal((await git(worktree, ["write-tree"])).stdout, sourceIndexTree);
  const stateSession = requireRecord(state.sessions[sessionId], "session");
  assert.equal(stateSession.dirty_commit_safety_ref_reservation, undefined);
  assert.deepEqual(stateSession.safety_refs, []);
});
