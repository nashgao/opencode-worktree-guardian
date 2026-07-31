import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { routeDirectFileMutation } from "../src/plugin/direct-file-routing.ts";
import { guardianStart } from "../src/tools.ts";
import type { GuardCommandPayload, SessionWorktreeResult } from "../src/types.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

const repoRoot = "/repo";

type DoneResult = Record<string, unknown> & {
  readonly action?: string;
  readonly availableSessions?: readonly { readonly branch: string }[];
  readonly branch?: string;
  readonly confirmToken?: string;
  readonly dirtyFiles?: readonly string[];
  readonly lane?: string;
  readonly reason?: string;
  readonly sessions?: readonly { readonly branch: string }[];
  readonly status?: string;
  readonly summary?: unknown;
  readonly worktreePath?: string;
};

function asDone(result: Record<string, unknown>): DoneResult {
  return result as DoneResult;
}

function writeInput(): GuardCommandPayload {
  return { tool: "write", args: { filePath: "/repo/src/foo.ts" } };
}

async function createRoutingFixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-direct-routing-"));
  const repoRoot = path.join(base, "repo");
  const expectedWorktree = path.join(base, "session");
  const outside = path.join(base, "outside");
  await Promise.all([fs.mkdir(repoRoot), fs.mkdir(expectedWorktree), fs.mkdir(outside)]);
  return { base, repoRoot, expectedWorktree, outside };
}

test("terminal session no longer fail-closes direct file edits", async () => {
  const sessionWorktree: SessionWorktreeResult = { ok: true, sessionId: "ses_terminal", expectedWorktree: null, actualWorktree: repoRoot, matches: true, terminal: true };
  const result = await routeDirectFileMutation(writeInput(), {}, sessionWorktree, repoRoot, repoRoot, new Map());
  assert.equal(result.blocked, false);
  assert.equal(result.routed, false);
});

test("non-terminal session with an unresolvable worktree still fail-closes", async () => {
  const sessionWorktree: SessionWorktreeResult = { ok: true, sessionId: "ses_active", expectedWorktree: null, actualWorktree: repoRoot, matches: true };
  const result = await routeDirectFileMutation(writeInput(), {}, sessionWorktree, repoRoot, repoRoot, new Map());
  assert.equal(result.blocked, true);
});

test("no recorded session allows direct file edits", async () => {
  const sessionWorktree: SessionWorktreeResult = { ok: true, sessionId: null, expectedWorktree: null, actualWorktree: repoRoot, matches: true };
  const result = await routeDirectFileMutation(writeInput(), {}, sessionWorktree, repoRoot, repoRoot, new Map());
  assert.equal(result.blocked, false);
});

test("routes relative recognized file arguments from the execution cwd", async () => {
  const output: GuardCommandPayload = { args: { filePath: "src/feature.ts" } };
  const sessionWorktree: SessionWorktreeResult = { ok: true, sessionId: "ses_active", expectedWorktree: "/repo/.worktrees/session", actualWorktree: repoRoot, matches: false };

  const result = await routeDirectFileMutation({ tool: "write" }, output, sessionWorktree, repoRoot, repoRoot, new Map());

  assert.equal(result.routed, true);
  assert.equal(output.args?.filePath, "/repo/.worktrees/session/src/feature.ts");
});

test("routes a missing target below real in-repo directories to the canonical worktree destination", async (t) => {
  const { base, repoRoot, expectedWorktree } = await createRoutingFixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await Promise.all([fs.mkdir(path.join(repoRoot, "src")), fs.mkdir(path.join(expectedWorktree, "src"))]);
  const linkedWorktree = path.join(base, "linked-session");
  await fs.symlink(expectedWorktree, linkedWorktree);
  const output: GuardCommandPayload = { args: { filePath: "src/missing-target.txt" } };
  const sessionWorktree: SessionWorktreeResult = { ok: true, sessionId: "ses_canonical_destination", expectedWorktree: linkedWorktree, actualWorktree: repoRoot, matches: false };

  const result = await routeDirectFileMutation({ tool: "write" }, output, sessionWorktree, repoRoot, repoRoot, new Map());

  assert.equal(result.routed, true);
  assert.equal(result.blocked, false);
  assert.equal(output.args?.filePath, path.join(await fs.realpath(expectedWorktree), "src", "missing-target.txt"));
});

test("routes a lexical outside symlink whose canonical target is inside the repository", async (t) => {
  const { base, repoRoot, expectedWorktree, outside } = await createRoutingFixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await Promise.all([
    fs.mkdir(path.join(repoRoot, "src")),
    fs.mkdir(path.join(expectedWorktree, "src")),
  ]);
  await fs.writeFile(path.join(repoRoot, "src", "linked-target.ts"), "export {};\n");
  const externalSymlink = path.join(outside, "linked-target.ts");
  await fs.symlink(path.join(repoRoot, "src", "linked-target.ts"), externalSymlink);
  const output: GuardCommandPayload = { args: { filePath: externalSymlink } };
  const sessionWorktree: SessionWorktreeResult = { ok: true, sessionId: "ses_lexical_outside", expectedWorktree, actualWorktree: repoRoot, matches: false };

  const result = await routeDirectFileMutation({ tool: "write" }, output, sessionWorktree, repoRoot, repoRoot, new Map());

  assert.equal(result.routed, true);
  assert.equal(result.blocked, false);
  assert.equal(output.args?.filePath, path.join(await fs.realpath(expectedWorktree), "src", "linked-target.ts"));
});

test("blocks a relative missing target whose repo ancestor is a symlink escape", async (t) => {
  const { base, repoRoot, expectedWorktree, outside } = await createRoutingFixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(repoRoot, "escape"));
  const output: GuardCommandPayload = { args: { filePath: "escape/missing-target.txt" } };
  const sessionWorktree: SessionWorktreeResult = { ok: true, sessionId: "ses_repo_escape", expectedWorktree, actualWorktree: repoRoot, matches: false };

  const result = await routeDirectFileMutation({ tool: "write" }, output, sessionWorktree, repoRoot, repoRoot, new Map());

  assert.equal(result.blocked, true);
  assert.equal(result.routed, false);
  assert.equal(output.args?.filePath, "escape/missing-target.txt");
});

test("blocks an absolute missing target whose routed worktree ancestor is a symlink escape", async (t) => {
  const { base, repoRoot, expectedWorktree, outside } = await createRoutingFixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await Promise.all([fs.mkdir(path.join(repoRoot, "escape")), fs.symlink(outside, path.join(expectedWorktree, "escape"))]);
  const target = path.join(repoRoot, "escape", "missing-target.txt");
  const output: GuardCommandPayload = { args: { filePath: target } };
  const sessionWorktree: SessionWorktreeResult = { ok: true, sessionId: "ses_worktree_escape", expectedWorktree, actualWorktree: repoRoot, matches: false };

  const result = await routeDirectFileMutation({ tool: "write" }, output, sessionWorktree, repoRoot, repoRoot, new Map());

  assert.equal(result.blocked, true);
  assert.equal(result.routed, false);
  assert.equal(output.args?.filePath, target);
});

test("guardian_done previews land-and-clean for recorded session worktrees", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_session", taskName: "done session", createWorktree: true, config: DEFAULT_CONFIG });

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: "ses_done_session", timestamp: "20260609T010101" }));

  assert.equal(result.ok, true);
  assert.equal(result.lane, "session-finish");
  assert.equal(result.status, "planned");
  assert.equal(result.action, "land-and-clean");
  assert.equal(result.worktreePath, started.session.worktree_path);
  assert.equal(result.nextAction, "guardian_done mode=apply confirm=true");
});

test("guardian_done previews the active session from primary cwd when primary is clean", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_primary_cwd", taskName: "done primary cwd", createWorktree: true, config: DEFAULT_CONFIG });

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, sessionId: "ses_done_primary_cwd", timestamp: "20260609T020202" }));

  assert.equal(result.ok, true);
  assert.equal(result.lane, "session-finish");
  assert.equal(result.status, "planned");
  assert.equal(result.action, "land-and-clean");
  assert.equal(result.worktreePath, started.session.worktree_path);
});

test("guardian_done blocks a dirty active session without commitMessage", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_active_dirty", taskName: "done active dirty", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  await fs.writeFile(path.join(worktree, "README.md"), "dirty tracked change\n");

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: worktree, sessionId: "ses_done_active_dirty" }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.lane, "session-finish");
  assert.match(String(result.reason), /commitMessage/);
});

test("guardian_done previews a session targeted by branch name from the primary", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_branch_target", taskName: "branch target", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(started.session.worktree_path, "feat.txt"), "feat\n");
  await git(started.session.worktree_path, ["add", "feat.txt"]);
  await git(started.session.worktree_path, ["commit", "-m", "feat"]);

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, branch: started.session.branch, timestamp: "20260609T050505" }));

  assert.equal(result.ok, true);
  assert.equal(result.lane, "session-finish");
  assert.equal(result.status, "planned");
  assert.equal(result.action, "land-and-clean");
  assert.equal(result.branch, started.session.branch);
  assert.equal(result.worktreePath, started.session.worktree_path);
});

test("guardian_done defaults to batch finish when run bare from the primary", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const a = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_select_a", taskName: "select a", createWorktree: true, config: DEFAULT_CONFIG });
  const b = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_select_b", taskName: "select b", createWorktree: true, config: DEFAULT_CONFIG });

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo }));

  assert.equal(result.ok, true);
  assert.equal(result.status, "planned");
  assert.equal(result.lane, "done-all");
  const summary = result.summary as Record<string, unknown>;
  assert.equal(summary.total, 2);
  assert.equal(summary.finishable, 2);
  const sessions = result.sessions as readonly { branch: string }[];
  assert.deepEqual(sessions.map((session) => session.branch).sort(), [a.session.branch, b.session.branch].sort());
  assert.equal(typeof result.confirmToken, "string");
  assert.equal(result.nextAction, "guardian_done mode=apply confirm=true");
});

test("guardian_done blocks with candidate sessions when the branch has no active session", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const a = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_branch_missing", taskName: "branch missing", createWorktree: true, config: DEFAULT_CONFIG });

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, branch: "guardian/nope" }));

  assert.equal(result.ok, false);
  assert.equal(result.lane, "branch-not-found");
  assert.match(String(result.reason), /no active Guardian session owns branch/);
  const sessions = result.availableSessions as readonly { branch: string }[];
  assert.ok(sessions.some((session) => session.branch === a.session.branch));
});
