import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRepo, createRepoWithOrigin, git, installFakeGh } from "./helpers.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianStart } from "../src/tools.ts";
import { getGuardianPaths } from "../src/state.ts";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const codexCliPath = path.join(projectRoot, "codex", "hooks", "guardian-hook.ts");

type CodexCliOptions = {
  readonly cwd?: string;
  readonly expectedExitCode?: number;
};

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true, () => false);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runCodexCli(args: readonly string[], input = "", options: CodexCliOptions = {}) {
  const child = spawn(process.execPath, [codexCliPath, ...args], {
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

  assert.match(stdout, /^\[GOOD\] guardian_status snapshot/m);
  assert.match(stdout, /\[INFO\] sessions: \d+ \| worktrees: \d+ \| orphaned: \d+ \| poisoned: \d+ \| dirty: \d+/);
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

test("Codex guardian_done cache keys include primary target", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "primary-cache.txt"), "primary\n");

  await runCodexCli(["tool", "guardian_done", JSON.stringify({ repoRoot: repo, cwd: repo, mode: "plan", primary: true, commitMessage: "feat: primary cache" })]);

  const cachePath = path.join((await getGuardianPaths(repo)).dir, "codex-plan-cache.json");
  const cache = JSON.parse(await fs.readFile(cachePath, "utf8")) as { readonly entries?: Record<string, string> };
  const keys = Object.keys(cache.entries ?? {});
  assert.equal(keys.length, 1);
  assert.equal(JSON.parse(keys[0]).primary, true);
});

test("Codex guardian_done lands one dirty session from the primary cwd", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_codex_done_anywhere", taskName: "codex done anywhere", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  const branch = started.session.branch;
  await fs.writeFile(path.join(worktree, "codex-session.txt"), "codex session\n");

  const planArgs = { repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: codex session done" };
  const plan = await runCodexCli(["tool", "guardian_done", JSON.stringify(planArgs)]);

  assert.match(plan.stdout, /\[WARN\] guardian_done planned/);
  assert.match(plan.stdout, /lane: session-finish/);
  assert.match(plan.stdout, /selectedTarget: session session=ses_codex_done_anywhere/);
  assert.match(plan.stdout, /dirty files:\n  - codex-session\.txt/);
  assert.match(plan.stdout, /commitMessage: feat: codex session done/);

  await installFakeGh(t, { repo, branch, dynamicHead: true });
  const apply = await runCodexCli(["tool", "guardian_done", JSON.stringify({ ...planArgs, mode: "apply", confirm: true, timestamp: "20260629T010101" })]);

  assert.match(apply.stdout, /\[GOOD\] guardian_done landed-and-cleaned/);
  assert.match(apply.stdout, /selectedTarget: session session=ses_codex_done_anywhere/);
  assert.match(apply.stdout, /commitMessage: feat: codex session done/);
  assert.match(apply.stdout, /cleanup: deleted worktreeRemoved=true branchDeleted=true/);
  assert.equal(await pathExists(worktree), false);
  await assert.rejects(() => git(repo, ["rev-parse", "--verify", branch]));
  await git(repo, ["cat-file", "-e", "origin/main:codex-session.txt"]);
});

test("Codex guardian_done reports needs-selection for ambiguous dirty targets", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_codex_done_ambiguous", taskName: "codex done ambiguous", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(repo, "codex-primary.txt"), "primary\n");
  await fs.writeFile(path.join(started.session.worktree_path, "codex-session.txt"), "session\n");

  const plan = await runCodexCli(["tool", "guardian_done", JSON.stringify({ repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: ambiguous codex done" })]);

  assert.match(plan.stdout, /\[WARN\] guardian_done needs target selection/);
  assert.match(plan.stdout, /multiple dirty implementation targets/);
  assert.match(plan.stdout, /dirty target candidates: 2/);
  assert.match(plan.stdout, /target=primary/);
  assert.match(plan.stdout, /target=session session=ses_codex_done_ambiguous/);
  assert.match(plan.stdout, /guardian_done primary=true commitMessage=\.\.\./);
  assert.match(plan.stdout, new RegExp(`guardian_done branch=${escapeRegExp(started.session.branch)} commitMessage=\\.\\.\\.`));
});

test("Codex plugin payload is packaged and points at Guardian hooks", async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  const pluginJson = JSON.parse(await fs.readFile(path.join(projectRoot, "codex", ".codex-plugin", "plugin.json"), "utf8"));
  const hooksJson = JSON.parse(await fs.readFile(path.join(projectRoot, "codex", "hooks", "hooks.json"), "utf8"));
  const rootPluginJson = JSON.parse(await fs.readFile(path.join(projectRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const rootHooksJson = JSON.parse(await fs.readFile(path.join(projectRoot, "hooks", "hooks.json"), "utf8"));
  const codexSkillNames = (await fs.readdir(path.join(projectRoot, "codex", "skills"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.equal(packageJson.files.includes("codex"), true);
  assert.equal(packageJson.exports["./codex"], "./codex/hooks/guardian-hook.ts");
  assert.equal(pluginJson.hooks, "./hooks/hooks.json");
  assert.equal(pluginJson.skills, "./skills/");
  assert.match(hooksJson.hooks.PreToolUse[0].hooks[0].command, /^node "\$\{PLUGIN_ROOT\}\/hooks\/guardian-hook\.ts" hook pre-tool-use$/);
  assert.match(hooksJson.hooks.PostToolUse[0].hooks[0].command, /^node "\$\{PLUGIN_ROOT\}\/hooks\/guardian-hook\.ts" hook post-tool-use$/);
  assert.doesNotMatch(hooksJson.hooks.PreToolUse[0].hooks[0].command, /\.\.\/node_modules|\/Users\//);
  assert.equal(rootPluginJson.hooks, "./hooks/hooks.json");
  assert.equal(rootPluginJson.skills, "./codex/skills/");
  assert.match(rootHooksJson.hooks.PreToolUse[0].hooks[0].command, /^node "\$\{PLUGIN_ROOT\}\/codex\/hooks\/guardian-hook\.ts" hook pre-tool-use$/);
  assert.match(rootHooksJson.hooks.PostToolUse[0].hooks[0].command, /^node "\$\{PLUGIN_ROOT\}\/codex\/hooks\/guardian-hook\.ts" hook post-tool-use$/);
  assert.deepEqual(codexSkillNames, [
    "guardian-delete-paths",
    "guardian-delete-worktree",
    "guardian-done",
    "guardian-finish",
    "guardian-finish-workflow",
    "guardian-gc",
    "guardian-hud",
    "guardian-hygiene",
    "guardian-preserve",
    "guardian-project-status",
    "guardian-recover",
    "guardian-report",
    "guardian-start",
    "guardian-status",
    "guardian-unblock-finish",
    "worktree-guardian",
  ]);
});
