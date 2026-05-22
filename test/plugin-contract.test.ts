import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import plugin from "../src/index.ts";
import { createRepo } from "./helpers.ts";

const expectedToolNames = [
  "guardian_finish",
  "guardian_preserve",
  "guardian_recover",
  "guardian_report_html",
  "guardian_start",
  "guardian_status",
];

const expectedHookNames = [
  "command.execute.before",
  "event",
  "experimental.chat.system.transform",
  "tool.execute.after",
  "tool.execute.before",
];

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
});

test("guardian_status tool execute returns readable output with raw metadata", async () => {
  const repo = await createRepo();
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

test("README documents local shim and readiness command names", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /export const WorktreeGuardian = Guardian\.server/);
  assert.match(readme, /test:contract/);
  assert.match(readme, /test:smoke:package/);
  assert.match(readme, /test:smoke:host/);
  assert.match(readme, /test:readiness/);
  assert.match(readme, /guardian_report_html/);
  assert.match(readme, /\.git\/opencode-guardian\/report\.html/);
});
