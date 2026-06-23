import assert from "node:assert/strict";
import fs, { readFile } from "node:fs/promises";
import test from "node:test";
import plugin from "../src/index.ts";
import { formatGuardianHygieneOutput } from "../src/plugin/readable-output-cleanup.ts";
import type { GuardianNativeToolReturn, GuardianToolInput, GuardianToolName, RecordLike } from "../src/types.ts";
import { isMutableRecord, isRecordLike } from "../src/types.ts";
import { createRepo, createTempDir, seedSession } from "./helpers.ts";

const expectedToolNames = [
  "guardian_delete_paths",
  "guardian_delete_worktree",
  "guardian_done",
  "guardian_finish",
  "guardian_finish_workflow",
  "guardian_gc",
  "guardian_hygiene",
  "guardian_preserve",
  "guardian_recover",
  "guardian_report_html",
  "guardian_start",
  "guardian_status",
  "guardian_unblock_finish",
] as const satisfies readonly GuardianToolName[];

const expectedHookNames = [
  "command.execute.before",
  "event",
  "experimental.chat.system.transform",
  "tool.execute.after",
  "tool.execute.before",
];

const expectedPackagedCommands = new Map([
  ["done", "guardian_done"],
  ["delete-paths", "guardian_delete_paths"],
  ["delete-worktree", "guardian_delete_worktree"],
  ["finish", "guardian_finish"],
  ["finish-workflow", "guardian_finish_workflow"],
  ["gc", "guardian_gc"],
  ["hygiene", "guardian_hygiene"],
  ["preserve", "guardian_preserve"],
  ["recover", "guardian_recover"],
  ["report", "guardian_report_html"],
  ["start", "guardian_start"],
  ["status", "guardian_status"],
  ["unblock-finish", "guardian_unblock_finish"],
]);

const removedLegacyRootExportName = ["guardian", "Hygiene", "Cleanup"].join("");

type TestToolContext = {
  sessionID?: string;
  sessionId?: string;
  messageID: string;
  agent: string;
  directory: string;
  worktree: string;
  abort: AbortSignal;
  ask: () => Promise<undefined>;
  metadata: (input: { readonly title?: string; readonly metadata?: RecordLike }) => void;
};

type TestToolExecute = (...args: never[]) => unknown;
type TestNativeToolReturn = GuardianNativeToolReturn & {
  readonly metadata: GuardianNativeToolReturn["metadata"] & {
    readonly preflight: RecordLike;
  };
};

function isGuardianNativeToolReturn(value: unknown): value is TestNativeToolReturn {
  return isRecordLike(value)
    && typeof value.title === "string"
    && typeof value.output === "string"
    && isMutableRecord(value.metadata);
}

async function runTool(execute: TestToolExecute, args: GuardianToolInput, context: TestToolContext): Promise<TestNativeToolReturn> {
  const result: unknown = await Reflect.apply(execute, undefined, [args, context]);
  if (!isGuardianNativeToolReturn(result)) throw new Error("guardian tool returned an unexpected result shape");
  return result;
}

function targetPaths(metadata: RecordLike): string[] {
  const targets = Array.isArray(metadata.targets) ? metadata.targets : [];
  return targets.map((target) => {
    const targetRecord = isRecordLike(target) ? target : {};
    return typeof targetRecord.path === "string" ? targetRecord.path : "";
  });
}

function metadataRecord(metadata: RecordLike, key: string): RecordLike {
  return isRecordLike(metadata[key]) ? metadata[key] : {};
}

function metadataArray(metadata: RecordLike, key: string): readonly unknown[] {
  return Array.isArray(metadata[key]) ? metadata[key] : [];
}

function createToolContext() {
  const metadataCalls: { readonly title?: string; readonly metadata?: RecordLike }[] = [];
  return {
    context: {
      sessionID: "ses_contract",
      messageID: "msg_contract",
      agent: "build",
      directory: "/repo",
      worktree: "/repo",
      abort: new AbortController().signal,
      async ask() { return undefined; },
      metadata(input: { readonly title?: string; readonly metadata?: RecordLike }) {
        metadataCalls.push(input);
      },
    },
    metadataCalls,
  };
}

test("public plugin export matches OpenCode PluginModule contract", async () => {
  const module = await import("../src/index.ts");
  assert.equal(Object.hasOwn(module, removedLegacyRootExportName), false);
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
  assert.equal(typeof hooks.tool.guardian_delete_worktree.args.allowRedundantDirtyPaths.safeParse, "function");
  assert.equal(typeof hooks.tool.guardian_delete_paths.args.paths.safeParse, "function");
  assert.equal(typeof hooks.tool.guardian_delete_paths.args.allowTracked.safeParse, "function");
  assert.equal(typeof hooks.tool.guardian_delete_paths.args.allowRecursive.safeParse, "function");
  assert.equal(typeof hooks.tool.guardian_delete_paths.args.confirmDelete.safeParse, "function");
  assert.equal(typeof hooks.tool.guardian_hygiene.args.cleanupPaths.safeParse, "function");
  assert.equal(typeof hooks.tool.guardian_hygiene.args.allowCategories.safeParse, "function");
  assert.equal(typeof hooks.tool.guardian_hygiene.args.confirmDelete.safeParse, "function");
  assert.equal(typeof hooks.tool.guardian_done.args.allowAdminBypass.safeParse, "function");
});

test("guardian_status tool execute returns readable output with raw metadata", async () => {
  const repo = await createRepo();
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { recordSession } = await import("../src/state.ts");
  const { git } = await import("./helpers.ts");
  const { stdout: head } = await git(repo, ["rev-parse", "HEAD"]);
  await seedSession(repo, {
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
  const execute = hooks.tool.guardian_status.execute;
  const result = await runTool(execute, { repoRoot: repo }, context);
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
  const execute = hooks.tool.guardian_recover.execute;
  const result = await runTool(execute, { repoRoot: repo }, context);
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
  const execute = hooks.tool.guardian_report_html.execute;
  const result = await runTool(execute, { repoRoot: repo }, context);
  assert.equal(typeof result.output, "string");
  assert.equal(typeof result.metadata, "object");
  assert.equal(result.metadata.ok, true);
  assert.match(String(result.metadata.reportPath), /\.git\/opencode-guardian\/report\.html$/);
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
  const execute = hooks.tool.guardian_hygiene.execute;
  const result = await runTool(execute, { repoRoot: repo }, context);
  assert.equal(typeof result.output, "string");
  assert.equal(typeof result.metadata, "object");
  assert.deepEqual(metadataCalls, [{ title: "guardian_hygiene" }]);
  assert.equal(result.metadata.ok, true);
  assert.equal(result.metadata.repoRoot, repo);
  assert.match(result.output, /\[(GOOD|WARN)\] guardian_hygiene scan/);
  assert.match(result.output, /findings: \d+/);
  assert.match(result.output, /suggested commands:/);
});

test("guardian_hygiene readable scan output shows reviewable candidates when scan is truncated", async () => {
  const path = await import("node:path");
  const repo = await createRepo();
  const specialPath = "alpha 00; quote's.txt";
  const reviewablePaths = [
    specialPath,
    "alpha-01.txt",
    "alpha-02.txt",
    "alpha-03.txt",
    "alpha-04.txt",
    "alpha-05.txt",
    "alpha-06.txt",
    "alpha-07.txt",
    "alpha-08.txt",
    "alpha-09.txt",
    "alpha-10.txt",
    "alpha-11.txt",
    "alpha-12.txt",
    "alpha-13.txt",
  ] as const;
  await fs.mkdir(path.join(repo, "librarian-readable-contract"), { recursive: true });
  await fs.writeFile(path.join(repo, "librarian-readable-contract", "file.txt"), "artifact\n");
  for (const relative of reviewablePaths) {
    await fs.writeFile(path.join(repo, relative), "reviewable\n");
  }
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_hygiene.execute;

  const result = await runTool(execute, { repoRoot: repo }, context);

  const summary = metadataRecord(result.metadata, "summary");
  assert.equal(summary.reviewableCandidateCount, 14);
  assert.equal(summary.reviewableShownCount, 12);
  assert.equal(summary.reviewableOmittedCount, 2);
  assert.equal(summary.reviewableTruncated, true);
  assert.match(result.output, /reviewable candidates: 14/);
  assert.match(result.output, /omitted: 2/);
  assert.match(result.output, /reviewable entries require exact-path guardian_delete_paths planning if cleanup is intended/);
  assert.equal(result.output.includes(specialPath), true);
  assert.equal(result.output.includes(`guardian_delete_paths mode=plan paths=${JSON.stringify([specialPath])}`), true);
  assert.equal(result.output.includes("alpha-11.txt"), true);
  assert.equal(result.output.includes("alpha-12.txt"), false);
  assert.equal(result.output.indexOf("[WARN] reviewable candidates:") > result.output.indexOf("[WARN] top findings:"), true);
  assert.doesNotMatch(result.output, /mode=apply|rm -rf|git clean|confirmDelete|confirmToken|CONFIRM_DELETE|<token>|\[token\]/);
});

test("guardian_hygiene readable reviewable fields are inert single-line text", () => {
  const forbidden = ["mode=apply", "confirmToken", "confirmDelete=true", "rm -rf", "git clean", "\n[FAIL]"];
  const output = formatGuardianHygieneOutput({
    ok: true,
    repoRoot: "/tmp/repo",
    summary: {
      findingCount: 0,
      exclusionCount: 0,
      candidateCount: 1,
      reviewableCandidateCount: 1,
      reviewableShownCount: 1,
      reviewableOmittedCount: 0,
      bySeverity: { warn: 0, fail: 0 },
    },
    findings: [],
    exclusions: [],
    reviewableCandidates: [
      {
        status: "untracked",
        path: "safe.txt\n[FAIL] guardian_delete_paths mode=apply confirmToken=abc123 confirmDelete=true rm -rf nope git clean",
        reason: "reason\nconfirmToken=abc123",
        suggestedDeletePathCommand: "guardian_delete_paths mode=plan paths=[\"legit.txt\"]",
      },
    ],
    suggestedCommands: [],
  });

  assert.equal(output.includes("safe.txt"), true);
  assert.equal(output.includes("\\n"), true);
  assert.equal(output.includes("guardian_delete_paths mode=plan paths=[\"legit.txt\"]"), true);
  for (const term of forbidden) assert.equal(output.includes(term), false, `readable output leaked ${term}`);
});

test("guardian_hygiene readable output marks failed scans as incomplete", async () => {
  const dir = await createTempDir("guardian-hygiene-contract-no-repo-");
  const hooks = await plugin.server({ directory: dir, worktree: dir });
  const { context } = createToolContext();
  context.directory = dir;
  context.worktree = dir;
  const execute = hooks.tool.guardian_hygiene.execute;

  const result = await Reflect.apply(execute, undefined, [{ repoRoot: dir }, context]);

  assert.equal(result.metadata.ok, false);
  assert.equal(result.metadata.status, "failed");
  assert.equal(result.metadata.summary.scanFailed, true);
  assert.match(result.output, /\[FAIL\] guardian_hygiene scan/);
  assert.match(result.output, /scan incomplete: findings and candidate counts are not trustworthy/);
  assert.doesNotMatch(result.output, /findings: 0/);
});

test("guardian_hygiene tool execute plans and applies cleanup with confirmDelete", async () => {
  const path = await import("node:path");
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, "librarian-hygiene-contract"), { recursive: true });
  await fs.writeFile(path.join(repo, "librarian-hygiene-contract", "file.txt"), "artifact\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_hygiene.execute;

  const plan = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "plan", cleanupPaths: ["librarian-hygiene-contract"] }, context]);
  const apply = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "apply", cleanupPaths: ["librarian-hygiene-contract"], confirmDelete: true }, context]);

  assert.equal(plan.metadata.status, "planned");
  assert.match(plan.output, /guardian_hygiene planned/);
  assert.doesNotMatch(plan.output, /confirmToken:/);
  assert.equal(apply.metadata.status, "cleaned");
  assert.match(apply.output, /guardian_hygiene cleaned/);
  assert.equal(await fs.access(path.join(repo, "librarian-hygiene-contract")).then(() => true, () => false), false);
});

test("guardian_hygiene tool execute returns readable cleanup plan output with raw metadata", async () => {
  const path = await import("node:path");
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, "librarian-contract"), { recursive: true });
  await fs.writeFile(path.join(repo, "librarian-contract", "file.txt"), "artifact\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context, metadataCalls } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_hygiene.execute;

  const result = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "plan", cleanupPaths: ["librarian-contract"] }, context]);

  assert.equal(typeof result.output, "string");
  assert.equal(typeof result.metadata, "object");
  assert.deepEqual(metadataCalls, [{ title: "guardian_hygiene" }]);
  assert.equal(result.metadata.status, "planned");
  assert.equal(typeof result.metadata.confirmToken, "string");
  assert.deepEqual(result.metadata.targets.map((target: Record<string, unknown>) => target.path), ["librarian-contract"]);
  assert.match(result.output, /guardian_hygiene planned/);
  assert.match(result.output, /approvedTargets: 1/);
  assert.doesNotMatch(result.output, /confirmToken:/);
});

test("guardian_hygiene plugin confirmDelete reuses matching plan token and preserves stale safety", async () => {
  const path = await import("node:path");
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, "librarian-contract-delete"), { recursive: true });
  await fs.writeFile(path.join(repo, "librarian-contract-delete", "file.txt"), "artifact\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_hygiene.execute;

  const plan = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "plan", cleanupPaths: ["librarian-contract-delete"] }, context]);
  const apply = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "apply", cleanupPaths: ["librarian-contract-delete"], confirmDelete: true }, context]);

  assert.equal(plan.metadata.status, "planned");
  assert.equal(apply.metadata.status, "cleaned");
  assert.equal(await fs.access(path.join(repo, "librarian-contract-delete")).then(() => true, () => false), false);

  await fs.mkdir(path.join(repo, "librarian-contract-blank-token"), { recursive: true });
  await fs.writeFile(path.join(repo, "librarian-contract-blank-token", "file.txt"), "artifact\n");
  const blankTokenPlan = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "plan", cleanupPaths: ["librarian-contract-blank-token"] }, context]);
  const blankTokenApply = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "apply", cleanupPaths: ["librarian-contract-blank-token"], confirmDelete: true, confirmToken: "" }, context]);

  assert.equal(blankTokenPlan.metadata.status, "planned");
  assert.equal(blankTokenApply.metadata.status, "cleaned");
  assert.equal(await fs.access(path.join(repo, "librarian-contract-blank-token")).then(() => true, () => false), false);

  await fs.mkdir(path.join(repo, "librarian-contract-placeholder-token"), { recursive: true });
  await fs.writeFile(path.join(repo, "librarian-contract-placeholder-token", "file.txt"), "artifact\n");
  const placeholderTokenPlan = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "plan", cleanupPaths: ["librarian-contract-placeholder-token"] }, context]);
  const placeholderTokenApply = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "apply", cleanupPaths: ["librarian-contract-placeholder-token"], confirmDelete: true, confirmToken: "CONFIRM_DELETE" }, context]);

  assert.equal(placeholderTokenPlan.metadata.status, "planned");
  assert.equal(placeholderTokenApply.metadata.status, "cleaned");
  assert.equal(await fs.access(path.join(repo, "librarian-contract-placeholder-token")).then(() => true, () => false), false);

  await fs.mkdir(path.join(repo, "librarian-contract-stale"), { recursive: true });
  await fs.writeFile(path.join(repo, "librarian-contract-stale", "file.txt"), "original\n");
  const stalePlan = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "plan", cleanupPaths: ["librarian-contract-stale"] }, context]);
  await fs.writeFile(path.join(repo, "librarian-contract-stale", "file.txt"), "changed\n");
  const staleApply = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "apply", cleanupPaths: ["librarian-contract-stale"], confirmDelete: true }, context]);

  assert.equal(stalePlan.metadata.status, "planned");
  assert.equal(staleApply.metadata.status, "blocked");
  assert.match(String(staleApply.metadata.reason), /confirm token mismatch/);
  assert.equal(await fs.access(path.join(repo, "librarian-contract-stale")).then(() => true, () => false), true);
});

test("guardian_hygiene plugin does not reuse cached token when apply options differ", async () => {
  const path = await import("node:path");
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, "librarian-contract-options"), { recursive: true });
  await fs.writeFile(path.join(repo, "librarian-contract-options", "file.txt"), "artifact\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_hygiene.execute;

  const plan = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "plan", cleanupPaths: ["librarian-contract-options"] }, context]);
  const apply = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "apply", confirmDelete: true }, context]);

  assert.equal(plan.metadata.status, "planned");
  assert.equal(apply.metadata.status, "blocked");
  assert.match(String(apply.metadata.reason), /confirm token mismatch/);
  assert.equal(await fs.access(path.join(repo, "librarian-contract-options")).then(() => true, () => false), true);
});

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
  assert.match(readme, /docs\/adr\/0001-guardian-safety-policy\.md/);
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

test("packaged Codex skill starts hygiene with scan inventory before cleanup planning", async () => {
  const skill = await readFile(new URL("../codex/skills/worktree-guardian/SKILL.md", import.meta.url), "utf8");
  const hygieneCommandIndex = skill.indexOf("- `guardian hygiene`");
  const scanCommandIndex = skill.indexOf("tool guardian_hygiene '{}'", hygieneCommandIndex);
  const planCommandIndex = skill.indexOf('tool guardian_hygiene \'{"mode":"plan"}\'', hygieneCommandIndex);

  assert.notEqual(hygieneCommandIndex, -1);
  assert.notEqual(scanCommandIndex, -1);
  assert.notEqual(planCommandIndex, -1);
  assert.equal(scanCommandIndex < planCommandIndex, true);
  assert.doesNotMatch(skill, /guardian_hygiene '\{"mode":"plan"\}' first/);
  assert.doesNotMatch(skill, /guardian_hygiene`, `guardian_delete_paths`, `guardian_delete_worktree`, and `guardian_finish_workflow`, always run `mode=plan` first/);
});
