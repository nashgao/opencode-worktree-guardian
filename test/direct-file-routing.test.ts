import assert from "node:assert/strict";
import test from "node:test";
import { routeDirectFileMutation } from "../src/plugin/direct-file-routing.ts";
import type { GuardCommandPayload, SessionWorktreeResult } from "../src/types.ts";

const repoRoot = "/repo";
function writeInput(): GuardCommandPayload {
  return { tool: "write", args: { filePath: "/repo/src/foo.ts" } };
}

test("terminal session no longer fail-closes direct file edits", async () => {
  const sessionWorktree: SessionWorktreeResult = { ok: true, sessionId: "ses_terminal", expectedWorktree: null, actualWorktree: repoRoot, matches: true, terminal: true };
  const result = await routeDirectFileMutation(writeInput(), {}, sessionWorktree, repoRoot, new Map());
  assert.equal(result.blocked, false);
  assert.equal(result.routed, false);
});

test("non-terminal session with an unresolvable worktree still fail-closes", async () => {
  const sessionWorktree: SessionWorktreeResult = { ok: true, sessionId: "ses_active", expectedWorktree: null, actualWorktree: repoRoot, matches: true };
  const result = await routeDirectFileMutation(writeInput(), {}, sessionWorktree, repoRoot, new Map());
  assert.equal(result.blocked, true);
});

test("no recorded session allows direct file edits", async () => {
  const sessionWorktree: SessionWorktreeResult = { ok: true, sessionId: null, expectedWorktree: null, actualWorktree: repoRoot, matches: true };
  const result = await routeDirectFileMutation(writeInput(), {}, sessionWorktree, repoRoot, new Map());
  assert.equal(result.blocked, false);
});
