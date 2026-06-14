import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianGc } from "../src/gc.ts";
import { guardianStatus } from "../src/recover.ts";
import { guardianStart } from "../src/tools.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepo, createRepoWithOrigin, git, seedSession } from "./helpers.ts";

function candidateIds(result: Record<string, unknown>): string[] {
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  return candidates
    .map((candidate) => (isRecordLike(candidate) && typeof candidate.session_id === "string" ? candidate.session_id : ""))
    .filter((id) => id.length > 0)
    .sort();
}

test("guardian_gc plan/apply prunes poisoned, orphaned, and stale-terminal records but keeps healthy and recent sessions", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_healthy", taskName: "healthy", createWorktree: true, config: DEFAULT_CONFIG });
  await seedSession(repo, { session_id: "ses_poison", status: "active", branch: "main", worktree_path: repo, base_ref: "origin/main", safety_refs: [] });
  await seedSession(repo, { session_id: "ses_orphan", status: "active", branch: "guardian/orphan", worktree_path: path.join(repo, ".worktrees", "gone"), base_ref: "origin/main", safety_refs: [] });
  await seedSession(repo, { session_id: "ses_terminal", status: "deleted", branch: "guardian/old", worktree_path: path.join(repo, ".worktrees", "old"), updated_at: "2000-01-01T00:00:00.000Z", safety_refs: [] });
  await seedSession(repo, { session_id: "ses_recent_terminal", status: "deleted", branch: "guardian/recent", worktree_path: path.join(repo, ".worktrees", "recent"), updated_at: new Date().toISOString(), safety_refs: [] });

  const plan = await guardianGc({ repoRoot: repo, cwd: repo, mode: "plan", config: DEFAULT_CONFIG });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(typeof plan.confirmToken, "string");
  assert.deepEqual(candidateIds(plan), ["ses_orphan", "ses_poison", "ses_terminal"]);

  const worktreesBefore = (await git(repo, ["worktree", "list", "--porcelain"])).stdout;

  const apply = await guardianGc({ repoRoot: repo, cwd: repo, mode: "apply", confirmDelete: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG });
  assert.equal(apply.ok, true);
  assert.equal(apply.status, "pruned");
  assert.equal(apply.prunedCount, 3);

  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const ids = status.sessions.map((session) => session.session_id);
  assert.equal(ids.includes("ses_healthy"), true);
  assert.equal(ids.includes("ses_recent_terminal"), true);
  assert.equal(ids.includes("ses_poison"), false);
  assert.equal(ids.includes("ses_orphan"), false);
  assert.equal(ids.includes("ses_terminal"), false);

  // record-only: git worktrees are untouched
  assert.equal((await git(repo, ["worktree", "list", "--porcelain"])).stdout, worktreesBefore);
  assert.equal((await git(repo, ["rev-parse", "--verify", "main"])).stdout.length > 0, true);
});

test("guardian_gc apply blocks without confirmDelete and on stale token", async () => {
  const repo = await createRepo();
  await seedSession(repo, { session_id: "ses_p", status: "active", branch: "main", worktree_path: repo, base_ref: "origin/main", safety_refs: [] });

  const plan = await guardianGc({ repoRoot: repo, mode: "plan", config: DEFAULT_CONFIG });
  assert.equal(plan.status, "planned");

  const noConfirm = await guardianGc({ repoRoot: repo, mode: "apply", confirmToken: typeof plan.confirmToken === "string" ? plan.confirmToken : "", config: DEFAULT_CONFIG });
  assert.equal(noConfirm.ok, false);
  assert.match(String(noConfirm.reason), /confirmDelete/);

  const badToken = await guardianGc({ repoRoot: repo, mode: "apply", confirmDelete: true, confirmToken: "nope", config: DEFAULT_CONFIG });
  assert.equal(badToken.ok, false);
  assert.match(String(badToken.reason), /token mismatch/);

  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.sessions.some((session) => session.session_id === "ses_p"), true);
});

test("guardian_gc rejects an invalid mode", async () => {
  const repo = await createRepo();
  const result = await guardianGc({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /mode must be plan or apply/);
});

test("guardian_gc detects and prunes a mis-homed active session whose worktree belongs to a different repository", async () => {
  const repo = await createRepo();
  const foreign = await createRepo();
  test.after(() => fs.rm(repo, { recursive: true, force: true }));
  test.after(() => fs.rm(foreign, { recursive: true, force: true }));
  await seedSession(repo, { session_id: "ses_foreign", status: "active", branch: "tooling/preserve-local-changes", worktree_path: foreign, base_ref: "origin/main", safety_refs: [] });

  const plan = await guardianGc({ repoRoot: repo, cwd: repo, mode: "plan", config: DEFAULT_CONFIG });
  assert.equal(plan.ok, true);
  const candidates = Array.isArray(plan.candidates) ? plan.candidates : [];
  const foreignCandidate = candidates.find((candidate) => isRecordLike(candidate) && candidate.session_id === "ses_foreign");
  assert.ok(foreignCandidate && isRecordLike(foreignCandidate));
  assert.equal(foreignCandidate.reason, "foreign-repo");

  const apply = await guardianGc({ repoRoot: repo, cwd: repo, mode: "apply", confirmDelete: true, confirmToken: typeof plan.confirmToken === "string" ? plan.confirmToken : "", config: DEFAULT_CONFIG });
  assert.equal(apply.ok, true);
  assert.equal(apply.status, "pruned");
  assert.equal(Array.isArray(apply.prunedSessionIds) && apply.prunedSessionIds.includes("ses_foreign"), true);

  assert.equal((await git(foreign, ["rev-parse", "--verify", "main"])).stdout.length > 0, true);
});
