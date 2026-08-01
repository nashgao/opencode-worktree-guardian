import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { guardianDoneAll } from "../src/done-all.ts";
import { guardianDeleteWorktree } from "../src/delete.ts";
import { guardianFinish } from "../src/finish.ts";
import { createSafetyRef, getHeadCommit } from "../src/git.ts";
import { formatGuardianOutput } from "../src/plugin/readable-output.ts";
import { guardianPreserve } from "../src/preserve.ts";
import { guardianStatus } from "../src/recover.ts";
import { guardianStart } from "../src/start.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepo, createRepoWithOrigin, git, makeBranchCommit, seedSession } from "./helpers.ts";
import { installFakeGh } from "./delete-fixtures.ts";

const execFileAsync = promisify(execFile);
const ownedRoots: string[] = [];

test.after(async () => {
  const remaining = await Promise.all(ownedRoots.map((root) => fs.access(root).then(() => root, () => null)));
  assert.deepEqual(remaining.filter((root): root is string => root !== null), []);
});

type LooseRecord = Record<string, unknown>;
type DoneResult = LooseRecord & {
  readonly lane?: string;
  readonly nextAction: string;
  readonly preflight: { readonly stashCount?: unknown; readonly stashes?: unknown };
  readonly reason: string;
  readonly status?: string;
};

function asDone(result: LooseRecord): DoneResult {
  return result as DoneResult;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(`${name} must be a non-empty string`);
}

async function gitBlobBytes(repo: string, commit: string, filePath: string): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["-C", repo, "show", `${commit}:${filePath}`], { encoding: "buffer" });
  return stdout;
}

async function guardianRefNames(repo: string) {
  const { stdout } = await git(repo, ["for-each-ref", "--format=%(refname)", "refs/opencode-guardian"]);
  return stdout.length === 0 ? [] : stdout.split("\n");
}

async function recordCurrentSession(repo: string, sessionId: string, branch: string, config: LooseRecord = DEFAULT_CONFIG) {
  const { stdout: commit } = await git(repo, ["rev-parse", "HEAD"]);
  await seedSession(repo, {
    session_id: sessionId,
    status: "active",
    branch,
    worktree_path: repo,
    base_ref: `${config.remote}/${config.baseBranch}`,
    head_commit: commit,
    safety_refs: [],
  }, config);
}

async function makeMergedCleanupCandidate(repo: string) {
  const branch = "guardian/done-cleanup";
  await git(repo, ["checkout", "-b", branch]); await fs.writeFile(path.join(repo, "done-cleanup.txt"), "cleanup\n"); await git(repo, ["add", "done-cleanup.txt"]);
  await git(repo, ["commit", "-m", "add done cleanup"]); await git(repo, ["checkout", "main"]); await git(repo, ["merge", "--no-ff", branch, "-m", "merge done cleanup"]); await git(repo, ["push", "origin", "main"]);
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), "done-cleanup-worktree"); await git(repo, ["worktree", "add", worktreePath, branch]); return { branch, worktreePath };
}

async function primaryPublishState(repo: string, dirtyFile: string, cleanupCandidate: { readonly branch: string; readonly worktreePath: string }) {
  const indexTree = await git(repo, ["write-tree"]);
  const [status, index, refs, remoteTrackingRefs, reflog, safetyRefs, head, branch, originMain, remoteMain, worktrees, candidateHead, objects, fetchHead, state, present] = await Promise.all([
    git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]), git(repo, ["ls-files", "--stage"]), git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]), git(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes"]), git(repo, ["reflog", "show", "--all", "--format=%gD %H"]), git(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/opencode-guardian"]), git(repo, ["rev-parse", "HEAD"]), git(repo, ["branch", "--show-current"]), git(repo, ["rev-parse", "origin/main"]), git(repo, ["ls-remote", "--heads", "origin", "main"]), git(repo, ["worktree", "list", "--porcelain"]), git(repo, ["rev-parse", cleanupCandidate.branch]), git(repo, ["count-objects", "-v"]), fs.readFile(path.join(repo, ".git", "FETCH_HEAD"), "utf8").catch(() => "<absent>"), fs.readFile(path.join(repo, ".git", "opencode-guardian", "state.json"), "utf8").catch(() => "<absent>"), fs.access(cleanupCandidate.worktreePath).then(() => true, () => false),
  ]);
  const dirtyFileHash = crypto.createHash("sha256").update(await fs.readFile(path.join(repo, dirtyFile))).digest("hex");
  return { status: status.stdout, dirtyFileHash, indexTree: indexTree.stdout, index: index.stdout, refs: refs.stdout, remoteTrackingRefs: remoteTrackingRefs.stdout, reflog: reflog.stdout, safetyRefs: safetyRefs.stdout, head: head.stdout, branch: branch.stdout, originMain: originMain.stdout, remoteMain: remoteMain.stdout, worktrees: worktrees.stdout, objects: objects.stdout, fetchHead, state, cleanupCandidate: { branch: cleanupCandidate.branch, head: candidateHead.stdout, worktreePath: cleanupCandidate.worktreePath, present } };
}

test("guardian_done blocks matching dirty primary-main tokens without confirmation before any publish mutation", async (t) => {
  const { base, remote, repo } = await createRepoWithOrigin(); t.after(() => fs.rm(base, { recursive: true, force: true })); const cleanupCandidate = await makeMergedCleanupCandidate(repo); const dirtyFile = "done-no-confirm.txt";
  await fs.writeFile(path.join(repo, dirtyFile), "must remain dirty\n"); const plan = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: require confirmation" }));
  await git(remote, ["config", "user.name", "Remote Test"]); await git(remote, ["config", "user.email", "remote@example.test"]); const { stdout: remoteAdvance } = await git(remote, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "advance remote main"]); await git(remote, ["update-ref", "refs/heads/main", remoteAdvance]); const before = await primaryPublishState(repo, dirtyFile, cleanupCandidate);
  const apply = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "apply", commitMessage: "feat: require confirmation", confirmToken: plan.confirmToken, timestamp: "20260730T080808" }));
  assert.equal(apply.ok, false); assert.equal(apply.status, "blocked"); assert.equal(apply.tokenMatched, true); assert.equal(apply.confirmationRequired, true); assert.equal(apply.remoteRefresh, "forbidden"); assert.equal(apply.remoteFreshness, "unverified"); assert.match(apply.reason, /confirm=true/); assert.match(apply.nextAction, /confirm=true/); assert.deepEqual(await primaryPublishState(repo, dirtyFile, cleanupCandidate), before);
  const confirmed = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, commitMessage: "feat: require confirmation", confirmToken: plan.confirmToken, timestamp: "20260730T080808" }));
  assert.equal(confirmed.ok, false); assert.equal(confirmed.status, "blocked"); assert.equal(confirmed.tokenMatched, false); assert.equal(confirmed.driftDetected, true); assert.equal(confirmed.remoteRefresh, "required"); assert.equal(confirmed.plannedConfirmToken, plan.confirmToken); assert.equal(typeof confirmed.refreshedConfirmToken, "string"); assert.notEqual(confirmed.refreshedConfirmToken, plan.confirmToken);
  const afterConfirmed = await primaryPublishState(repo, dirtyFile, cleanupCandidate); assert.deepEqual({ ...afterConfirmed, refs: before.refs, remoteTrackingRefs: before.remoteTrackingRefs, reflog: before.reflog, originMain: before.originMain, objects: before.objects, fetchHead: before.fetchHead }, before);
});

test("guardian_done done-all apply retains advisory stash inventory", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "done-all-stashed.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "done-all advisory stash"]);

  const plan = await guardianDoneAll({ repoRoot: repo, cwd: repo, mode: "plan", config: DEFAULT_CONFIG });
  const apply = await guardianDoneAll({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG });

  assert.equal(plan.ok, true);
  assert.equal(apply.ok, true);
  assert.equal(apply.lane, "done-all");
  assert.equal(apply.stashCount, 1);
  assert.equal(Array.isArray(apply.stashes) ? apply.stashes.length : 0, 1);
  assert.match(formatGuardianOutput("guardian_done", apply), /\[WARN\] repository stash inventory: 1/);
});

test("guardian_done primary publish reports stash inventory without blocking by default", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "done-stashed.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "done publish stash"]);
  await fs.writeFile(path.join(repo, "done-feature.txt"), "feature\n");

  const plan = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: done feature" }));

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.lane, "primary-main-publish");
  assert.equal(plan.preflight.stashCount, 1);
  assert.equal(Array.isArray(plan.preflight.stashes) ? plan.preflight.stashes.length : 0, 1);
});

test("guardian_done primary publish blocks stash inventory under strict policy", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "done-stashed-strict.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "strict done publish stash"]);
  await fs.writeFile(path.join(repo, "done-feature.txt"), "feature\n");
  const config = { ...DEFAULT_CONFIG, requireEmptyStashInventory: true };

  const plan = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: done feature", config }));

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.match(plan.reason, /stash inventory/);
  assert.equal(plan.preflight.stashCount, 1);
});

test("preserve-only finish reports stash inventory without blocking by default", async () => {
  const repo = await createRepo();
  const config: LooseRecord = { ...DEFAULT_CONFIG, finishMode: "preserve-only" };
  const { branch } = await makeBranchCommit(repo, "guardian/preserve-stash");
  await recordCurrentSession(repo, "ses_preserve_stash", branch, config);
  await fs.writeFile(path.join(repo, "preserve-stash.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "preserve stash"]);

  const result = await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "ses_preserve_stash", config, mode: "plan" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "planned");
  assert.equal(result.preflight.stashCount, 1);
  assert.equal(Array.isArray(result.preflight.stashes) ? result.preflight.stashes.length : 0, 1);
});

test("preserve-only finish blocks stash inventory under strict policy", async () => {
  const repo = await createRepo();
  const config: LooseRecord = { ...DEFAULT_CONFIG, finishMode: "preserve-only", requireEmptyStashInventory: true };
  const { branch } = await makeBranchCommit(repo, "guardian/preserve-stash-strict");
  await recordCurrentSession(repo, "ses_preserve_stash_strict", branch, config);
  await fs.writeFile(path.join(repo, "preserve-stash-strict.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "strict preserve stash"]);

  const result = await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "ses_preserve_stash_strict", config, mode: "plan" });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(String(result.reason), /stash inventory/);
  assert.equal(result.preflight.stashCount, 1);
});

test("reference transaction hook blocks preserve, finish, direct deletion, rescue, and safety refs before side effects", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  ownedRoots.push(base);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "hook-public-ops", taskName: "hook-public-ops", createWorktree: true, config: DEFAULT_CONFIG });
  assert.equal(started.ok, true, JSON.stringify(started));
  const worktree = started.session.worktree_path;
  const marker = path.join(base, "public-hook-ran");
  const head = await getHeadCommit(worktree);
  const plan = await guardianDeleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "hook-public-ops", config: DEFAULT_CONFIG });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const hooks = path.join(repo, "reference-transaction-hooks");
  await fs.mkdir(hooks, { recursive: true });
  await fs.writeFile(path.join(hooks, "reference-transaction"), `#!/bin/sh\nprintf hook > ${JSON.stringify(marker)}\n`, "utf8");
  await fs.chmod(path.join(hooks, "reference-transaction"), 0o755);
  await git(worktree, ["config", "core.hooksPath", hooks]);

  const preserve = await guardianPreserve({ repoRoot: repo, cwd: worktree, sessionId: "hook-public-ops", timestamp: "20260729T010101", config: DEFAULT_CONFIG });
  assert.equal(preserve.ok, false, JSON.stringify(preserve));
  const deleted = await guardianDeleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId: "hook-public-ops", confirmToken: plan.confirmToken, config: DEFAULT_CONFIG });
  assert.equal(deleted.ok, false, JSON.stringify(deleted));
  const finished = await guardianFinish({ repoRoot: repo, cwd: worktree, sessionId: "hook-public-ops", config: DEFAULT_CONFIG });
  assert.equal(finished.ok, false, JSON.stringify(finished));
  await assert.rejects(createSafetyRef(repo, { sessionId: "hook-public-ops", branch: started.session.branch, commit: head }));
  await fs.writeFile(path.join(worktree, "rescue.txt"), "dirty\n", "utf8");
  const rescued = await guardianDone({ repoRoot: repo, cwd: worktree, rescue: true, config: DEFAULT_CONFIG });
  assert.equal(rescued.ok, false, JSON.stringify(rescued));

  await assert.rejects(fs.access(marker));
  assert.equal((await git(repo, ["worktree", "list", "--porcelain"])).stdout.includes(worktree), true);
  assert.equal((await git(repo, ["rev-parse", started.session.branch])).stdout, head);
});

test("guardian_done retries a dirty tracked-ignored commit after a transient post-safety-ref failure", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "land-clean-retry-after-safety-ref";
  const timestamp = "2026-07-29T00:00:00.000Z";
  const trackedPath = ".claude/stats/commits.json";
  const trackedFile = path.join(repo, trackedPath);
  await fs.mkdir(path.dirname(trackedFile), { recursive: true });
  await fs.writeFile(trackedFile, "{\"commits\":[]}\n", "utf8");
  await git(repo, ["add", trackedPath]);
  await git(repo, ["commit", "-m", "track retry stats fixture"]);
  await fs.writeFile(path.join(repo, ".gitignore"), ".claude/\n", "utf8");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore retry stats fixture"]);
  await git(repo, ["push", "origin", "main"]);
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "retry tracked ignored", createWorktree: true, config: DEFAULT_CONFIG });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");
  const worktreeTrackedFile = path.join(worktree, trackedPath);
  await fs.writeFile(worktreeTrackedFile, "{\"commits\":[\"retry\"]}\n", "utf8");
  const approvedBytes = await fs.readFile(worktreeTrackedFile);
  const fakeGh = await installFakeGh(t, { repo, branch, dynamicHead: true });
  const request = { repoRoot: repo, cwd: worktree, sessionId, commitMessage: "fix: retry tracked ignored commit", timestamp, config: DEFAULT_CONFIG };
  const firstPlan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "firstPlan");
  const oldHead = (await git(worktree, ["rev-parse", "HEAD"])).stdout;

  // When
  const firstApply = await guardianDone(
    { ...request, mode: "apply", confirm: true, confirmToken: requireString(firstPlan.confirmToken, "firstPlan.confirmToken") },
    { commitTransactionHooks: { afterSafetyRefCreated: async () => { throw new Error("transient post-safety-ref failure"); } } },
  );
  assert.equal(firstApply.ok, false, JSON.stringify(firstApply));
  assert.equal(firstApply.status, "blocked");
  assert.equal(requireString(firstApply.safetyRef, "firstApply.safetyRef"), requireString(firstPlan.safetyRef, "firstPlan.safetyRef"));
  assert.equal((await git(worktree, ["rev-parse", "HEAD"])).stdout, oldHead);
  const retryPlan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "retryPlan");
  const retry = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(retryPlan.confirmToken, "retryPlan.confirmToken") });

  // Then
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.commitSafetyRefDisposition, "reused");
  const commit = requireString(retry.commit, "retry.commit");
  assert.deepEqual(await gitBlobBytes(repo, commit, trackedPath), approvedBytes);
  await git(repo, ["fetch", "origin", "main"]);
  await git(repo, ["merge-base", "--is-ancestor", commit, "origin/main"]);
  assert.equal(await fs.access(fakeGh.logPath).then(() => true, () => false), true);
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
