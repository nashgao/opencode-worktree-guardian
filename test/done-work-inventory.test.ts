import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { buildDoneWorkInventory } from "../src/done-work-inventory.ts";
import { completeDirtyCommitSafetyRefReservation } from "../src/state-dirty-commit-reservation.ts";
import { getGuardianPaths, readState, updateState } from "../src/state.ts";
import { guardianStart } from "../src/tools.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";
import { installFakeGh } from "./delete-fixtures.ts";

type LooseRecord = Record<string, unknown>;

type CleanSession = {
  readonly base: string;
  readonly repo: string;
  readonly worktree: string;
  readonly branch: string;
  readonly sessionId: string;
  readonly head: string;
};

const ownedRoots: string[] = [];

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(`${name} must be a non-empty string`);
}

test.after(async () => {
  const remaining = await Promise.all(ownedRoots.map(async (root) => fs.access(root).then(() => root, () => null)));
  assert.deepEqual(remaining.filter((root): root is string => root !== null), []);
});

async function createCleanSession(t: TestContext, sessionId: string, beforeStart?: (repo: string) => Promise<void>): Promise<CleanSession> {
  const { base, repo } = await createRepoWithOrigin();
  ownedRoots.push(base);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  if (beforeStart) await beforeStart(repo);
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: sessionId, createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  const branch = started.session.branch;
  await fs.writeFile(path.join(worktree, "feature.txt"), `${sessionId}\n`, "utf8");
  await git(worktree, ["add", "feature.txt"]);
  await git(worktree, ["commit", "-m", `add ${sessionId}`]);
  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  return { base, repo, worktree, branch, sessionId, head };
}

async function pathExists(target: string) {
  return fs.access(target).then(() => true, () => false);
}

async function commitInWorktree(worktree: string, commit: { readonly file: string; readonly content: string; readonly message: string }) {
  await fs.writeFile(path.join(worktree, commit.file), commit.content);
  await git(worktree, ["add", commit.file]);
  await git(worktree, ["commit", "-m", commit.message]);
}

async function createCompletionReservation(t: TestContext, sessionId: string) {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = requireRecord(await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: sessionId, createWorktree: true, config: DEFAULT_CONFIG }), "started");
  const startedSession = requireRecord(started.session, "started.session");
  const worktree = requireString(startedSession.worktree_path, "started.session.worktree_path");
  const branch = requireString(startedSession.branch, "started.session.branch");
  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  const reservation = {
    session_id: sessionId,
    branch,
    expected_head: head,
    safety_ref: `refs/opencode-guardian/${sessionId}/reservation`,
    confirm_token: `${sessionId}-confirm-token`,
    reserved_at: "2026-07-30T00:00:00.000Z",
  };
  await updateState(repo, DEFAULT_CONFIG, (state) => {
    const session = state.sessions[sessionId];
    if (!session) throw new Error("completion fixture session is missing");
    state.sessions[sessionId] = {
      ...session,
      head_commit: head,
      safety_refs: [reservation.safety_ref],
      dirty_commit_safety_ref_reservation: reservation,
    };
    return state;
  });
  return { repo, worktree, head, reservation };
}

test("guardian_done work inventory reports primary and active session dirt without selecting a lane", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const dirty = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_inventory_dirty", taskName: "inventory dirty", createWorktree: true, config: DEFAULT_CONFIG });
  const clean = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_inventory_clean", taskName: "inventory clean", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(repo, "primary-dirty.txt"), "primary\n", "utf8");
  await fs.writeFile(path.join(dirty.session.worktree_path, "session-dirty.txt"), "session\n", "utf8");

  const fromPrimary = await buildDoneWorkInventory({ repoRoot: repo, cwd: repo, config: DEFAULT_CONFIG });
  const fromSession = await buildDoneWorkInventory({ repoRoot: repo, cwd: dirty.session.worktree_path, config: DEFAULT_CONFIG });

  assert.equal(fromPrimary.repoRoot, repo);
  assert.equal(fromPrimary.currentWorktree, repo);
  assert.equal(fromSession.repoRoot, repo);
  assert.equal(fromSession.currentWorktree, dirty.session.worktree_path);
  assert.deepEqual(fromPrimary.primary.dirtyFiles, ["primary-dirty.txt"]);
  assert.deepEqual(fromSession.primary.dirtyFiles, ["primary-dirty.txt"]);
  assert.equal(fromPrimary.sessions.length, 2);
  assert.equal(fromPrimary.dirtyTargets.length, 2);

  const dirtySession = fromPrimary.sessions.find((session) => session.sessionId === "ses_inventory_dirty");
  const cleanSession = fromPrimary.sessions.find((session) => session.sessionId === "ses_inventory_clean");
  assert.ok(dirtySession);
  assert.ok(cleanSession);
  assert.equal(dirtySession.branch, dirty.session.branch);
  assert.deepEqual(dirtySession.dirtyFiles, ["session-dirty.txt"]);
  assert.equal(cleanSession.branch, clean.session.branch);
  assert.deepEqual(cleanSession.dirtyFiles, []);
});

test("guardian_done work inventory resolves symlinked worktree roots before filtering active sessions", { skip: process.platform === "win32" }, async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const aliasBase = path.join(path.dirname(base), `${path.basename(base)}-alias`);
  await fs.symlink(base, aliasBase, "dir");
  t.after(() => fs.rm(aliasBase, { recursive: true, force: true }));
  const aliasRepo = path.join(aliasBase, path.basename(repo));
  const config = {
    ...DEFAULT_CONFIG,
    worktreeRoot: path.join(aliasBase, "worktrees", "$REPO"),
  };
  const started = await guardianStart({
    repoRoot: aliasRepo,
    cwd: aliasRepo,
    sessionId: "ses_inventory_alias_dirty",
    taskName: "inventory alias dirty",
    createWorktree: true,
    config,
  });
  await fs.writeFile(path.join(started.session.worktree_path, "session-dirty.txt"), "session\n", "utf8");

  const inventory = await buildDoneWorkInventory({ repoRoot: aliasRepo, cwd: aliasRepo, config });

  assert.equal(inventory.sessions.length, 1);
  assert.equal(inventory.dirtyTargets.length, 1);
  assert.equal(inventory.dirtyTargets[0]?.targetKind, "session");
  assert.equal(inventory.dirtyTargets[0]?.sessionId, "ses_inventory_alias_dirty");
  assert.deepEqual(inventory.dirtyTargets[0]?.dirtyFiles, ["session-dirty.txt"]);
});

test("land-clean blocks when the remote base advances during PR review", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "base-advance-during-review";
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "base advance during review", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  const branch = started.session.branch;
  await commitInWorktree(worktree, { file: "feature.txt", content: "feature\n", message: "add feature" });
  await installFakeGh(t, { repo, branch, dynamicHead: true });
  const ghPath = path.join(String(process.env.PATH).split(path.delimiter)[0], "gh");
  const delegatePath = `${ghPath}-delegate`;
  await fs.rename(ghPath, delegatePath);
  await fs.writeFile(ghPath, `#!/bin/sh\nset -eu\nif [ "$1" = "pr" ] && [ "\${2:-}" = "view" ]; then printf 'advanced during PR review\\n' > ${JSON.stringify(path.join(repo, "base-advanced-during-review.txt"))}; git -C ${JSON.stringify(repo)} add base-advanced-during-review.txt; git -C ${JSON.stringify(repo)} commit -m 'advance base during PR review' >/dev/null; git -C ${JSON.stringify(repo)} push origin main >/dev/null; fi\nexec ${JSON.stringify(delegatePath)} "$@"\n`, "utf8");
  await fs.chmod(ghPath, 0o755);
  const request = { repoRoot: repo, cwd: worktree, sessionId, timestamp: "20260727T020202", config: DEFAULT_CONFIG };
  const plan = await guardianDone({ ...request, mode: "plan" }) as LooseRecord;

  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: plan.confirmToken }) as LooseRecord;

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(String(result.reason), /remote base advanced/);
  assert.equal(await pathExists(worktree), true);
  await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
});

test("clean sessions retain ignored consent, token, remote-base, and branch identity gates", async (t) => {
  const ignored = await createCleanSession(t, "clean-ignored-consent", async (repo) => {
    await fs.writeFile(path.join(repo, ".gitignore"), ".guardian-state/\n", "utf8");
    await git(repo, ["add", ".gitignore"]);
    await git(repo, ["commit", "-m", "ignore guardian state"]);
    await git(repo, ["push", "origin", "main"]);
  });
  await fs.mkdir(path.join(ignored.worktree, ".guardian-state"));
  await fs.writeFile(path.join(ignored.worktree, ".guardian-state", "state.json"), "{}\n", "utf8");
  const ignoredPlan = await guardianDone({ repoRoot: ignored.repo, cwd: ignored.worktree, sessionId: ignored.sessionId, mode: "plan", config: DEFAULT_CONFIG });
  assert.equal(ignoredPlan.ok, false, JSON.stringify(ignoredPlan));
  assert.match(String(ignoredPlan.reason), /ignored files/);

  const token = await createCleanSession(t, "clean-token-gate");
  const tokenGh = await installFakeGh(t, { repo: token.repo, branch: token.branch, head: token.head });
  const tokenPlan = await guardianDone({ repoRoot: token.repo, cwd: token.worktree, sessionId: token.sessionId, mode: "plan", config: DEFAULT_CONFIG });
  const staleToken = await guardianDone({ repoRoot: token.repo, cwd: token.worktree, sessionId: token.sessionId, mode: "apply", confirm: true, confirmToken: "stale", config: DEFAULT_CONFIG });
  assert.equal(staleToken.ok, false, JSON.stringify(staleToken));
  assert.match(String(staleToken.reason), /plan changed/);
  await assert.rejects(fs.access(tokenGh.logPath));
  assert.equal(tokenPlan.ok, true, JSON.stringify(tokenPlan));

  const base = await createCleanSession(t, "clean-remote-base-gate");
  const baseGh = await installFakeGh(t, { repo: base.repo, branch: base.branch, head: base.head });
  const basePlan = await guardianDone({ repoRoot: base.repo, cwd: base.worktree, sessionId: base.sessionId, mode: "plan", config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(base.repo, "advanced.txt"), "advanced\n", "utf8");
  await git(base.repo, ["add", "advanced.txt"]);
  await git(base.repo, ["commit", "-m", "advance base"]);
  await git(base.repo, ["push", "origin", "main"]);
  const advanced = await guardianDone({ repoRoot: base.repo, cwd: base.worktree, sessionId: base.sessionId, mode: "apply", confirm: true, confirmToken: basePlan.confirmToken, config: DEFAULT_CONFIG });
  assert.equal(advanced.ok, false, JSON.stringify(advanced));
  assert.match(String(advanced.reason), /plan changed/);
  await assert.rejects(fs.access(baseGh.logPath));

  const identity = await createCleanSession(t, "clean-branch-identity-gate");
  await git(identity.worktree, ["checkout", "--detach"]);
  const mismatch = await guardianDone({ repoRoot: identity.repo, cwd: identity.worktree, sessionId: identity.sessionId, mode: "plan", config: DEFAULT_CONFIG });
  assert.equal(mismatch.ok, false, JSON.stringify(mismatch));
  assert.match(String(mismatch.reason), /live worktree branch mismatch/);
});

test("completion refuses a terminal session that retains the exact reservation", async (t) => {
  const fixture = await createCompletionReservation(t, "terminal-reservation");
  await updateState(fixture.repo, DEFAULT_CONFIG, (state) => {
    const session = state.sessions[fixture.reservation.session_id];
    if (!session) throw new Error("completion fixture session is missing");
    state.sessions[fixture.reservation.session_id] = { ...session, status: "preserved" };
    return state;
  });

  await assert.rejects(
    () => completeDirtyCommitSafetyRefReservation(fixture.repo, DEFAULT_CONFIG, fixture.reservation, "new-head"),
    /changed before completion/,
  );

  const session = (await readState(await getGuardianPaths(fixture.repo), { repoRoot: fixture.repo, config: DEFAULT_CONFIG })).sessions[fixture.reservation.session_id];
  if (!session) throw new Error("completion fixture session is missing after rejection");
  assert.equal(session.head_commit, fixture.head);
  assert.deepEqual(session.dirty_commit_safety_ref_reservation, fixture.reservation);
});

test("completion refuses an active session rebound to a different branch", async (t) => {
  const fixture = await createCompletionReservation(t, "rebound-reservation");
  await git(fixture.worktree, ["checkout", "-b", "guardian/rebound"]);
  await updateState(fixture.repo, DEFAULT_CONFIG, (state) => {
    const session = state.sessions[fixture.reservation.session_id];
    if (!session) throw new Error("completion fixture session is missing");
    state.sessions[fixture.reservation.session_id] = { ...session, branch: "guardian/rebound" };
    return state;
  });

  await assert.rejects(
    () => completeDirtyCommitSafetyRefReservation(fixture.repo, DEFAULT_CONFIG, fixture.reservation, "new-head"),
    /changed before completion/,
  );

  const session = (await readState(await getGuardianPaths(fixture.repo), { repoRoot: fixture.repo, config: DEFAULT_CONFIG })).sessions[fixture.reservation.session_id];
  if (!session) throw new Error("completion fixture session is missing after rejection");
  assert.equal(session.head_commit, fixture.head);
  assert.deepEqual(session.dirty_commit_safety_ref_reservation, fixture.reservation);
});
