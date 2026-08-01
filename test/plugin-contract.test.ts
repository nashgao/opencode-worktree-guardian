import assert from "node:assert/strict";
import fs, { readFile } from "node:fs/promises";
import test from "node:test";
import plugin from "../src/index.ts";
import { maybeInjectPlanConfirmToken, rememberPlanConfirmToken } from "../src/plugin/plan-token-cache.ts";
import { createToolContext, runTool } from "./plugin-contract-helpers.ts";
import type { GuardianToolName, PlanCacheToolArgs, PlanTokenCache } from "../src/types.ts";

const expectedToolNames = [
  "guardian_delete_paths",
  "guardian_delete_worktree",
  "guardian_done",
  "guardian_finish",
  "guardian_finish_workflow",
  "guardian_gc",
  "guardian_goal",
  "guardian_hygiene",
  "guardian_init",
  "guardian_preserve",
  "guardian_project_status",
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
  ["goal", "guardian_goal"],
  ["hygiene", "guardian_hygiene"],
  ["init", "guardian_init"],
  ["preserve", "guardian_preserve"],
  ["project-status", "guardian_project_status"],
  ["recover", "guardian_recover"],
  ["report", "guardian_report_html"],
  ["start", "guardian_start"],
  ["status", "guardian_status"],
  ["unblock-finish", "guardian_unblock_finish"],
]);

const removedLegacyRootExportName = ["guardian", "Hygiene", "Cleanup"].join("");

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
  assert.equal(typeof hooks.tool.guardian_done.args.primary.safeParse, "function");
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

test("canonical docs define the cooperative ignored-deletion concurrency boundary", async () => {
  const [readme, changelog, adr] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/adr/0001-guardian-safety-policy.md", import.meta.url), "utf8"),
  ]);

  assert.match(adr, /# ADR 0001: Threat Model and Concurrency Boundary/);
  assert.match(adr, /Guardian mediates cooperative native and routed writers/);
  assert.match(adr, /uncooperative or malicious same-UID writers are outside this guarantee/);
  assert.match(adr, /rechecked at the removal boundary/);
  assert.match(adr, /non-force removal fails, Guardian rescans and preserves/);
  assert.match(readme, /cooperative boundary/);
  assert.match(readme, /observed drift blocks and requires a fresh plan/);
  assert.doesNotMatch(readme, /added or changed ignored data remains preserved/i);
  assert.match(changelog, /Wave 5C/);
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

test("guardian_done plugin confirm reuses planned-partial tokens", () => {
  const cache: PlanTokenCache = new Map();
  const planArgs: PlanCacheToolArgs = { repoRoot: "/repo", cwd: "/repo", mode: "plan", allowIgnoredFiles: true };
  const applyArgs: PlanCacheToolArgs = { repoRoot: "/repo", cwd: "/repo", mode: "apply", confirm: true, confirmToken: "", allowIgnoredFiles: true };
  const changedApplyArgs: PlanCacheToolArgs = { ...applyArgs, allowIgnoredFiles: false };
  const adminApplyArgs: PlanCacheToolArgs = { ...applyArgs, allowAdminBypass: true };

  rememberPlanConfirmToken("guardian_done", planArgs, { ok: true, status: "planned-partial", confirmToken: "partial-token" }, cache);
  maybeInjectPlanConfirmToken("guardian_done", applyArgs, cache);
  maybeInjectPlanConfirmToken("guardian_done", changedApplyArgs, cache);
  maybeInjectPlanConfirmToken("guardian_done", adminApplyArgs, cache);

  assert.equal(applyArgs.confirmToken, "partial-token");
  assert.equal(changedApplyArgs.confirmToken, "");
  assert.equal(adminApplyArgs.confirmToken, "");
});

test("guardian_done plugin cache keys include primary target", () => {
  const cache: PlanTokenCache = new Map();
  const primaryPlanArgs: PlanCacheToolArgs = { repoRoot: "/repo", cwd: "/repo", mode: "plan", primary: true, commitMessage: "feat: primary target" };
  const bareApplyArgs: PlanCacheToolArgs = { repoRoot: "/repo", cwd: "/repo", mode: "apply", confirm: true, confirmToken: "", commitMessage: "feat: primary target" };
  const primaryApplyArgs: PlanCacheToolArgs = { ...bareApplyArgs, primary: true };

  rememberPlanConfirmToken("guardian_done", primaryPlanArgs, { ok: true, status: "planned", confirmToken: "primary-token" }, cache);
  maybeInjectPlanConfirmToken("guardian_done", bareApplyArgs, cache);
  maybeInjectPlanConfirmToken("guardian_done", primaryApplyArgs, cache);

  assert.equal(bareApplyArgs.confirmToken, "");
  assert.equal(primaryApplyArgs.confirmToken, "primary-token");
});

test("guardian_done exposes rescue and injects only a matching confirmed rescue plan token", async (t) => {
  const { createRepoWithOrigin, git } = await import("./helpers.ts");
  const path = await import("node:path");
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "README.md"), "rescued change\n");
  await fs.writeFile(path.join(repo, "rescue-note.txt"), "rescue note\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  assert.equal(typeof hooks.tool.guardian_done.args.rescue.safeParse, "function");

  const planArgs = { repoRoot: repo, cwd: repo, rescue: true, mode: "plan", timestamp: "20260730T120000" };
  const plan = await runTool(hooks.tool.guardian_done.execute, planArgs, context);
  const noConfirm = await runTool(hooks.tool.guardian_done.execute, { ...planArgs, mode: "apply", confirmToken: "" }, context);

  assert.equal(plan.metadata.status, "rescue-planned");
  assert.equal(noConfirm.metadata.status, "blocked");
  assert.equal(await fs.readFile(path.join(repo, "README.md"), "utf8"), "rescued change\n");
  assert.equal((await git(repo, ["for-each-ref", "--format=%(refname)", "refs/opencode-guardian/rescue"])).stdout, "");
  const confirmed = await runTool(hooks.tool.guardian_done.execute, { ...planArgs, mode: "apply", confirm: true, confirmToken: "" }, context);
  assert.equal(confirmed.metadata.status, "rescued");
  await assert.rejects(fs.access(path.join(repo, "rescue-note.txt")));
});

test("guardian_done rescue cache keys separate rescue and changed rescue options", () => {
  const cache: PlanTokenCache = new Map();
  const planArgs: PlanCacheToolArgs = { repoRoot: "/repo", cwd: "/repo", rescue: true, mode: "plan", timestamp: "20260730T120000" };
  const matchingApply: PlanCacheToolArgs = { ...planArgs, mode: "apply", confirm: true, confirmToken: "" };
  const unconfirmedApply: PlanCacheToolArgs = { ...planArgs, mode: "apply", confirmToken: "" };
  const legacyConfirmDeleteApply: PlanCacheToolArgs = { ...planArgs, mode: "apply", confirmDelete: true, confirmToken: "" };
  const ordinaryApply: PlanCacheToolArgs = { ...matchingApply, rescue: false };
  const changedApply: PlanCacheToolArgs = { ...matchingApply, timestamp: "20260730T120001" };

  rememberPlanConfirmToken("guardian_done", planArgs, { ok: true, status: "rescue-planned", confirmToken: "rescue-token" }, cache);
  maybeInjectPlanConfirmToken("guardian_done", matchingApply, cache);
  maybeInjectPlanConfirmToken("guardian_done", unconfirmedApply, cache);
  maybeInjectPlanConfirmToken("guardian_done", legacyConfirmDeleteApply, cache);
  maybeInjectPlanConfirmToken("guardian_done", ordinaryApply, cache);
  maybeInjectPlanConfirmToken("guardian_done", changedApply, cache);

  assert.equal(matchingApply.confirmToken, "rescue-token");
  assert.equal(unconfirmedApply.confirmToken, "");
  assert.equal(legacyConfirmDeleteApply.confirmToken, "");
  assert.equal(ordinaryApply.confirmToken, "");
  assert.equal(changedApply.confirmToken, "");
});
