import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import plugin from "../src/index.ts";
import { createToolContext, runTool } from "./plugin-contract-helpers.ts";

test("guardian_done tool execute returns readable primary-main plan output with raw metadata", async () => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const path = await import("node:path");
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "contract-done.txt"), "done\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context, metadataCalls } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_done.execute;

  const result = await runTool(execute, { repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: contract done" }, context);

  assert.equal(typeof result.output, "string");
  assert.equal(typeof result.metadata, "object");
  assert.equal(result.metadata.status, "planned");
  assert.equal(result.metadata.lane, "primary-main-publish");
  assert.deepEqual(metadataCalls, [{ title: "guardian_done" }]);
  assert.match(result.output, /guardian_done planned/);
  assert.match(result.output, /lane: primary-main-publish/);
  assert.match(result.output, /commitMessage: feat: contract done/);
  assert.match(result.output, /confirm=true/);
  assert.doesNotMatch(result.output, /confirmToken|sessionId/);
  assert.equal(typeof result.metadata.confirmToken, "string");
  assert.match(result.output, /contract-done.txt/);
});

test("guardian_done plugin confirm reuses matching plan token for primary publish", async () => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const path = await import("node:path");
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "contract-confirm-done.txt"), "done\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_done.execute;

  const plan = await runTool(execute, { repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: contract confirm done" }, context);
  const apply = await runTool(execute, { repoRoot: repo, cwd: repo, mode: "apply", commitMessage: "feat: contract confirm done", confirm: true, confirmToken: "" }, context);

  assert.equal(plan.metadata.status, "planned");
  assert.equal(apply.metadata.status, "published");
  assert.equal(apply.metadata.lane, "primary-main-publish");
  const { git } = await import("./helpers.ts");
  const { stdout: remoteMain } = await git(repo, ["rev-parse", "origin/main"]);
  assert.equal(remoteMain, apply.metadata.commit);
});

test("guardian_done tool execute treats empty optional strings as absent", async () => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const path = await import("node:path");
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "contract-empty-args.txt"), "done\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  context.sessionID = "ses_empty_optional";
  const execute = hooks.tool.guardian_done.execute;

  const result = await runTool(execute, {
    repoRoot: "",
    cwd: "",
    sessionId: "",
    branch: "",
    targetPath: "",
    worktreePath: "",
    confirmToken: "",
    mode: "plan",
    cleanupPaths: [],
    allowCategories: [],
    commitMessage: "feat: empty optional args",
  }, context);

  assert.equal(result.metadata.status, "planned");
  assert.equal(result.metadata.lane, "primary-main-publish");
  assert.equal(result.metadata.preflight.repoRoot, repo);
  assert.equal(result.metadata.preflight.currentWorktree, repo);
  assert.doesNotMatch(result.output, /confirmToken|sessionId/);
});
