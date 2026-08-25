import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { guardianGoal } from "../src/goal.ts";
import plugin from "../src/index.ts";
import { isRecordLike } from "../src/types.ts";
import { installFakeGh } from "./delete-fixtures.ts";
import { createRepoWithOrigin, git, makeAlreadyLandedDirtySession, rescueMutationSurface } from "./helpers.ts";
import { createToolContext, runTool } from "./plugin-contract-helpers.ts";
import { branchExists, createMergedBranch } from "./workflow-test-support.js";

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(`${name} must be a non-empty string`);
}

function goalRecords(value: unknown, key: string): Array<Record<string, unknown>> {
  const record = requireRecord(value, "guardian_goal result");
  const entries = record[key];
  return Array.isArray(entries) ? entries.filter(isRecordLike) : [];
}

test("guardian_done remote drift rejects no-message redundant-dirty cleanup after fetch", async (t) => {
  const fixture = await makeAlreadyLandedDirtySession("ses_done_redundant_dirty_remote_drift");
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const fakeGh = await installFakeGh(t, { repo: fixture.repo, branch: fixture.branch });
  const request = { repoRoot: fixture.repo, cwd: fixture.worktree, sessionId: fixture.sessionId, timestamp: "20260731T100100", config: DEFAULT_CONFIG };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");
  const updater = path.join(fixture.base, "remote-base-updater");
  await git(fixture.base, ["clone", fixture.remote, updater]);
  await git(updater, ["config", "user.email", "guardian@example.test"]);
  await git(updater, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(updater, "remote-base-drift.txt"), "remote advance\n", "utf8");
  await git(updater, ["add", "remote-base-drift.txt"]);
  await git(updater, ["commit", "-m", "advance remote base after guardian_done plan"]);
  await git(updater, ["push", "origin", "main"]);
  const before = await rescueMutationSurface(fixture.repo);

  const result = requireRecord(await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") }), "result");

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.match(requireString(result.reason, "result.reason"), /plan changed/);
  const after = await rescueMutationSurface(fixture.repo);
  assert.notDeepEqual(after.fetchHead, before.fetchHead);
  assert.deepEqual(
    { branch: after.branch, files: after.files, head: after.head, index: after.index, indexLock: after.indexLock, state: after.state, status: after.status, unreachable: after.unreachable, worktrees: after.worktrees },
    { branch: before.branch, files: before.files, head: before.head, index: before.index, indexLock: before.indexLock, state: before.state, status: before.status, unreachable: before.unreachable, worktrees: before.worktrees },
  );
  assert.equal(await fs.access(fakeGh.logPath).then(() => true, () => false), false);
  assert.equal(await fs.access(fixture.worktree).then(() => true, () => false), true);
  await git(fixture.repo, ["rev-parse", "--verify", `refs/heads/${fixture.branch}`]);
});

test("guardian_goal delegates a cleanup-only goal to the finish-workflow lane", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const result = await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config: { ...DEFAULT_CONFIG, goal: { commitDirty: false, landToBase: false, pushBase: false, cleanupWorktrees: true, cleanupBranches: true, cleanupHygiene: false } } });
  const blockers = goalRecords(result, "blockers");
  assert.equal(blockers.some((blocker) => String(blocker.reason ?? "").includes("can only delegate to guardian_done")), false);
  assert.ok(goalRecords(result, "steps").some((step) => step.tool === "guardian_finish_workflow"));
  assert.equal(requireRecord(result, "guardian_goal result").ok, true);
});

test("guardian_goal completes while retaining an explicitly allowed remote branch", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const retainedBranch = "chore/retained-remote";
  await git(repo, ["checkout", "-b", retainedBranch]);
  await fs.writeFile(path.join(repo, "retained-remote.txt"), "retained\n");
  await git(repo, ["add", "retained-remote.txt"]);
  await git(repo, ["commit", "-m", "add retained remote fixture"]);
  await git(repo, ["push", "origin", retainedBranch]);
  await git(repo, ["checkout", "main"]);
  await git(repo, ["branch", "-D", retainedBranch]);
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const request = { repoRoot: repo, cwd: repo, allowedRemoteBranches: [retainedBranch] };
  const plan = await runTool(hooks.tool.guardian_goal.execute, { ...request, mode: "plan" }, context);
  const applied = await runTool(hooks.tool.guardian_goal.execute, { ...request, mode: "apply", confirm: true, confirmToken: "" }, context);
  assert.equal(plan.metadata.status, "planned", JSON.stringify(plan.metadata));
  assert.equal(applied.metadata.ok, true, JSON.stringify(applied.metadata));
  assert.equal(applied.metadata.status, "complete", JSON.stringify(applied.metadata));
  const { stdout } = await git(repo, ["ls-remote", "--heads", "origin", retainedBranch]);
  assert.match(stdout, new RegExp(`refs/heads/${retainedBranch}$`));
});

test("guardian_goal retains an explicitly allowed merged remote branch", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const retainedBranch = "chore/retained-merged-remote";
  await createMergedBranch(repo, retainedBranch, "retained-merged-remote.txt");
  await git(repo, ["push", "origin", retainedBranch]);
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const request = { repoRoot: repo, cwd: repo, allowedRemoteBranches: [retainedBranch] };
  const plan = await runTool(hooks.tool.guardian_goal.execute, { ...request, mode: "plan" }, context);
  const applied = await runTool(hooks.tool.guardian_goal.execute, { ...request, mode: "apply", confirm: true, confirmToken: "" }, context);
  assert.equal(plan.metadata.status, "planned", JSON.stringify(plan.metadata));
  assert.equal(applied.metadata.status, "complete", JSON.stringify(applied.metadata));
  assert.equal(await branchExists(repo, retainedBranch), false);
  const { stdout } = await git(repo, ["ls-remote", "--heads", "origin", retainedBranch]);
  assert.match(stdout, new RegExp(`refs/heads/${retainedBranch}$`));
});

test("guardian_goal still blocks a partial write goal set", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const result = await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config: { ...DEFAULT_CONFIG, goal: { commitDirty: true, landToBase: false, pushBase: false, cleanupWorktrees: true, cleanupBranches: true, cleanupHygiene: false } } });
  assert.equal(requireRecord(result, "guardian_goal result").ok, false);
  assert.ok(goalRecords(result, "blockers").some((blocker) => String(blocker.reason ?? "").includes("can only delegate to guardian_done")));
});

test("guardian_goal applies a cleanup-only goal through the finish-workflow lane", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "feat/goal-cleanup-only-apply";
  await createMergedBranch(repo, branch, "goal-cleanup-only.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["fetch", "origin"]);
  const config = { ...DEFAULT_CONFIG, goal: { commitDirty: false, landToBase: false, pushBase: false, cleanupWorktrees: true, cleanupBranches: true, cleanupHygiene: false } };
  const plan = requireRecord(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config }), "guardian_goal plan");
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(await branchExists(repo, branch), true);
  const applied = requireRecord(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "confirmToken"), config }), "guardian_goal apply");
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(goalRecords(applied, "steps").find((step) => step.tool === "guardian_finish_workflow")?.status, "applied");
  assert.equal(await branchExists(repo, branch), false);
  const { stdout } = await git(repo, ["ls-remote", "--heads", "origin", branch]);
  assert.equal(stdout, "");
});
