import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { routeDirectFileMutation } from "../src/plugin/direct-file-routing.ts";
import type { GuardCommandPayload, SessionWorktreeResult } from "../src/types.ts";

const repoRoot = "/repo";
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
