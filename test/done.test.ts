import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { createSafetyRef } from "../src/git.ts";
import { guardianStart } from "../src/tools.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

type LooseRecord = Record<string, unknown>;
type DoneResult = LooseRecord & {
  readonly candidates: readonly { readonly branch?: string; readonly plan?: LooseRecord }[];
  readonly cleanup?: unknown;
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

function requireLooseRecord(value: unknown, name: string): LooseRecord {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
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

test("guardian_done applies dirty primary-main publish, cleans a local candidate, and retains its allowed remote branch", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const candidate = await makeMergedCleanupCandidate(repo);
  await git(repo, ["push", "origin", candidate.branch]);
  await fs.writeFile(path.join(repo, "done-publish.txt"), "publish\n");
  const plan = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: done publish", allowedRemoteBranches: [candidate.branch] }));

  const apply = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, commitMessage: "feat: done publish", confirmToken: plan.confirmToken, timestamp: "20260609T010101", allowedRemoteBranches: [candidate.branch] }));

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
  const { stdout: retainedRemote } = await git(repo, ["ls-remote", "--heads", "origin", candidate.branch]);
  assert.notEqual(retainedRemote, "");
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

  const apply = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, commitMessage: "chore: remove obsolete file", confirmToken: plan.confirmToken, timestamp: "20260609T040404" }));

  assert.equal(apply.ok, true);
  assert.equal(apply.status, "published");
  assert.deepEqual(plan.dirtySnapshot.paths, ["delete-me.txt"]);
  const { stdout: remoteMain } = await git(repo, ["rev-parse", "origin/main"]);
  assert.equal(remoteMain, apply.commit);
  await assert.rejects(() => git(repo, ["cat-file", "-e", "origin/main:delete-me.txt"]));
});

test("guardian_done plans already-landed redundant dirty session cleanup without commitMessage", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_redundant_dirty", taskName: "done redundant dirty", createWorktree: true, config: DEFAULT_CONFIG });
  const branch = String(started.session.branch);
  const worktree = started.session.worktree_path;
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
  await fs.writeFile(path.join(worktree, featureFile), "advanced base content\n");

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", timestamp: "20260609T070707", config: DEFAULT_CONFIG }));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.lane, "session-finish");
  assert.equal(result.status, "planned");
  assert.equal(result.action, "already-landed-clean");
  assert.equal(result.branch, branch);
  assert.equal(result.worktreePath, worktree);
  assert.equal(result.head, head);
  assert.deepEqual(result.dirtyFiles, [featureFile]);
  assert.equal(result.reason, undefined);
  const cleanup = requireLooseRecord(result.cleanup, "result.cleanup");
  assert.equal(cleanup.status, "planned");
  assert.equal(typeof cleanup.confirmToken, "string");
  const preflight = requireLooseRecord(cleanup.preflight, "result.cleanup.preflight");
  assert.equal(preflight.allowRedundantDirtyPaths, true);
  assert.equal(preflight.redundantDirtyFileCount, 1);
  assert.equal(await pathExists(worktree), true);
  assert.deepEqual(await guardianRefNames(repo), []);
  await git(repo, ["merge-base", "--is-ancestor", head, "origin/main"]);
});
