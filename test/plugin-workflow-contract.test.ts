import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import plugin from "../src/index.ts";
import { createToolContext, metadataArray, metadataRecord, runTool } from "./plugin-contract-helpers.ts";

test("guardian_finish_workflow tool execute returns readable plan output with raw metadata", async () => {
  const { createRepoWithOrigin, git } = await import("./helpers.ts");
  const path = await import("node:path");
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/contract-finish-workflow";
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, "contract-finish-workflow.txt"), "workflow\n");
  await git(repo, ["add", "contract-finish-workflow.txt"]);
  await git(repo, ["commit", "-m", "add contract finish workflow"]);
  await git(repo, ["checkout", "main"]);
  await git(repo, ["merge", "--no-ff", branch, "-m", "merge contract finish workflow"]);
  await git(repo, ["push", "origin", "main"]);
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), "contract-finish-workflow");
  await git(repo, ["worktree", "add", worktreePath, branch]);
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context, metadataCalls } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_finish_workflow.execute;

  const result = await runTool(execute, { repoRoot: repo, cwd: repo, mode: "plan" }, context);

  assert.equal(result.metadata.status, "planned");
  const preflight = metadataRecord(result.metadata, "preflight");
  assert.equal(preflight.baseRef, "origin/main");
  assert.equal(typeof preflight.baseRefOid, "string");
  assert.equal(metadataArray(result.metadata, "candidates").length, 1);
  assert.equal(metadataArray(result.metadata, "blockers").length, 0);
  assert.deepEqual(metadataCalls, [{ title: "guardian_finish_workflow" }]);
  assert.match(result.output, /guardian_finish_workflow planned/);
  assert.match(result.output, /baseRef: origin\/main/);
  assert.match(result.output, /baseRefOid: [a-f0-9]{12}/);
  assert.match(result.output, /candidates: 1/);
  assert.match(result.output, /maxCandidates: 25/);
  assert.match(result.output, /confirmToken:/);
});

test("guardian_finish_workflow tool execute reports completed empty candidate scan", async () => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_finish_workflow.execute;

  const result = await runTool(execute, { repoRoot: repo, cwd: repo, mode: "plan" }, context);

  assert.equal(result.metadata.status, "planned");
  const preflight = metadataRecord(result.metadata, "preflight");
  assert.equal(preflight.candidateScanStatus, "completed");
  assert.equal(preflight.candidateCount, 0);
  assert.match(result.output, /candidateScan: completed/);
  assert.match(result.output, /candidates: 0/);
});

test("guardian_finish_workflow tool execute dirty primary candidate scan reports blocked inventory", async () => {
  const { createRepoWithOrigin, git } = await import("./helpers.ts");
  const path = await import("node:path");
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/contract-dirty-primary-candidate";
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, "contract-dirty-primary-candidate.txt"), "workflow\n");
  await git(repo, ["add", "contract-dirty-primary-candidate.txt"]);
  await git(repo, ["commit", "-m", "add contract dirty primary candidate"]);
  await git(repo, ["checkout", "main"]);
  await git(repo, ["merge", "--no-ff", branch, "-m", "merge contract dirty primary candidate"]);
  await git(repo, ["push", "origin", "main"]);
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), "contract-dirty-primary-candidate");
  await git(repo, ["worktree", "add", worktreePath, branch]);
  await fs.writeFile(path.join(repo, "contract-dirty-primary.txt"), "dirty\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_finish_workflow.execute;

  const result = await runTool(execute, { repoRoot: repo, cwd: repo, mode: "plan" }, context);

  assert.equal(result.metadata.status, "blocked");
  assert.equal(result.metadata.confirmToken, undefined);
  const preflight = metadataRecord(result.metadata, "preflight");
  assert.equal(preflight.candidateScanStatus, "completed");
  assert.equal(preflight.candidateCount, 1);
  assert.equal(metadataArray(result.metadata, "candidates").length, 1);
  assert.match(String(result.metadata.reason), /primary worktree/);
  assert.match(result.output, /\[FAIL\] guardian_finish_workflow blocked/);
  assert.match(result.output, /candidateScan: completed/);
  assert.match(result.output, /candidates: 1/);
  assert.match(result.output, /primary worktree has uncommitted changes/);
  assert.doesNotMatch(result.output, /confirmToken:/);
});

test("guardian_finish_workflow tool execute returns readable blocked output with raw metadata", async () => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const path = await import("node:path");
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "dirty.txt"), "dirty\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_finish_workflow.execute;

  const result = await runTool(execute, { repoRoot: repo, cwd: repo, mode: "plan" }, context);

  assert.equal(result.metadata.status, "blocked");
  assert.match(String(result.metadata.reason), /primary worktree/);
  assert.match(result.output, /\[FAIL\] guardian_finish_workflow blocked/);
  assert.match(result.output, /candidateScan: completed/);
  assert.match(result.output, /primary worktree has uncommitted changes/);
});

test("guardian_finish_workflow tool execute candidate scan skipped output is explicit", async () => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_finish_workflow.execute;

  const result = await runTool(execute, { repoRoot: repo, cwd: repo, mode: "preview" }, context);

  assert.equal(result.metadata.status, "blocked");
  const preflight = metadataRecord(result.metadata, "preflight");
  assert.equal(preflight.candidateScanStatus, "skipped");
  assert.equal(preflight.candidateScanSkippedReason, "invalid-mode");
  assert.match(result.output, /candidateScan: skipped/);
  assert.match(result.output, /reason: invalid-mode/);
  assert.doesNotMatch(result.output, /candidates: 0/);
});

test("guardian_finish tool execute defaults cwd to recorded session worktree", async () => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_context_finish", taskName: "context finish", createWorktree: true, config: DEFAULT_CONFIG });
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  context.sessionID = "ses_context_finish";
  const execute = hooks.tool.guardian_finish.execute;

  const result = await runTool(execute, { repoRoot: repo, timestamp: "20260602T010101" }, context);

  assert.equal(result.metadata.status, "pr-suggested");
  const preflight = metadataRecord(result.metadata, "preflight");
  assert.match(String(result.metadata.suggestedCommand), /gh pr create/);
  assert.equal(preflight.currentWorktree, started.session.worktree_path);
  assert.equal(preflight.sessionOwnedWorktree, true);
});

test("guardian_preserve tool execute defaults cwd to recorded session worktree", async () => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_context_preserve", taskName: "context preserve", createWorktree: true, config: DEFAULT_CONFIG });
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  context.sessionID = "ses_context_preserve";
  const execute = hooks.tool.guardian_preserve.execute;

  const result = await runTool(execute, { repoRoot: repo, timestamp: "20260602T020202" }, context);

  assert.equal(result.metadata.status, "preserved");
  assert.equal(metadataRecord(result.metadata, "session").worktree_path, started.session.worktree_path);
  assert.match(String(result.metadata.preservedRef), /ses_context_preserve/);
});

test("guardian_unblock_finish tool execute injects context session id with explicit branch", async () => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { getGuardianPaths, readState, writeStateAtomic } = await import("../src/state.ts");
  const path = await import("node:path");
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_context_unblock", taskName: "context unblock", createWorktree: true, config: DEFAULT_CONFIG });
  const reviewPath = path.join(started.session.worktree_path, ".milestones", "reviews", "context-unblock-impl-rating-20260602.md");
  await fs.mkdir(path.dirname(reviewPath), { recursive: true });
  await fs.writeFile(reviewPath, "# Context Unblock\n");
  const guardianPaths = await getGuardianPaths(repo);
  const state = await readState(guardianPaths, { repoRoot: repo, config: DEFAULT_CONFIG });
  delete state.sessions.ses_context_unblock;
  await writeStateAtomic(guardianPaths, state);
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  context.sessionID = "ses_context_unblock";
  const execute = hooks.tool.guardian_unblock_finish.execute;

  const result = await runTool(execute, { repoRoot: repo, branch: started.session.branch, mode: "plan" }, context);

  assert.equal(result.metadata.status, "planned");
  assert.equal(result.metadata.preflight.sessionId, "ses_context_unblock");
  assert.equal(result.metadata.preflight.targetSource, "branch");
  assert.match(result.output, /guardian_unblock_finish planned/);
});
