import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDeleteWorktree } from "../src/delete.ts";
import { guardianFinish } from "../src/finish.ts";
import { guardianDone } from "../src/done.ts";
import { buildPreservedRef, buildSafetyRef } from "../src/git.ts";
import { getGuardianPaths, readState, recordSession, writeStateAtomic } from "../src/state.ts";
import { guardianUnblockFinish } from "../src/unblock-finish.ts";
import { guardianPreserve, guardianStart } from "../src/tools.ts";
import type { GuardianConfig } from "../src/types.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

const quarantineConfig = {
  ...DEFAULT_CONFIG,
  goal: { ...DEFAULT_CONFIG.goal, quarantineSessionResidue: true },
} satisfies GuardianConfig;

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
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_recover_finish", taskName: "recover finish", createWorktree: true, config: quarantineConfig });
  await forgetRecordedSession(repo, started.session.session_id);
  const commit = (await git(started.session.worktree_path, ["rev-parse", "HEAD"])).stdout;

  const result = await guardianFinish({ repoRoot: repo, cwd: started.session.worktree_path, timestamp: "20260613T120000", config: quarantineConfig });

  assert.equal(result.ok, true);
  assert.equal(result.status, "pr-suggested");
  assert.equal(result.preflight.currentWorktree, started.session.worktree_path);
  assert.equal(result.preflight.sessionOwnedWorktree, true);
  assert.match(String(result.preflight.sessionId), /^ses_recovered_guardian-recover-finish/);
  assert.equal((await git(remote, ["rev-parse", `refs/heads/${started.session.branch}`])).stdout, commit);
  assert.equal((await git(started.session.worktree_path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).stdout, `origin/${started.session.branch}`);
  const recoveredId = String(result.preflight.sessionId);
  const state = await readState(await getGuardianPaths(repo), { repoRoot: repo, config: quarantineConfig });
  assert.equal(state.sessions[recoveredId]?.provenance_status, "ineligible");
  assert.equal(state.sessions[recoveredId]?.quarantine_eligible, false);
  assert.equal(state.sessions[recoveredId]?.provenance, undefined);
});

test("guardian_done all=true blocks cleanup-only blockers without an apply token", async (t) => {
  const { base, repo } = await createRepoWithOrigin(); t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "dirty-primary.txt"), "dirty primary\n");
  const plan = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan" }) as Record<string, unknown>;
  assert.equal(plan.ok, false, JSON.stringify(plan)); assert.equal(plan.status, "blocked"); assert.equal(plan.confirmToken, undefined); assert.match(plan.reason as string, /cleanup plan has blockers/); assert.equal((plan.cleanupPlan as Record<string, unknown>).ok, false);
  const apply = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "apply", confirm: true, confirmToken: "stale" }) as Record<string, unknown>;
  assert.equal(apply.ok, false, JSON.stringify(apply)); assert.equal(apply.status, "blocked"); assert.match(apply.reason as string, /cleanup plan has blockers/);
});

test("guardian_finish blocks a divergent remote branch without overwriting its head", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_finish_divergence", taskName: "finish divergence", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(started.session.worktree_path, "local.txt"), "local\n");
  await git(started.session.worktree_path, ["add", "local.txt"]);
  await git(started.session.worktree_path, ["commit", "-m", "local feature"]);
  const localCommit = (await git(started.session.worktree_path, ["rev-parse", "HEAD"])).stdout;
  const sibling = path.join(base, "sibling");
  await git(repo, ["clone", remote, sibling]);
  await git(sibling, ["config", "user.email", "guardian@example.test"]);
  await git(sibling, ["config", "user.name", "Guardian Test"]);
  await git(sibling, ["checkout", "-b", started.session.branch, "origin/main"]);
  await fs.writeFile(path.join(sibling, "remote.txt"), "remote\n");
  await git(sibling, ["add", "remote.txt"]);
  await git(sibling, ["commit", "-m", "remote feature"]);
  await git(sibling, ["push", "origin", `HEAD:refs/heads/${started.session.branch}`]);
  const remoteHead = (await git(remote, ["rev-parse", `refs/heads/${started.session.branch}`])).stdout;

  const result = await guardianFinish({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: started.session.session_id, timestamp: "20260613T130000" });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "push failed");
  assert.equal((await git(remote, ["rev-parse", `refs/heads/${started.session.branch}`])).stdout, remoteHead);
  assert.equal(await fs.access(started.session.worktree_path).then(() => true, () => false), true);
  assert.equal((await git(repo, ["rev-parse", `refs/heads/${started.session.branch}`])).stdout, localCommit);
  if (typeof result.safetyRef !== "string") throw new Error("blocked finish did not return a safety ref");
  assert.equal((await git(repo, ["rev-parse", result.safetyRef])).stdout, localCommit);
});

test("guardian_finish retries a failed push with its exact safety ref", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_finish_retry", taskName: "finish retry", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  await fs.writeFile(path.join(worktree, "retry.txt"), "retry\n");
  await git(worktree, ["add", "retry.txt"]);
  await git(worktree, ["commit", "-m", "finish retry"]);
  const commit = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  const timestamp = "20260728T120000";
  await git(repo, ["remote", "set-url", "origin", path.join(base, "missing-origin")]);

  const blocked = await guardianFinish({ repoRoot: repo, cwd: worktree, sessionId: started.session.session_id, timestamp });

  assert.equal(blocked.ok, false, JSON.stringify(blocked));
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reason, "push failed");
  if (typeof blocked.safetyRef !== "string") throw new Error("blocked finish did not return a safety ref");
  await git(repo, ["remote", "set-url", "origin", remote]);
  const retried = await guardianFinish({ repoRoot: repo, cwd: worktree, sessionId: started.session.session_id, timestamp });

  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(retried.safetyRef, blocked.safetyRef);
  assert.equal((await git(remote, ["rev-parse", `refs/heads/${started.session.branch}`])).stdout, commit);
  const state = await readState(await getGuardianPaths(repo), { repoRoot: repo, config: DEFAULT_CONFIG });
  const safetyRefs = state.sessions[started.session.session_id]?.safety_refs ?? [];
  assert.equal(safetyRefs.filter((ref) => ref === blocked.safetyRef).length, 1);
});

test("guardian_finish blocks an unrecorded same-OID planned safety ref before pushing", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_finish_unrecorded_collision", taskName: "finish unrecorded collision", createWorktree: true, config: DEFAULT_CONFIG });
  const timestamp = "20260728T121111";
  const plannedSafetyRef = buildSafetyRef(started.session.session_id, started.session.branch, timestamp);
  const commit = (await git(started.session.worktree_path, ["rev-parse", "HEAD"])).stdout;
  await git(repo, ["update-ref", plannedSafetyRef, commit]);

  const result = await guardianFinish({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: started.session.session_id, finishMode: "push-branch", timestamp });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "safety ref creation failed");
  assert.equal((await git(repo, ["rev-parse", plannedSafetyRef])).stdout, commit);
  assert.equal((await git(repo, ["rev-parse", `refs/heads/${started.session.branch}`])).stdout, commit);
  assert.equal(await fs.access(started.session.worktree_path).then(() => true, () => false), true);
  await assert.rejects(() => git(remote, ["rev-parse", "--verify", `refs/heads/${started.session.branch}`]));
  const state = await readState(await getGuardianPaths(repo), { repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(state.sessions[started.session.session_id]?.status, "active");
  assert.deepEqual(state.sessions[started.session.session_id]?.safety_refs, []);
});

test("guardian_finish blocks preserve-only when its planned safety ref already exists", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_finish_preserve_collision", taskName: "finish preserve collision", createWorktree: true, config: DEFAULT_CONFIG });
  const timestamp = "20260728T121212";
  const plannedSafetyRef = buildSafetyRef(started.session.session_id, started.session.branch, timestamp);
  const worktreeCommit = (await git(started.session.worktree_path, ["rev-parse", "HEAD"])).stdout;
  await git(repo, ["update-ref", plannedSafetyRef, worktreeCommit]);

  const result = await guardianFinish({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: started.session.session_id, finishMode: "preserve-only", timestamp });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.equal((await git(repo, ["rev-parse", plannedSafetyRef])).stdout, worktreeCommit);
  const state = await readState(await getGuardianPaths(repo), { repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(state.sessions[started.session.session_id]?.status, "active");
});

test("retrying an orphan branch after a temporary branch-ref lock terminalizes its original session once", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/delete-orphan-retry";
  const sessionId = "ses_delete_orphan_retry";
  const timestamp = "20260601T191000";
  const absentWorktree = path.join(repo, ".worktrees", "opencode-worktree-guardian", "guardian-session-ses-orphan-retry");
  const safetyRef = `refs/opencode-guardian/${sessionId}/${branch}/${timestamp}`;
  await git(repo, ["branch", branch, "main"]);
  const { stdout: head } = await git(repo, ["rev-parse", branch]);
  await recordSession(repo, DEFAULT_CONFIG, {
    session_id: sessionId,
    status: "active",
    branch,
    worktree_path: absentWorktree,
    base_ref: "origin/main",
    head_commit: head,
    worktree_delete_failed: true,
    worktree_delete_error: "stale worktree deletion failure",
  });

  const firstPlan = await guardianDeleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, deleteBranch: true, config: DEFAULT_CONFIG, timestamp });
  assert.equal(firstPlan.ok, true);
  const { stdout: lockPath } = await git(repo, ["rev-parse", "--git-path", `refs/heads/${branch}.lock`]);
  const branchLockPath = path.resolve(repo, lockPath);
  await fs.mkdir(path.dirname(branchLockPath), { recursive: true });
  await fs.writeFile(branchLockPath, "temporary lock\n");

  const failed = await guardianDeleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId, deleteBranch: true, confirmToken: firstPlan.confirmToken, config: DEFAULT_CONFIG, timestamp });
  assert.equal(failed.ok, false);
  await git(repo, ["rev-parse", "--verify", branch]);
  const failedState = await readState(await getGuardianPaths(repo), { repoRoot: repo, config: DEFAULT_CONFIG });
  const failedSession = failedState.sessions[sessionId];
  assert.equal(failedSession?.status, "active");
  assert.deepEqual(failedSession?.safety_refs, [safetyRef]);
  assert.equal((await git(repo, ["rev-parse", safetyRef])).stdout, head);
  await fs.rm(branchLockPath);

  const retryPlan = await guardianDeleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", branch, deleteBranch: true, config: DEFAULT_CONFIG, timestamp });
  assert.equal(retryPlan.ok, true);
  const retryPreflight = retryPlan.preflight;
  if (!retryPreflight || typeof retryPreflight !== "object") throw new Error("retry plan did not return preflight evidence");
  assert.equal(Reflect.get(retryPreflight, "targetKind"), "orphan-branch");
  const retried = await guardianDeleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", branch, deleteBranch: true, confirmToken: retryPlan.confirmToken, config: DEFAULT_CONFIG, timestamp });

  assert.equal(retried.ok, true);
  assert.equal(retried.status, "deleted");
  assert.equal(retried.safetyRef, safetyRef);
  await assert.rejects(() => git(repo, ["rev-parse", "--verify", branch]));
  const { stdout: refs } = await git(repo, ["for-each-ref", "--format=%(refname)", `refs/opencode-guardian/${sessionId}/`]);
  assert.deepEqual(refs.split("\n").filter(Boolean), [safetyRef]);
  const state = await readState(await getGuardianPaths(repo), { repoRoot: repo, config: DEFAULT_CONFIG });
  const session = state.sessions[sessionId];
  assert.equal(session?.status, "deleted");
  assert.equal(session?.deleted_branch, branch);
  assert.equal(session?.deleted_worktree_path, absentWorktree);
  assert.equal(session?.branch_only_delete, true);
  assert.equal(session?.branch_delete_failed, undefined);
  assert.equal(session?.branch_delete_error, undefined);
  assert.equal(session?.worktree_delete_failed, undefined);
  assert.equal(session?.worktree_delete_error, undefined);
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

test("guardian_preserve blocks on a colliding preserved ref without changing session state", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_preserve_collision", taskName: "preserve collision", createWorktree: true, config: DEFAULT_CONFIG });
  const timestamp = "20260727T081010";
  const preservedRef = buildPreservedRef(started.session.session_id, started.session.branch, timestamp);
  await fs.writeFile(path.join(repo, "preserve-collision.txt"), "newer main commit\n");
  await git(repo, ["add", "preserve-collision.txt"]);
  await git(repo, ["commit", "-m", "create preserved ref collision target"]);
  await git(repo, ["push", "origin", "main"]);
  const originalTarget = (await git(repo, ["rev-parse", "origin/main"])).stdout;
  await git(repo, ["update-ref", preservedRef, originalTarget]);

  const result = await guardianPreserve({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: started.session.session_id, timestamp });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal((await git(repo, ["rev-parse", preservedRef])).stdout, originalTarget);
  const state = await readState(await getGuardianPaths(repo), { repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(state.sessions[started.session.session_id]?.status, "active");
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
