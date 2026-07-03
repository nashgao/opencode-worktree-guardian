import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import plugin from "../src/index.ts";
import { formatGuardianOutput } from "../src/plugin/readable-output.ts";
import { createToolContext, metadataRecords, runTool } from "./plugin-contract-helpers.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

test("guardian_goal tool plans configured repo goal with readable output", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
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
  assert.match(result.output, /commitDirty=true/);
  assert.doesNotMatch(result.output, /confirmToken:/);
  const steps = metadataRecords(result.metadata, "steps");
  assert.deepEqual(steps.map((step) => step.tool), ["guardian_hygiene", "guardian_done"]);
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
