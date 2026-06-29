import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { guardianFinish } from "../src/finish.ts";
import { createSafetyRef } from "../src/git.ts";
import { guardianStatus } from "../src/recover.ts";
import { guardianStart } from "../src/tools.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepoWithOrigin, git, seedSession } from "./helpers.ts";

type LooseRecord = Record<string, unknown>;
type DoneResult = LooseRecord & {
  readonly candidates: readonly { readonly branch?: string; readonly plan?: LooseRecord }[];
  readonly cleanupPlan: { readonly status?: unknown; readonly candidates: readonly { readonly branch?: string }[] };
  readonly cleanupSweep: { readonly ok?: boolean; readonly status?: unknown; readonly candidateCount?: number; readonly cleanedCount?: number; readonly apply?: { readonly results?: readonly { readonly branch?: string; readonly worktreeRemoved?: boolean; readonly branchDeleted?: boolean }[] } };
  readonly commit: string;
  readonly confirmToken: string;
  readonly dirtyFiles?: readonly string[];
  readonly dirtySnapshot: { readonly paths: readonly string[] };
  readonly finalPostflight?: LooseRecord;
  readonly nextAction: string;
  readonly preflight: Record<string, unknown>;
  readonly reason: string;
  readonly results: readonly LooseRecord[];
  readonly safetyRef: string;
};

function asDone(result: LooseRecord): DoneResult {
  return result as DoneResult;
}

async function pathExists(filePath: string) {
  return fs.access(filePath).then(() => true, () => false);
}

async function branchExists(repo: string, branch: string) {
  return git(repo, ["rev-parse", "--verify", branch]).then(() => true, () => false);
}

function macVarAlias(filePath: string) {
  return filePath.startsWith("/private/var/") ? filePath.replace(/^\/private\/var\//, "/var/") : filePath;
}

async function guardianRefNames(repo: string) {
  const { stdout } = await git(repo, ["for-each-ref", "--format=%(refname)", "refs/opencode-guardian"]);
  return stdout.length === 0 ? [] : stdout.split("\n");
}

async function makeMergedCleanupCandidate(repo: string) {
  const branch = "guardian/done-cleanup";
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, "done-cleanup.txt"), "cleanup\n");
  await git(repo, ["add", "done-cleanup.txt"]);
  await git(repo, ["commit", "-m", "add done cleanup"]);
  await git(repo, ["checkout", "main"]);
  await git(repo, ["merge", "--no-ff", branch, "-m", "merge done cleanup"]);
  await git(repo, ["push", "origin", "main"]);
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), "done-cleanup");
  await git(repo, ["worktree", "add", worktreePath, branch]);
  return { branch, worktreePath };
}

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

test("guardian_done direct preserve-only plan is read-only", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_plan_preserve", taskName: "done plan preserve", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  await fs.writeFile(path.join(worktree, "plan-preserve.txt"), "plan preserve\n");
  await git(worktree, ["add", "plan-preserve.txt"]);
  await git(worktree, ["commit", "-m", "add plan preserve work"]);
  assert.deepEqual(await guardianRefNames(repo), []);

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: worktree, sessionId: "ses_done_plan_preserve", mode: "plan", finishMode: "preserve-only", timestamp: "20260609T060606", config: DEFAULT_CONFIG }));

  assert.equal(result.ok, true);
  assert.equal(result.lane, "session-finish");
  assert.equal(result.status, "planned");
  assert.equal(result.mode, "preserve-only");
  assert.equal(result.worktree, worktree);
  assert.equal(result.safetyRef, undefined);
  assert.match(result.nextAction, /guardian_done mode=apply confirm=true finishMode=preserve-only/);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.activeSessions.some((session: LooseRecord) => session.session_id === "ses_done_plan_preserve"), true);
  assert.equal(status.terminalSessions.some((session: LooseRecord) => session.session_id === "ses_done_plan_preserve"), false);
  assert.equal(status.safetyRefs.length, 0);
  assert.deepEqual(await guardianRefNames(repo), []);
  assert.equal(await pathExists(worktree), true);
});

test("guardian_done direct preserve-only defaults to read-only planning", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_default_plan_preserve", taskName: "done default plan preserve", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  await fs.writeFile(path.join(worktree, "default-plan-preserve.txt"), "default plan preserve\n");
  await git(worktree, ["add", "default-plan-preserve.txt"]);
  await git(worktree, ["commit", "-m", "add default plan preserve work"]);

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: worktree, sessionId: "ses_done_default_plan_preserve", finishMode: "preserve-only", timestamp: "20260609T060707", config: DEFAULT_CONFIG }));

  assert.equal(result.ok, true);
  assert.equal(result.lane, "session-finish");
  assert.equal(result.status, "planned");
  assert.equal(result.safetyRef, undefined);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.activeSessions.some((session: LooseRecord) => session.session_id === "ses_done_default_plan_preserve"), true);
  assert.equal(status.safetyRefs.length, 0);
  assert.deepEqual(await guardianRefNames(repo), []);
});

test("guardian_done direct preserve-only apply requires confirmation", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_apply_preserve_confirm", taskName: "done apply preserve confirm", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  await fs.writeFile(path.join(worktree, "apply-preserve-confirm.txt"), "apply preserve confirm\n");
  await git(worktree, ["add", "apply-preserve-confirm.txt"]);
  await git(worktree, ["commit", "-m", "add apply preserve confirm work"]);

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: worktree, sessionId: "ses_done_apply_preserve_confirm", mode: "apply", finishMode: "preserve-only", timestamp: "20260609T060808", config: DEFAULT_CONFIG }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.lane, "session-finish");
  assert.match(result.reason, /confirm=true/);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.activeSessions.some((session: LooseRecord) => session.session_id === "ses_done_apply_preserve_confirm"), true);
  assert.equal(status.safetyRefs.length, 0);
  assert.deepEqual(await guardianRefNames(repo), []);
});

test("guardian_done direct preserve-only apply preserves with one safety ref", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_apply_preserve", taskName: "done apply preserve", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  await fs.writeFile(path.join(worktree, "apply-preserve.txt"), "apply preserve\n");
  await git(worktree, ["add", "apply-preserve.txt"]);
  await git(worktree, ["commit", "-m", "add apply preserve work"]);
  const plan = asDone(await guardianDone({ repoRoot: repo, cwd: worktree, sessionId: "ses_done_apply_preserve", mode: "plan", finishMode: "preserve-only", timestamp: "20260609T060909", config: DEFAULT_CONFIG }));
  assert.equal(plan.status, "planned");
  assert.deepEqual(await guardianRefNames(repo), []);

  const apply = asDone(await guardianDone({ repoRoot: repo, cwd: worktree, sessionId: "ses_done_apply_preserve", mode: "apply", confirm: true, finishMode: "preserve-only", timestamp: "20260609T061010", config: DEFAULT_CONFIG }));

  assert.equal(apply.ok, true);
  assert.equal(apply.lane, "session-finish");
  assert.equal(apply.status, "preserved");
  assert.match(apply.safetyRef, /refs\/opencode-guardian\/ses_done_apply_preserve\/guardian\//);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.activeSessions.some((session: LooseRecord) => session.session_id === "ses_done_apply_preserve"), false);
  assert.equal(status.terminalSessions.some((session: LooseRecord) => session.session_id === "ses_done_apply_preserve" && session.status === "preserved"), true);
  assert.equal(status.safetyRefs.length, 1);
  assert.deepEqual(await guardianRefNames(repo), [apply.safetyRef]);
  const { stdout: resolvedRef } = await git(repo, ["rev-parse", "--verify", apply.safetyRef]);
  assert.equal(resolvedRef, apply.commit);
  assert.equal(await pathExists(worktree), true);
});

test("guardian_done direct merge-to-base plan requires explicit merge approval before safety refs", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_merge_plan_approval", taskName: "done merge plan approval", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  await fs.writeFile(path.join(worktree, "merge-plan-approval.txt"), "merge plan approval\n");
  await git(worktree, ["add", "merge-plan-approval.txt"]);
  await git(worktree, ["commit", "-m", "add merge plan approval work"]);

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: worktree, sessionId: "ses_done_merge_plan_approval", mode: "plan", finishMode: "merge-to-base", timestamp: "20260609T061111", config: DEFAULT_CONFIG }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.lane, "session-finish");
  assert.match(result.reason, /allowMergeToBase=true/);
  assert.equal(result.safetyRef, undefined);
  assert.equal(result.preflight.safetyRef, null);
  assert.deepEqual(await guardianRefNames(repo), []);
});

test("guardian_done plans cleanup-only on clean primary main", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const candidate = await makeMergedCleanupCandidate(repo);

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(result.ok, true);
  assert.equal(result.lane, "cleanup-only");
  assert.equal(result.status, "planned");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].branch, candidate.branch);
  assert.equal(typeof result.confirmToken, "string");
  assert.equal(await pathExists(candidate.worktreePath), true);
});

test("guardian_done cleanup-only blocks redundant dirty cleanup candidates", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const candidate = await makeMergedCleanupCandidate(repo);
  await fs.writeFile(path.join(repo, "done-cleanup.txt"), "advanced base cleanup\n");
  await git(repo, ["add", "done-cleanup.txt"]);
  await git(repo, ["commit", "-m", "advance done cleanup base"]);
  await git(repo, ["push", "origin", "main"]);
  await fs.writeFile(path.join(candidate.worktreePath, "done-cleanup.txt"), "advanced base cleanup\n");

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /cleanup blockers/);
  assert.equal(await pathExists(candidate.worktreePath), true);
});

test("guardian_done cleanup-only abandons stale unmerged Guardian branches with safety proof", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/done-stale-abandon";
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, "done-stale-abandon.txt"), "stale unmerged\n");
  await git(repo, ["add", "done-stale-abandon.txt"]);
  await git(repo, ["commit", "-m", "add stale unmerged done cleanup"]);
  const { stdout: head } = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["checkout", "main"]);
  await createSafetyRef(repo, { sessionId: "manual-smoke", branch, commit: head, timestamp: "20260629T010101" });
  const aliasRepo = macVarAlias(repo);

  const plan = asDone(await guardianDone({ repoRoot: aliasRepo, cwd: aliasRepo, mode: "plan", timestamp: "20260629T010101" }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.lane, "cleanup-only");
  assert.equal(plan.status, "planned");
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].branch, branch);
  const planRecord = isRecordLike(plan.candidates[0].plan) ? plan.candidates[0].plan : {};
  const planPreflight = isRecordLike(planRecord.preflight) ? planRecord.preflight : {};
  assert.equal(planPreflight.abandonUnmerged, true);
  assert.equal(await branchExists(repo, branch), true);

  const apply = asDone(await guardianDone({ repoRoot: aliasRepo, cwd: aliasRepo, mode: "apply", confirm: true, confirmToken: plan.confirmToken, timestamp: "20260629T010101" }));

  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.equal(apply.status, "cleaned");
  assert.equal(apply.lane, "cleanup-only");
  assert.equal(apply.results.length, 1);
  assert.equal(apply.results[0].status, "abandoned");
  assert.equal(apply.results[0].branchDeleted, true);
  assert.equal(apply.results[0].abandonUnmerged, true);
  assert.equal(await branchExists(repo, branch), false);
  const finalPostflight = apply.finalPostflight as LooseRecord;
  assert.equal(finalPostflight.ok, true);
});

test("guardian_done plans dirty primary-main publish with token-bound dirty files", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "done-feature.txt"), "feature\n");

  const plan = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: done feature" }));

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.lane, "primary-main-publish");
  assert.equal(plan.commitMessage, "feat: done feature");
  assert.equal(typeof plan.confirmToken, "string");
  assert.match(plan.nextAction, /confirm=true/);
  assert.doesNotMatch(plan.nextAction, /confirmToken|sessionId/);
  assert.deepEqual(plan.dirtySnapshot.paths, ["done-feature.txt"]);
});

test("guardian_done blocks dirty primary-main publish without commit message", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "done-feature.txt"), "feature\n");

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /commitMessage is required/);
  assert.deepEqual(result.dirtyFiles, ["done-feature.txt"]);
});

test("guardian_done blocks stale dirty-primary tokens after file content changes", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const featurePath = path.join(repo, "done-feature.txt");
  await fs.writeFile(featurePath, "feature\n");
  const plan = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: done feature" }));
  await fs.writeFile(featurePath, "changed\n");

  const apply = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "apply", commitMessage: "feat: done feature", confirmToken: plan.confirmToken }));

  assert.equal(apply.ok, false);
  assert.equal(apply.status, "blocked");
  assert.match(apply.reason, /plan changed; rerun plan/);
  await assert.rejects(() => git(repo, ["rev-parse", "--verify", "refs/opencode-guardian/primary-main/main/20260609T010101"]));
});

test("guardian_done applies dirty primary-main publish and cleans safe redundant candidates", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const candidate = await makeMergedCleanupCandidate(repo);
  await fs.writeFile(path.join(repo, "done-publish.txt"), "publish\n");
  const plan = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: done publish" }));

  const apply = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "apply", commitMessage: "feat: done publish", confirmToken: plan.confirmToken, timestamp: "20260609T010101" }));

  assert.equal(apply.ok, true);
  assert.equal(apply.status, "published");
  assert.equal(apply.lane, "primary-main-publish");
  assert.match(apply.safetyRef, /refs\/opencode-guardian\/primary-main\/main\/20260609T010101/);
  assert.equal(apply.cleanupSweep.ok, true, JSON.stringify(apply.cleanupSweep));
  assert.equal(apply.cleanupSweep.status, "cleaned");
  assert.equal(apply.cleanupSweep.candidateCount, 1);
  assert.equal(apply.cleanupSweep.cleanedCount, 1);
  assert.equal(apply.cleanupSweep.apply?.results?.[0]?.branch, candidate.branch);
  assert.equal(apply.cleanupSweep.apply?.results?.[0]?.worktreeRemoved, true);
  assert.equal(apply.cleanupSweep.apply?.results?.[0]?.branchDeleted, true);
  assert.equal(await pathExists(candidate.worktreePath), false);
  await assert.rejects(() => git(repo, ["rev-parse", "--verify", candidate.branch]));
  const { stdout: remoteMain } = await git(repo, ["rev-parse", "origin/main"]);
  assert.equal(remoteMain, apply.commit);
});

test("guardian_done publishes dirty primary-main deletions", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const deletedPath = path.join(repo, "delete-me.txt");
  await fs.writeFile(deletedPath, "remove me\n");
  await git(repo, ["add", "delete-me.txt"]);
  await git(repo, ["commit", "-m", "add deletable file"]);
  await git(repo, ["push", "origin", "main"]);
  await fs.rm(deletedPath);
  await git(repo, ["add", "delete-me.txt"]);
  const plan = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "chore: remove obsolete file" }));

  const apply = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "apply", commitMessage: "chore: remove obsolete file", confirmToken: plan.confirmToken, timestamp: "20260609T040404" }));

  assert.equal(apply.ok, true);
  assert.equal(apply.status, "published");
  assert.deepEqual(plan.dirtySnapshot.paths, ["delete-me.txt"]);
  const { stdout: remoteMain } = await git(repo, ["rev-parse", "origin/main"]);
  assert.equal(remoteMain, apply.commit);
  await assert.rejects(() => git(repo, ["cat-file", "-e", "origin/main:delete-me.txt"]));
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

test("guardian_done plans reattaching a new session inside an existing Guardian worktree", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_lost_original", taskName: "done lost original", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(started.session.worktree_path, "reattached.txt"), "reattached\n");
  await git(started.session.worktree_path, ["add", "reattached.txt"]);
  await git(started.session.worktree_path, ["commit", "-m", "add reattached work"]);

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: "ses_done_new_session", timestamp: "20260609T030303" }));

  assert.equal(result.ok, true);
  assert.equal(result.lane, "session-finish");
  assert.equal(result.status, "planned");
  assert.equal(result.action, "reattach-and-finish");
  assert.equal(result.reattached, true);
  assert.equal(result.sessionId, "ses_done_new_session");
  assert.equal(result.worktree, started.session.worktree_path);
  assert.equal(result.nextAction, "guardian_done mode=apply confirm=true");
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.activeSessions.some((session: LooseRecord) => session.session_id === "ses_done_lost_original"), true);
  assert.equal(status.sessions.some((session: LooseRecord) => session.session_id === "ses_done_new_session"), false);
  assert.equal(status.terminalSessions.some((session: LooseRecord) => session.session_id === "ses_done_lost_original" && session.status === "superseded"), false);
  assert.equal(status.safetyRefs.length, 0);
  assert.deepEqual(await guardianRefNames(repo), []);
});

test("guardian_done reattach apply requires confirmation", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_reattach_no_confirm_original", taskName: "reattach no confirm", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(started.session.worktree_path, "reattach-no-confirm.txt"), "reattach no confirm\n");
  await git(started.session.worktree_path, ["add", "reattach-no-confirm.txt"]);
  await git(started.session.worktree_path, ["commit", "-m", "add reattach no confirm work"]);

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: "ses_done_reattach_no_confirm_new", mode: "apply", timestamp: "20260609T031313" }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.lane, "session-finish");
  assert.match(result.reason, /confirm=true/);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.activeSessions.some((session: LooseRecord) => session.session_id === "ses_done_reattach_no_confirm_original"), true);
  assert.equal(status.sessions.some((session: LooseRecord) => session.session_id === "ses_done_reattach_no_confirm_new"), false);
  assert.equal(status.safetyRefs.length, 0);
});

test("guardian_done reattach apply records and finishes after confirmation", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_reattach_apply_original", taskName: "reattach apply", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(started.session.worktree_path, "reattach-apply.txt"), "reattach apply\n");
  await git(started.session.worktree_path, ["add", "reattach-apply.txt"]);
  await git(started.session.worktree_path, ["commit", "-m", "add reattach apply work"]);

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: "ses_done_reattach_apply_new", mode: "apply", confirm: true, timestamp: "20260609T032323" }));

  assert.equal(result.ok, true);
  assert.equal(result.lane, "session-finish");
  assert.equal(result.status, "pr-suggested");
  assert.equal(result.reattached, true);
  assert.equal(result.preflight.sessionId, "ses_done_reattach_apply_new");
  assert.equal(result.preflight.currentWorktree, started.session.worktree_path);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.terminalSessions.some((session: LooseRecord) => session.session_id === "ses_done_reattach_apply_new" && session.status === "preserved"), true);
  assert.equal(status.terminalSessions.some((session: LooseRecord) => session.session_id === "ses_done_reattach_apply_original" && session.status === "superseded"), true);
  assert.equal(status.safetyRefs.length, 1);
});

test("guardian_done blocks protected primary rescue scenarios outside base branch", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await git(repo, ["checkout", "-b", "production"]);
  const config = { ...DEFAULT_CONFIG, protectedBranches: [...DEFAULT_CONFIG.protectedBranches, "production"] };

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", config }));

  assert.equal(result.ok, false);
  assert.equal(result.lane, "primary-rescue-recommended");
  assert.match(result.reason, /rescue it to a Guardian worktree/);
  assert.deepEqual(result.suggestedCommands, ["guardian_start createWorktree=true", "guardian_status"]);
});

test("guardian_done blocks poisoned active session bound to protected primary worktree", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await seedSession(repo, {
    session_id: "ses_done_poisoned_primary",
    status: "active",
    branch: "main",
    worktree_path: repo,
    base_ref: "origin/main",
    safety_refs: [],
  });
  await fs.writeFile(path.join(repo, "poisoned-primary.txt"), "must not publish through session-finish\n", "utf8");

  const result = asDone(await guardianDone({
    repoRoot: repo,
    cwd: repo,
    sessionId: "ses_done_poisoned_primary",
    mode: "apply",
    confirm: true,
    commitMessage: "feat: should not publish poisoned primary",
    config: DEFAULT_CONFIG,
  }));

  assert.equal(result.ok, false);
  assert.equal(result.lane, "poisoned-primary-protected-session");
  assert.match(result.reason, /primary worktree|protected branch/);
  const remoteHead = (await git(repo, ["rev-parse", "origin/main"])).stdout;
  const localHead = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  assert.equal(remoteHead, localHead);
});

test("guardian_done is a no-op after the session was already preserved", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_preserved", taskName: "done preserved", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  await fs.writeFile(path.join(worktree, "feature.txt"), "feature\n");
  await git(worktree, ["add", "feature.txt"]);
  await git(worktree, ["commit", "-m", "complete feature"]);
  const finished = await guardianFinish({ repoRoot: repo, cwd: worktree, sessionId: "ses_done_preserved", finishMode: "preserve-only", config: DEFAULT_CONFIG });
  assert.equal(finished.status, "preserved");
  const { stdout: head } = await git(worktree, ["rev-parse", "HEAD"]);

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: worktree }));

  assert.equal(result.ok, true);
  assert.equal(result.status, "no-op");
  assert.equal(result.lane, "already-preserved");
  assert.equal(result.branch, started.session.branch);
  assert.equal(result.commit, head);
  assert.equal(result.safetyRef, finished.safetyRef);
  assert.match(result.safetyRef, /^refs\/opencode-guardian\//);
});

test("guardian_done no-op keeps user-kept untracked notes without implying the preserved commit is unsafe", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_preserved_notes", taskName: "done preserved notes", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  await fs.writeFile(path.join(worktree, "feature.txt"), "feature\n");
  await git(worktree, ["add", "feature.txt"]);
  await git(worktree, ["commit", "-m", "complete feature"]);
  const finished = await guardianFinish({ repoRoot: repo, cwd: worktree, sessionId: "ses_done_preserved_notes", finishMode: "preserve-only", config: DEFAULT_CONFIG });
  assert.equal(finished.status, "preserved");
  await fs.mkdir(path.join(worktree, ".omo"), { recursive: true });
  await fs.writeFile(path.join(worktree, ".omo", "notepad.md"), "kept notes\n");
  await fs.writeFile(path.join(worktree, ".omo", "plan.md"), "kept plan\n");

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: worktree, sessionId: "ses_done_preserved_notes" }));

  assert.equal(result.ok, true);
  assert.equal(result.status, "no-op");
  assert.equal(result.lane, "already-preserved");
  assert.equal(result.safetyRef, finished.safetyRef);
  assert.equal(result.localUntrackedFileCount, 2);
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
  assert.match(result.reason, /commitMessage/);
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
  assert.match(result.reason, /no active Guardian session owns branch/);
  const sessions = result.availableSessions as readonly { branch: string }[];
  assert.ok(sessions.some((session) => session.branch === a.session.branch));
});
