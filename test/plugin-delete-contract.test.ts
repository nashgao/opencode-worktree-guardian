import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import plugin from "../src/index.ts";
import { createToolContext, runTool, targetPaths } from "./plugin-contract-helpers.ts";
import { createRepo } from "./helpers.ts";

test("guardian_delete_paths tool execute returns readable plan output with raw metadata", async () => {
  const path = await import("node:path");
  const repo = await createRepo();
  await fs.writeFile(path.join(repo, "scratch-delete.txt"), "scratch\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context, metadataCalls } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_delete_paths.execute;

  const result = await runTool(execute, { repoRoot: repo, mode: "plan", paths: ["scratch-delete.txt"] }, context);

  assert.equal(typeof result.output, "string");
  assert.equal(typeof result.metadata, "object");
  assert.deepEqual(metadataCalls, [{ title: "guardian_delete_paths" }]);
  assert.equal(result.metadata.status, "planned");
  assert.equal(typeof result.metadata.confirmToken, "string");
  assert.deepEqual(targetPaths(result.metadata), ["scratch-delete.txt"]);
  assert.match(result.output, /guardian_delete_paths planned/);
  assert.match(result.output, /approvedTargets: 1/);
  assert.doesNotMatch(result.output, /confirmToken:/);
});

test("guardian_delete_paths plugin confirmDelete reuses matching plan token and preserves stale safety", async () => {
  const path = await import("node:path");
  const repo = await createRepo();
  await fs.writeFile(path.join(repo, "scratch-cached.txt"), "scratch\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_delete_paths.execute;

  const plan = await runTool(execute, { repoRoot: repo, mode: "plan", paths: ["scratch-cached.txt"] }, context);
  const apply = await runTool(execute, { repoRoot: repo, mode: "apply", paths: ["scratch-cached.txt"], confirmDelete: true }, context);

  assert.equal(plan.metadata.status, "planned");
  assert.equal(apply.metadata.status, "deleted");
  assert.equal(await fs.access(path.join(repo, "scratch-cached.txt")).then(() => true, () => false), false);

  await fs.writeFile(path.join(repo, "scratch-stale.txt"), "original\n");
  const stalePlan = await runTool(execute, { repoRoot: repo, mode: "plan", paths: ["scratch-stale.txt"] }, context);
  await fs.writeFile(path.join(repo, "scratch-stale.txt"), "changed\n");
  const staleApply = await runTool(execute, { repoRoot: repo, mode: "apply", paths: ["scratch-stale.txt"], confirmDelete: true }, context);

  assert.equal(stalePlan.metadata.status, "planned");
  assert.equal(staleApply.metadata.status, "blocked");
  assert.match(String(staleApply.metadata.reason), /confirm token mismatch/);
  assert.equal(await fs.access(path.join(repo, "scratch-stale.txt")).then(() => true, () => false), true);
});

test("guardian_delete_worktree tool execute returns readable plan output with raw metadata", async () => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_contract_delete", taskName: "contract delete", createWorktree: true, config: DEFAULT_CONFIG });
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_delete_worktree.execute;
  const result = await runTool(execute, { repoRoot: repo, cwd: repo, mode: "plan", targetPath: start.session.worktree_path }, context);
  assert.equal(typeof result.output, "string");
  assert.equal(typeof result.metadata, "object");
  assert.equal(result.metadata.status, "planned");
  assert.match(result.output, /guardian_delete_worktree planned/);
  assert.match(result.output, /targetKind: worktree/);
  assert.match(result.output, /worktreeRemoved: false/);
  assert.match(result.output, /confirmToken:/);
});

test("guardian_delete_worktree redundant dirty output exposes proof metadata", async () => {
  const path = await import("node:path");
  const { createRepoWithOrigin, git } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_contract_redundant_dirty", taskName: "contract redundant dirty", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(repo, "README.md"), "contract base\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "contract base change"]);
  await git(repo, ["push", "origin", "main"]);
  await fs.writeFile(path.join(start.session.worktree_path, "README.md"), "contract base\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_delete_worktree.execute;

  const result = await runTool(execute, { repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_contract_redundant_dirty", allowRedundantDirtyPaths: true }, context);

  assert.equal(result.metadata.status, "planned");
  assert.equal(result.metadata.preflight.allowRedundantDirtyPaths, true);
  assert.equal(result.metadata.preflight.redundantDirtyFileCount, 1);
  assert.equal(result.metadata.preflight.baseRef, "origin/main");
  assert.match(result.output, /allowRedundantDirtyPaths: true/);
  assert.match(result.output, /redundantDirtyFileCount: 1/);
  assert.match(result.output, /redundant dirty proofs:/);
  assert.match(result.output, /README\.md/);
});

test("guardian_delete_worktree redundant dirty plans do not auto-inject confirm tokens", async () => {
  const path = await import("node:path");
  const { createRepoWithOrigin, git } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_contract_redundant_dirty_no_cache", taskName: "contract redundant dirty no cache", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(repo, "README.md"), "contract cache base\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "contract cache base change"]);
  await git(repo, ["push", "origin", "main"]);
  await fs.writeFile(path.join(start.session.worktree_path, "README.md"), "contract cache base\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_delete_worktree.execute;

  const plan = await runTool(execute, { repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_contract_redundant_dirty_no_cache", allowRedundantDirtyPaths: true }, context);
  const apply = await runTool(execute, { repoRoot: repo, cwd: repo, mode: "apply", sessionId: "ses_contract_redundant_dirty_no_cache", allowRedundantDirtyPaths: true }, context);

  assert.equal(plan.metadata.status, "planned");
  assert.equal(apply.metadata.status, "blocked");
  assert.match(String(apply.metadata.reason), /confirm token mismatch/);
  assert.equal(await fs.access(start.session.worktree_path).then(() => true, () => false), true);
});

test("guardian_delete_worktree tool execute exposes abandon plan evidence in readable output", async () => {
  const { createRepoWithOrigin, git } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const path = await import("node:path");
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_contract_abandon", taskName: "contract abandon", branch: "guardian/contract-abandon", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(start.session.worktree_path, "feature.txt"), "unmerged\n");
  await git(start.session.worktree_path, ["add", "feature.txt"]);
  await git(start.session.worktree_path, ["commit", "-m", "contract unmerged abandon"]);
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_delete_worktree.execute;

  const result = await runTool(execute, { repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_contract_abandon", deleteBranch: true, abandonUnmerged: true }, context);

  assert.equal(result.metadata.status, "planned");
  assert.equal(result.metadata.preflight.abandonUnmerged, true);
  assert.equal(result.metadata.preflight.ancestryProven, false);
  assert.equal(result.metadata.preflight.unmergedCommitCount, 1);
  assert.match(result.output, /abandonUnmerged: true/);
  assert.match(result.output, /ancestryProven: false/);
  assert.match(result.output, /unmergedCommitCount: 1/);
});

test("guardian_delete_worktree tool execute defaults repoRoot and cwd from native context", async () => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_context_delete", taskName: "context delete", createWorktree: true, config: DEFAULT_CONFIG });
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_delete_worktree.execute;

  const result = await runTool(execute, { mode: "plan", targetPath: start.session.worktree_path }, context);

  assert.equal(result.metadata.status, "planned");
  assert.equal(result.metadata.preflight.repoRoot, repo);
  assert.equal(result.metadata.preflight.currentWorktree, repo);
});

test("guardian_delete_worktree tool execute blocks current worktree from native context cwd", async () => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_context_current", taskName: "context current", createWorktree: true, config: DEFAULT_CONFIG });
  const hooks = await plugin.server({ directory: repo, worktree: start.session.worktree_path });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = start.session.worktree_path;
  const execute = hooks.tool.guardian_delete_worktree.execute;

  const result = await runTool(execute, { mode: "plan", sessionId: "ses_context_current" }, context);

  assert.equal(result.metadata.status, "blocked");
  assert.match(String(result.metadata.reason), /current execution worktree/);
});
