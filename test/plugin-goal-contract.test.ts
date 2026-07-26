import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import plugin from "../src/index.ts";
import { formatGuardianOutput } from "../src/plugin/readable-output.ts";
import { guardianStart } from "../src/start.ts";
import { isRecordLike } from "../src/types.ts";
import { createToolContext, metadataRecords, runTool } from "./plugin-contract-helpers.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(`${name} must be a non-empty string`);
}

test("guardian_goal tool plans configured repo goal with readable output", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "goal-stashed.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "goal contract stash"]);
  await fs.mkdir(path.join(repo, "node-compile-cache"), { recursive: true });
  await fs.writeFile(path.join(repo, "node-compile-cache", "cache.bin"), "cache\n");
  await fs.writeFile(path.join(repo, "goal-code.txt"), "goal\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context, metadataCalls } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_goal.execute;

  const result = await runTool(execute, { repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: goal contract" }, context);

  assert.equal(typeof result.output, "string");
  assert.equal(result.metadata.status, "planned");
  assert.equal(result.metadata.lane, "goal");
  assert.equal(typeof result.metadata.confirmToken, "string");
  assert.deepEqual(metadataCalls, [{ title: "guardian_goal" }]);
  assert.match(result.output, /guardian_goal planned/);
  assert.match(result.output, /guardian_hygiene/);
  assert.match(result.output, /guardian_done/);
  assert.match(result.output, /\[WARN\] repository stash inventory: 1/);
  assert.match(result.output, /commitDirty=true/);
  assert.doesNotMatch(result.output, /confirmToken:/);
  const steps = metadataRecords(result.metadata, "steps");
  assert.deepEqual(steps.map((step) => step.tool), ["guardian_hygiene", "guardian_done"]);
  const doneResult = requireRecord(steps.find((step) => step.tool === "guardian_done")?.result, "guardian_done step result");
  const donePreflight = requireRecord(doneResult.preflight, "guardian_done preflight");
  assert.equal(donePreflight.stashCount, 1);
});

test("guardian_goal promotes strict stash inventory blockers from guardian_done", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({ requireEmptyStashInventory: true }));
  await git(repo, ["add", ".opencode/worktree-guardian.json"]);
  await git(repo, ["commit", "-m", "configure strict stash inventory"]);
  await git(repo, ["push", "origin", "main"]);
  await fs.writeFile(path.join(repo, "goal-stashed-strict.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "strict goal stash"]);
  await fs.writeFile(path.join(repo, "goal-code.txt"), "goal\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;

  const result = await runTool(hooks.tool.guardian_goal.execute, { repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: strict goal contract" }, context);

  assert.equal(result.metadata.ok, false);
  assert.equal(result.metadata.status, "blocked");
  assert.match(String(result.metadata.reason), /guardian_goal plan has blockers/);
  const blockers = metadataRecords(result.metadata, "blockers");
  assert.equal(blockers.some((blocker) => String(blocker.reason).includes("stash inventory")), true);
});

test("guardian_goal applies safe hygiene before committing primary work", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, "node-compile-cache"), { recursive: true });
  await fs.writeFile(path.join(repo, "node-compile-cache", "cache.bin"), "cache\n");
  await fs.writeFile(path.join(repo, "goal-code.txt"), "goal\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_goal.execute;

  const plan = await runTool(execute, { repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: goal apply" }, context);
  const apply = await runTool(execute, { repoRoot: repo, cwd: repo, mode: "apply", commitMessage: "feat: goal apply", confirm: true, confirmToken: "" }, context);

  assert.equal(plan.metadata.status, "planned");
  assert.equal(apply.metadata.status, "complete");
  assert.equal(await fs.access(path.join(repo, "node-compile-cache")).then(() => true, () => false), false);
  const { stdout: remoteMain } = await git(repo, ["rev-parse", "origin/main"]);
  assert.equal(remoteMain, apply.metadata.commit);
  const { stdout: committedFiles } = await git(repo, ["show", "--name-only", "--format=", String(apply.metadata.commit)]);
  assert.match(committedFiles, /goal-code\.txt/);
  assert.doesNotMatch(committedFiles, /node-compile-cache/);
});

test("guardian_goal delegates already-landed redundant dirty session cleanup without commitMessage", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_goal_redundant_dirty", taskName: "goal redundant dirty", createWorktree: true });
  const session = requireRecord(started.session, "started.session");
  const branch = requireString(session.branch, "started.session.branch");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const featureFile = "goal-redundant-dirty.txt";
  await fs.writeFile(path.join(worktree, featureFile), "landed content\n");
  await git(worktree, ["add", featureFile]);
  await git(worktree, ["commit", "-m", "add goal redundant dirty fixture"]);
  await git(repo, ["merge", "--no-ff", branch, "-m", "merge goal redundant dirty fixture"]);
  await git(repo, ["push", "origin", "main"]);
  await fs.writeFile(path.join(repo, featureFile), "advanced base content\n");
  await git(repo, ["add", featureFile]);
  await git(repo, ["commit", "-m", "advance goal redundant dirty base"]);
  await git(repo, ["push", "origin", "main"]);
  await fs.writeFile(path.join(worktree, featureFile), "advanced base content\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;

  const result = await runTool(hooks.tool.guardian_goal.execute, { repoRoot: repo, cwd: repo, mode: "plan" }, context);

  assert.equal(result.metadata.ok, true, JSON.stringify(result.metadata));
  assert.equal(result.metadata.status, "planned");
  assert.doesNotMatch(result.output, /commitMessage is required/);
  const steps = metadataRecords(result.metadata, "steps");
  const doneStep = steps.find((step) => step.tool === "guardian_done");
  const doneResult = requireRecord(doneStep?.result, "guardian_done step result");
  assert.equal(doneStep?.ok, true);
  assert.equal(doneResult.action, "already-landed-clean");
  assert.equal(doneResult.branch, branch);
  assert.equal(doneResult.worktreePath, worktree);
  assert.deepEqual(doneResult.dirtyFiles, [featureFile]);
});

test("guardian_goal readable output summarizes blockers", () => {
  const output = formatGuardianOutput("guardian_goal", {
    ok: false,
    status: "blocked",
    lane: "goal",
    goal: { commitDirty: true, landToBase: true, pushBase: true, cleanupWorktrees: true, cleanupBranches: true, cleanupHygiene: true },
    steps: [
      { tool: "guardian_hygiene", status: "noop", ok: true, reason: "no approved hygiene cleanup targets" },
      { tool: "guardian_done", status: "blocked", ok: false, reason: "commitMessage is required" },
    ],
    blockers: [{ tool: "guardian_done", reason: "commitMessage is required" }],
  });

  assert.match(output, /^\[FAIL\] guardian_goal blocked/);
  assert.match(output, /blockers: 1/);
  assert.match(output, /guardian_done: commitMessage is required/);
});

test("guardian_goal readable output warns about done-all stash inventory", () => {
  const output = formatGuardianOutput("guardian_goal", {
    ok: true,
    status: "planned",
    lane: "goal",
    goal: { commitDirty: true, landToBase: true, pushBase: true, cleanupWorktrees: true, cleanupBranches: true, cleanupHygiene: true },
    steps: [
      { tool: "guardian_hygiene", status: "noop", ok: true },
      { tool: "guardian_done", status: "planned", ok: true, result: { lane: "done-all", cleanupPlan: { preflight: { stashCount: 1 } } } },
    ],
    blockers: [],
  });

  assert.match(output, /\[WARN\] repository stash inventory: 1/);
});

test("guardian_goal readable output warns about completed done-all stash inventory", () => {
  const output = formatGuardianOutput("guardian_goal", {
    ok: true,
    status: "complete",
    lane: "goal",
    goal: { commitDirty: true, landToBase: true, pushBase: true, cleanupWorktrees: true, cleanupBranches: true, cleanupHygiene: true },
    steps: [
      { tool: "guardian_hygiene", status: "noop", ok: true },
      { tool: "guardian_done", status: "finished", ok: true, result: { lane: "done-all", stashCount: 1, stashes: [{ name: "stash@{0}" }] } },
    ],
    blockers: [],
  });

  assert.match(output, /\[WARN\] repository stash inventory: 1/);
});
