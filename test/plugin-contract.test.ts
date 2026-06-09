import assert from "node:assert/strict";
import fs, { readFile } from "node:fs/promises";
import test from "node:test";
import plugin from "../src/index.ts";
import { createRepo } from "./helpers.ts";

const expectedToolNames = [
  "guardian_delete_worktree",
  "guardian_done",
  "guardian_finish",
  "guardian_finish_workflow",
  "guardian_hygiene",
  "guardian_hygiene_cleanup",
  "guardian_preserve",
  "guardian_recover",
  "guardian_report_html",
  "guardian_start",
  "guardian_status",
  "guardian_unblock_finish",
];

const expectedHookNames = [
  "command.execute.before",
  "event",
  "experimental.chat.system.transform",
  "tool.execute.after",
  "tool.execute.before",
];

const expectedPackagedCommands = new Map([
  ["done", "guardian_done"],
  ["delete-worktree", "guardian_delete_worktree"],
  ["finish", "guardian_finish"],
  ["finish-workflow", "guardian_finish_workflow"],
  ["hygiene", "guardian_hygiene"],
  ["hygiene-cleanup", "guardian_hygiene_cleanup"],
  ["preserve", "guardian_preserve"],
  ["recover", "guardian_recover"],
  ["report", "guardian_report_html"],
  ["start", "guardian_start"],
  ["status", "guardian_status"],
  ["unblock-finish", "guardian_unblock_finish"],
]);

function createToolContext() {
  const metadataCalls: any[] = [];
  return {
    context: {
      sessionID: "ses_contract",
      messageID: "msg_contract",
      agent: "build",
      directory: "/repo",
      worktree: "/repo",
      abort: new AbortController().signal,
      async ask() { return undefined; },
      metadata(input: any) {
        metadataCalls.push(input);
      },
    },
    metadataCalls,
  };
}

test("public plugin export matches OpenCode PluginModule contract", async () => {
  const module = await import("../src/index.ts");
  assert.equal(module.default, plugin);
  assert.equal(plugin.id, "opencode-worktree-guardian");
  assert.equal(typeof plugin.server, "function");
});

test("server returns the expected guardian tool and hook surface", async () => {
  const hooks = await plugin.server({ directory: "/repo", worktree: "/repo" });
  assert.deepEqual(Object.keys(hooks.tool).sort(), expectedToolNames);
  assert.deepEqual(Object.keys(hooks).filter((key) => key !== "tool").sort(), expectedHookNames);
});

test("guardian native tools expose OpenCode tool definitions", async () => {
  const hooks = await plugin.server({ directory: "/repo", worktree: "/repo" });
  for (const toolName of expectedToolNames) {
    const definition = hooks.tool[toolName];
    assert.equal(typeof definition.description, "string", toolName);
    assert.notEqual(definition.description.length, 0, toolName);
    assert.equal(typeof definition.execute, "function", toolName);
    assert.equal(typeof definition.args, "object", toolName);
    assert.equal(typeof definition.args.repoRoot.safeParse, "function", toolName);
    assert.equal(typeof definition.args.cwd.safeParse, "function", toolName);
    assert.equal(typeof definition.args.sessionId.safeParse, "function", toolName);
  }
  assert.equal(typeof hooks.tool.guardian_delete_worktree.args.abandonUnmerged.safeParse, "function");
  assert.equal(typeof hooks.tool.guardian_hygiene_cleanup.args.cleanupPaths.safeParse, "function");
  assert.equal(typeof hooks.tool.guardian_hygiene_cleanup.args.allowCategories.safeParse, "function");
  assert.equal(typeof hooks.tool.guardian_hygiene_cleanup.args.confirmDelete.safeParse, "function");
});

test("guardian_status tool execute returns readable output with raw metadata", async () => {
  const repo = await createRepo();
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { recordSession } = await import("../src/state.ts");
  const { git } = await import("./helpers.ts");
  const { stdout: head } = await git(repo, ["rev-parse", "HEAD"]);
  await recordSession(repo, DEFAULT_CONFIG, {
    session_id: "ses_contract_status_active",
    status: "active",
    branch: "guardian/contract-status-active",
    worktree_path: repo,
    base_ref: "origin/main",
    head_commit: head,
    safety_refs: [],
  });
  await recordSession(repo, DEFAULT_CONFIG, {
    session_id: "ses_contract_status_terminal",
    status: "preserved",
    branch: "guardian/contract-status-terminal",
    worktree_path: `${repo}/.worktrees/opencode-worktree-guardian/contract-status-terminal`,
    base_ref: "origin/main",
    head_commit: head,
    safety_refs: [],
  });
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context, metadataCalls } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute: any = hooks.tool.guardian_status.execute;
  const result: any = await execute({ repoRoot: repo }, context);
  assert.equal(typeof result.output, "string");
  assert.equal(typeof result.metadata, "object");
  assert.deepEqual(metadataCalls, [{ title: "guardian_status" }]);
  assert.equal(result.metadata.repoRoot, repo);
  assert.match(result.output, /\[GOOD\] guardian_status snapshot/);
  assert.match(result.output, /\[INFO\] repoRoot:/);
  assert.match(result.output, /sessions: \d+/);
  assert.match(result.output, /active sessions: 1/);
  assert.match(result.output, /terminal sessions: 1/);
  assert.match(result.output, /worktrees: \d+/);
});

test("guardian_recover tool execute returns readable output with raw metadata", async () => {
  const repo = await createRepo();
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute: any = hooks.tool.guardian_recover.execute;
  const result: any = await execute({ repoRoot: repo }, context);
  assert.equal(typeof result.output, "string");
  assert.equal(typeof result.metadata, "object");
  assert.equal(result.metadata.repoRoot, repo);
  assert.match(result.output, /\[GOOD\] guardian_recover snapshot/);
  assert.match(result.output, /recoveryCandidates: \d+/);
  assert.match(result.output, /suggested commands|sessions:/);
});

test("guardian_report_html tool execute writes report and returns readable output with raw metadata", async () => {
  const repo = await createRepo();
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute: any = hooks.tool.guardian_report_html.execute;
  const result: any = await execute({ repoRoot: repo }, context);
  assert.equal(typeof result.output, "string");
  assert.equal(typeof result.metadata, "object");
  assert.equal(result.metadata.ok, true);
  assert.match(result.metadata.reportPath, /\.git\/opencode-guardian\/report\.html$/);
  assert.equal(typeof result.metadata.status, "object");
  assert.equal(typeof result.metadata.recover, "object");
  assert.match(result.output, /\[GOOD\] guardian_report_html wrote offline report/);
  assert.match(result.output, /reportPath:/);
});

test("guardian_hygiene tool execute returns readable output with raw metadata", async () => {
  const repo = await createRepo();
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context, metadataCalls } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute: any = hooks.tool.guardian_hygiene.execute;
  const result = await execute({ repoRoot: repo }, context);
  assert.equal(typeof result.output, "string");
  assert.equal(typeof result.metadata, "object");
  assert.deepEqual(metadataCalls, [{ title: "guardian_hygiene" }]);
  assert.equal(result.metadata.ok, true);
  assert.equal(result.metadata.repoRoot, repo);
  assert.match(result.output, /\[(GOOD|WARN)\] guardian_hygiene scan/);
  assert.match(result.output, /findings: \d+/);
  assert.match(result.output, /suggested commands:/);
});


test("guardian_hygiene_cleanup tool execute returns readable plan output with raw metadata", async () => {
  const path = await import("node:path");
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, "librarian-contract"), { recursive: true });
  await fs.writeFile(path.join(repo, "librarian-contract", "file.txt"), "artifact\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context, metadataCalls } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute: any = hooks.tool.guardian_hygiene_cleanup.execute;

  const result = await execute({ repoRoot: repo, mode: "plan", cleanupPaths: ["librarian-contract"] }, context);

  assert.equal(typeof result.output, "string");
  assert.equal(typeof result.metadata, "object");
  assert.deepEqual(metadataCalls, [{ title: "guardian_hygiene_cleanup" }]);
  assert.equal(result.metadata.status, "planned");
  assert.equal(typeof result.metadata.confirmToken, "string");
  assert.deepEqual(result.metadata.targets.map((target: Record<string, unknown>) => target.path), ["librarian-contract"]);
  assert.match(result.output, /guardian_hygiene_cleanup planned/);
  assert.match(result.output, /approvedTargets: 1/);
  assert.doesNotMatch(result.output, /confirmToken:/);
});

test("guardian_hygiene_cleanup plugin confirmDelete reuses matching plan token and preserves stale safety", async () => {
  const path = await import("node:path");
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, "librarian-contract-delete"), { recursive: true });
  await fs.writeFile(path.join(repo, "librarian-contract-delete", "file.txt"), "artifact\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute: any = hooks.tool.guardian_hygiene_cleanup.execute;

  const plan = await execute({ repoRoot: repo, mode: "plan", cleanupPaths: ["librarian-contract-delete"] }, context);
  const apply = await execute({ repoRoot: repo, mode: "apply", cleanupPaths: ["librarian-contract-delete"], confirmDelete: true }, context);

  assert.equal(plan.metadata.status, "planned");
  assert.equal(apply.metadata.status, "cleaned");
  assert.equal(await fs.access(path.join(repo, "librarian-contract-delete")).then(() => true, () => false), false);

  await fs.mkdir(path.join(repo, "librarian-contract-stale"), { recursive: true });
  await fs.writeFile(path.join(repo, "librarian-contract-stale", "file.txt"), "original\n");
  const stalePlan = await execute({ repoRoot: repo, mode: "plan", cleanupPaths: ["librarian-contract-stale"] }, context);
  await fs.writeFile(path.join(repo, "librarian-contract-stale", "file.txt"), "changed\n");
  const staleApply = await execute({ repoRoot: repo, mode: "apply", cleanupPaths: ["librarian-contract-stale"], confirmDelete: true }, context);

  assert.equal(stalePlan.metadata.status, "planned");
  assert.equal(staleApply.metadata.status, "blocked");
  assert.match(String(staleApply.metadata.reason), /confirm token mismatch/);
  assert.equal(await fs.access(path.join(repo, "librarian-contract-stale")).then(() => true, () => false), true);
});

test("guardian_hygiene_cleanup plugin does not reuse cached token when apply options differ", async () => {
  const path = await import("node:path");
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, "librarian-contract-options"), { recursive: true });
  await fs.writeFile(path.join(repo, "librarian-contract-options", "file.txt"), "artifact\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute: any = hooks.tool.guardian_hygiene_cleanup.execute;

  const plan = await execute({ repoRoot: repo, mode: "plan", cleanupPaths: ["librarian-contract-options"] }, context);
  const apply = await execute({ repoRoot: repo, mode: "apply", confirmDelete: true }, context);

  assert.equal(plan.metadata.status, "planned");
  assert.equal(apply.metadata.status, "blocked");
  assert.match(String(apply.metadata.reason), /confirm token mismatch/);
  assert.equal(await fs.access(path.join(repo, "librarian-contract-options")).then(() => true, () => false), true);
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
  const execute: any = hooks.tool.guardian_delete_worktree.execute;
  const result = await execute({ repoRoot: repo, cwd: repo, mode: "plan", targetPath: start.session.worktree_path }, context);
  assert.equal(typeof result.output, "string");
  assert.equal(typeof result.metadata, "object");
  assert.equal(result.metadata.status, "planned");
  assert.match(result.output, /guardian_delete_worktree planned/);
  assert.match(result.output, /targetKind: worktree/);
  assert.match(result.output, /worktreeRemoved: false/);
  assert.match(result.output, /confirmToken:/);
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
  const execute: any = hooks.tool.guardian_delete_worktree.execute;

  const result = await execute({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_contract_abandon", deleteBranch: true, abandonUnmerged: true }, context);

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
  const execute: any = hooks.tool.guardian_delete_worktree.execute;

  const result = await execute({ mode: "plan", targetPath: start.session.worktree_path }, context);

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
  const execute: any = hooks.tool.guardian_delete_worktree.execute;

  const result = await execute({ mode: "plan", sessionId: "ses_context_current" }, context);

  assert.equal(result.metadata.status, "blocked");
  assert.match(result.metadata.reason, /current execution worktree/);
});

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
  const execute: any = hooks.tool.guardian_done.execute;

  const result = await execute({ repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: contract done" }, context);

  assert.equal(typeof result.output, "string");
  assert.equal(typeof result.metadata, "object");
  assert.equal(result.metadata.status, "planned");
  assert.equal(result.metadata.lane, "primary-main-publish");
  assert.deepEqual(metadataCalls, [{ title: "guardian_done" }]);
  assert.match(result.output, /guardian_done planned/);
  assert.match(result.output, /lane: primary-main-publish/);
  assert.match(result.output, /commitMessage: feat: contract done/);
  assert.match(result.output, /confirmToken:/);
  assert.match(result.output, /contract-done.txt/);
});

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
  const execute: any = hooks.tool.guardian_finish_workflow.execute;

  const result = await execute({ repoRoot: repo, cwd: repo, mode: "plan" }, context);

  assert.equal(result.metadata.status, "planned");
  assert.equal(result.metadata.preflight.baseRef, "origin/main");
  assert.equal(typeof result.metadata.preflight.baseRefOid, "string");
  assert.equal(result.metadata.candidates.length, 1);
  assert.equal(result.metadata.blockers.length, 0);
  assert.deepEqual(metadataCalls, [{ title: "guardian_finish_workflow" }]);
  assert.match(result.output, /guardian_finish_workflow planned/);
  assert.match(result.output, /baseRef: origin\/main/);
  assert.match(result.output, /baseRefOid: [a-f0-9]{12}/);
  assert.match(result.output, /candidates: 1/);
  assert.match(result.output, /maxCandidates: 25/);
  assert.match(result.output, /confirmToken:/);
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
  const execute: any = hooks.tool.guardian_finish_workflow.execute;

  const result = await execute({ repoRoot: repo, cwd: repo, mode: "plan" }, context);

  assert.equal(result.metadata.status, "blocked");
  assert.match(result.metadata.reason, /primary worktree/);
  assert.match(result.output, /\[FAIL\] guardian_finish_workflow blocked/);
  assert.match(result.output, /primary worktree has uncommitted changes/);
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
  const execute: any = hooks.tool.guardian_finish.execute;

  const result = await execute({ repoRoot: repo, timestamp: "20260602T010101" }, context);

  assert.equal(result.metadata.status, "pr-suggested");
  assert.match(result.metadata.suggestedCommand, /gh pr create/);
  assert.equal(result.metadata.preflight.currentWorktree, started.session.worktree_path);
  assert.equal(result.metadata.preflight.sessionOwnedWorktree, true);
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
  const execute: any = hooks.tool.guardian_preserve.execute;

  const result = await execute({ repoRoot: repo, timestamp: "20260602T020202" }, context);

  assert.equal(result.metadata.status, "preserved");
  assert.equal(result.metadata.session.worktree_path, started.session.worktree_path);
  assert.match(result.metadata.preservedRef, /ses_context_preserve/);
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
  const execute: any = hooks.tool.guardian_unblock_finish.execute;

  const result = await execute({ repoRoot: repo, branch: started.session.branch, mode: "plan" }, context);

  assert.equal(result.metadata.status, "planned");
  assert.equal(result.metadata.preflight.sessionId, "ses_context_unblock");
  assert.equal(result.metadata.preflight.targetSource, "branch");
  assert.match(result.output, /guardian_unblock_finish planned/);
});

test("README documents local shim and readiness command names", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /export const WorktreeGuardian = Guardian\.server/);
  assert.match(readme, /commands\/\*\.md/);
  assert.match(readme, /\/opencode-worktree-guardian:status/);
  assert.match(readme, /\.opencode\/commands/);
  assert.match(readme, /~\/\.config\/opencode\/commands/);
  assert.match(readme, /test:contract/);
  assert.match(readme, /test:smoke:package/);
  assert.match(readme, /test:smoke:host/);
  assert.match(readme, /test:readiness/);
  assert.match(readme, /guardian_report_html/);
  assert.match(readme, /raw `git worktree add` outside Guardian-owned roots/);
  assert.match(readme, /external-temp-worktree/);
  assert.match(readme, /\.git\/opencode-guardian\/report\.html/);
});

test("packaged command files route to native guardian tools", async () => {
  for (const [commandName, toolName] of expectedPackagedCommands) {
    const command = await readFile(new URL(`../commands/${commandName}.md`, import.meta.url), "utf8");
    assert.match(command, /^---\ndescription: .+\nargument-hint: .+\n---\n/s, commandName);
    assert.match(command, new RegExp(`\\b${toolName}\\b`), commandName);
    assert.doesNotMatch(command, /git worktree remove|git worktree prune|rm -rf|git reset --hard|git clean -fd|git branch -D|git stash (drop|clear|pop)/, commandName);
  }
});
