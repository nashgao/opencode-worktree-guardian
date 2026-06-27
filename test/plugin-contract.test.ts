import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import plugin from "../src/index.ts";
import type { GuardianToolName } from "../src/types.ts";

const expectedToolNames = [
  "guardian_delete_paths",
  "guardian_delete_worktree",
  "guardian_done",
  "guardian_finish",
  "guardian_finish_workflow",
  "guardian_gc",
  "guardian_hygiene",
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
  ["hygiene", "guardian_hygiene"],
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
