import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import plugin from "../src/index.ts";
import { createToolContext, runTool } from "./plugin-contract-helpers.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

test("guardian_goal adapter cache normalizes intentionalPaths across plan and apply", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, "src"));
  await fs.writeFile(path.join(repo, "src", "a.ts"), "export const a = true;\n");
  await fs.writeFile(path.join(repo, "src", "b.ts"), "export const b = true;\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const request = { repoRoot: repo, cwd: repo, commitMessage: "feat: acknowledged sources" };

  const plan = await runTool(hooks.tool.guardian_goal.execute, {
    ...request,
    mode: "plan",
    intentionalPaths: ["src/b.ts", "src/a.ts", "src/b.ts"],
  }, context);
  const applied = await runTool(hooks.tool.guardian_goal.execute, {
    ...request,
    mode: "apply",
    confirm: true,
    confirmToken: "",
    intentionalPaths: ["src/a.ts", "src/b.ts"],
  }, context);

  assert.equal(plan.metadata.status, "planned");
  assert.equal(applied.metadata.complete, true, JSON.stringify(applied.metadata));
  assert.deepEqual(applied.metadata.intentionalPaths, ["src/a.ts", "src/b.ts"]);
  const committedFiles = (await git(repo, ["show", "--name-only", "--format=", "origin/main"])).stdout;
  assert.match(committedFiles, /src\/a\.ts/);
  assert.match(committedFiles, /src\/b\.ts/);
});

test("guardian_goal adapter cache rejects intentionalPaths drift before mutation", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, "src"));
  await fs.writeFile(path.join(repo, "src", "a.ts"), "export const a = true;\n");
  await fs.writeFile(path.join(repo, "src", "b.ts"), "export const b = true;\n");
  const before = (await git(repo, ["rev-parse", "origin/main"])).stdout;
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const request = { repoRoot: repo, cwd: repo, commitMessage: "feat: reject intent drift" };

  await runTool(hooks.tool.guardian_goal.execute, { ...request, mode: "plan", intentionalPaths: ["src/a.ts"] }, context);
  const applied = await runTool(hooks.tool.guardian_goal.execute, {
    ...request,
    mode: "apply",
    confirm: true,
    confirmToken: "",
    intentionalPaths: ["src/b.ts"],
  }, context);

  assert.equal(applied.metadata.status, "blocked");
  assert.equal(applied.metadata.tokenMatched, false);
  assert.equal((await git(repo, ["rev-parse", "origin/main"])).stdout, before);
  assert.equal(await fs.access(path.join(repo, "src", "a.ts")).then(() => true, () => false), true);
});

test("guardian_goal rejects acknowledged file content drift before mutation", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, "src"));
  const source = path.join(repo, "src", "a.ts");
  await fs.writeFile(source, "export const a = true;\n");
  const before = (await git(repo, ["rev-parse", "origin/main"])).stdout;
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const request = { repoRoot: repo, cwd: repo, commitMessage: "feat: reject acknowledged content drift", intentionalPaths: ["src/a.ts"] };

  await runTool(hooks.tool.guardian_goal.execute, { ...request, mode: "plan" }, context);
  await fs.writeFile(source, "export const a = 'changed after plan';\n");
  const applied = await runTool(hooks.tool.guardian_goal.execute, {
    ...request,
    mode: "apply",
    confirm: true,
    confirmToken: "",
  }, context);

  assert.equal(applied.metadata.status, "blocked", JSON.stringify(applied.metadata));
  assert.equal(applied.metadata.tokenMatched, false);
  assert.equal((await git(repo, ["rev-parse", "origin/main"])).stdout, before);
  assert.match(await fs.readFile(source, "utf8"), /changed after plan/);
});

test("guardian_goal rejects broad intentional directory acknowledgments", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, "src"));
  await fs.writeFile(path.join(repo, "src", "a.ts"), "export const a = true;\n");

  const plan = await runTool((await plugin.server({ directory: repo, worktree: repo })).tool.guardian_goal.execute, {
    repoRoot: repo,
    cwd: repo,
    mode: "plan",
    commitMessage: "feat: reject directory intent",
    intentionalPaths: ["src"],
  }, createToolContext().context);

  assert.equal(plan.metadata.status, "blocked", JSON.stringify(plan.metadata));
  assert.match(String(plan.metadata.reason), /regular untracked files/);
  assert.equal(plan.metadata.confirmToken, undefined);
});
