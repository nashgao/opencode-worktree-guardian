import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianFinish } from "../src/finish.ts";
import { getGuardianPaths, readState, writeStateAtomic } from "../src/state.ts";
import { guardianUnblockFinish } from "../src/unblock-finish.ts";
import { guardianPreserve, guardianStart } from "../src/tools.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

async function forgetRecordedSession(repo: string, sessionId: string) {
  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });
  delete state.sessions[sessionId];
  await writeStateAtomic(paths, state);
}

async function addReviewArtifact(worktreePath: string) {
  const relativePath = ".milestones/reviews/recovered-worktree-impl-rating-20260613.md";
  const reviewPath = path.join(worktreePath, relativePath);
  await fs.mkdir(path.dirname(reviewPath), { recursive: true });
  await fs.writeFile(reviewPath, "# Recovered Worktree\n");
  return relativePath;
}

test("guardian_finish recovers a Guardian worktree without caller-supplied session id", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_recover_finish", taskName: "recover finish", createWorktree: true, config: DEFAULT_CONFIG });
  await forgetRecordedSession(repo, started.session.session_id);

  const result = await guardianFinish({ repoRoot: repo, cwd: started.session.worktree_path, timestamp: "20260613T120000" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "pr-suggested");
  assert.equal(result.preflight.currentWorktree, started.session.worktree_path);
  assert.equal(result.preflight.sessionOwnedWorktree, true);
  assert.match(String(result.preflight.sessionId), /^ses_recovered_guardian-recover-finish/);
});

test("guardian_preserve recovers a Guardian worktree without caller-supplied session id", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_recover_preserve", taskName: "recover preserve", createWorktree: true, config: DEFAULT_CONFIG });
  await forgetRecordedSession(repo, started.session.session_id);

  const result = await guardianPreserve({ repoRoot: repo, cwd: started.session.worktree_path, timestamp: "20260613T121212" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "preserved");
  if (!result.session) throw new Error("preserve did not return a session");
  assert.match(String(result.session.session_id), /^ses_recovered_guardian-recover-preserve/);
  assert.equal(result.session.worktree_path, started.session.worktree_path);
});

test("guardian_unblock_finish recovers the current Guardian worktree without caller-supplied session id", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_recover_unblock", taskName: "recover unblock", createWorktree: true, config: DEFAULT_CONFIG });
  await forgetRecordedSession(repo, started.session.session_id);
  const relativeReviewPath = await addReviewArtifact(started.session.worktree_path);
  const plan = await guardianUnblockFinish({ repoRoot: repo, cwd: started.session.worktree_path, mode: "plan", config: DEFAULT_CONFIG });

  const result = await guardianUnblockFinish({ repoRoot: repo, cwd: started.session.worktree_path, mode: "apply", confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260613T131313" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "applied");
  assert.deepEqual(result.committedPaths, [relativeReviewPath]);
  assert.match(String(result.preflight.sessionId), /^ses_recovered_guardian-recover-unblock/);
  assert.equal((await git(started.session.worktree_path, ["status", "--porcelain"])).stdout, "");
});
