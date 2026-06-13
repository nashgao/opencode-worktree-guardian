import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRepo } from "./helpers.ts";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const codexCliPath = path.join(projectRoot, "codex", "hooks", "guardian-hook.ts");

type CodexCliOptions = {
  readonly cwd?: string;
  readonly expectedExitCode?: number;
};

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true, () => false);
}

async function runCodexCli(args: readonly string[], input = "", options: CodexCliOptions = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", codexCliPath, ...args], {
    cwd: options.cwd ?? projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  child.stdin.end(input);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
  const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
  assert.equal(exitCode, options.expectedExitCode ?? 0, stderr);

  return {
    stdout,
    stderr,
  };
}

test("Codex pre-tool hook blocks destructive shell commands", async () => {
  const payload = {
    hook_event_name: "PreToolUse",
    session_id: "ses_codex_block",
    turn_id: "turn_codex_block",
    transcript_path: null,
    cwd: projectRoot,
    model: "test",
    permission_mode: "default",
    tool_name: "Bash",
    tool_use_id: "tool_codex_block",
    tool_input: { command: "git reset --hard" },
  };

  const { stdout } = await runCodexCli(["hook", "pre-tool-use"], `${JSON.stringify(payload)}\n`);
  const output = JSON.parse(stdout);

  assert.equal(output.decision, "block");
  assert.match(output.reason, /Worktree Guardian blocked command/);
});

test("Codex pre-tool hook ignores read-only shell commands", async () => {
  const payload = {
    hook_event_name: "PreToolUse",
    session_id: "ses_codex_readonly",
    turn_id: "turn_codex_readonly",
    transcript_path: null,
    cwd: projectRoot,
    model: "test",
    permission_mode: "default",
    tool_name: "Bash",
    tool_use_id: "tool_codex_readonly",
    tool_input: { command: "git status --short" },
  };

  const { stdout } = await runCodexCli(["hook", "pre-tool-use"], `${JSON.stringify(payload)}\n`);

  assert.equal(stdout, "");
});

test("Codex pre-tool hook ignores malformed hook payloads", async () => {
  const malformedJson = await runCodexCli(["hook", "pre-tool-use"], "{not-json}\n");
  assert.equal(malformedJson.stdout, "");
  assert.equal(malformedJson.stderr, "");

  const missingRequiredFields = await runCodexCli(["hook", "pre-tool-use"], `${JSON.stringify({ hook_event_name: "PreToolUse", tool_input: { command: "git reset --hard" } })}\n`);
  assert.equal(missingRequiredFields.stdout, "");
  assert.equal(missingRequiredFields.stderr, "");
});

test("Codex tool command returns readable guardian status output", async () => {
  const repo = await createRepo();

  const { stdout } = await runCodexCli(["tool", "guardian_status", JSON.stringify({ repoRoot: repo, cwd: repo })]);

  assert.match(stdout, /^\[GOOD\] guardian_status completed/m);
  assert.match(stdout, /\[INFO\] sessions: \d+ \| worktrees: \d+ \| orphaned: \d+ \| dirty: \d+/);
  assert.match(stdout, new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Codex tool command rejects malformed JSON args", async () => {
  const { stderr } = await runCodexCli(["tool", "guardian_status", "[]"], "", { expectedExitCode: 1 });

  assert.match(stderr, /tool args must be a JSON object/);
});

test("Codex tool command applies a cached hygiene plan without exposing confirm token copy steps", async () => {
  const repo = await createRepo();
  const cacheFile = path.join(repo, "node-compile-cache");
  await fs.writeFile(cacheFile, "cache\n");

  const plan = await runCodexCli(["tool", "guardian_hygiene", JSON.stringify({ repoRoot: repo, cwd: repo, mode: "plan", cleanupPaths: ["node-compile-cache"] })]);

  assert.match(plan.stdout, /\[WARN\] guardian_hygiene planned/);
  assert.match(plan.stdout, /confirmDelete=true/);
  assert.doesNotMatch(plan.stdout, /confirmToken|[a-f0-9]{64}/i);
  assert.equal(await pathExists(cacheFile), true);

  const apply = await runCodexCli(["tool", "guardian_hygiene", JSON.stringify({ repoRoot: repo, cwd: repo, mode: "apply", cleanupPaths: ["node-compile-cache"], confirmDelete: true })]);

  assert.match(apply.stdout, /\[GOOD\] guardian_hygiene cleaned/);
  assert.equal(await pathExists(cacheFile), false);
});

test("Codex plugin payload is packaged and points at Guardian hooks", async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  const pluginJson = JSON.parse(await fs.readFile(path.join(projectRoot, "codex", ".codex-plugin", "plugin.json"), "utf8"));
  const hooksJson = JSON.parse(await fs.readFile(path.join(projectRoot, "codex", "hooks", "hooks.json"), "utf8"));

  assert.equal(packageJson.files.includes("codex"), true);
  assert.equal(packageJson.exports["./codex"], "./codex/hooks/guardian-hook.ts");
  assert.equal(pluginJson.hooks, "./hooks/hooks.json");
  assert.equal(pluginJson.skills, "./skills/");
  assert.match(hooksJson.hooks.PreToolUse[0].hooks[0].command, /^node --import tsx "\$\{PLUGIN_ROOT\}\/hooks\/guardian-hook\.ts" hook pre-tool-use$/);
  assert.match(hooksJson.hooks.PostToolUse[0].hooks[0].command, /^node --import tsx "\$\{PLUGIN_ROOT\}\/hooks\/guardian-hook\.ts" hook post-tool-use$/);
  assert.doesNotMatch(hooksJson.hooks.PreToolUse[0].hooks[0].command, /\.\.\/node_modules|\/Users\//);
});
