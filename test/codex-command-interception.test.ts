import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CONFIG_PATH, DEFAULT_CONFIG } from "../src/config.ts";
import { recordSession } from "../src/state.ts";
import { createRepo, createRepoWithOrigin, git } from "./helpers.ts";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const codexCliPath = path.join(projectRoot, "codex", "hooks", "guardian-hook.ts");

type CodexHookPayload = Readonly<{
  readonly hook_event_name: "PreToolUse";
  readonly session_id: string;
  readonly cwd: string;
  readonly tool_name: "Bash";
  readonly tool_input: Readonly<{ readonly command: string }>;
}>;

type HookResult = Readonly<{
  readonly stdout: string;
  readonly stderr: string;
}>;

async function runPreToolUse(payload: CodexHookPayload): Promise<HookResult> {
  const env = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  delete env.OPENCODE_WORKTREE_GUARDIAN_COVERAGE_RUN;
  delete env.NODE_COMPILE_CACHE;
  const child = spawn(process.execPath, [codexCliPath, "hook", "pre-tool-use"], {
    cwd: payload.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout.push(chunk));
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));
  child.stdin.end(`${JSON.stringify(payload)}\n`);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const result = { stdout: stdout.join(""), stderr: stderr.join("") };
  assert.equal(exitCode, 0, result.stderr);
  return result;
}

async function writeConfig(repo: string, config: unknown): Promise<void> {
  const configPath = path.join(repo, CONFIG_PATH);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config));
}

function payload(cwd: string, sessionId: string, command: string): CodexHookPayload {
  return {
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    cwd,
    tool_name: "Bash",
    tool_input: { command },
  };
}

function assertBlocked(result: HookResult): void {
  assert.match(result.stdout, /"decision":"block"/);
  assert.match(result.stdout, /Worktree Guardian blocked command/);
}

test("Codex honors root strict config when the payload cwd is nested", async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const nested = path.join(repo, "nested", "directory");
  await fs.mkdir(nested, { recursive: true });
  await writeConfig(repo, { commandInterceptionMode: "strict", branchPrefix: "release/" });

  assertBlocked(await runPreToolUse(payload(nested, "ses_nested_config", "git merge release/inflight")));
});

test("Codex fails closed when the root Guardian config is not an object", async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await writeConfig(repo, "strict");

  assertBlocked(await runPreToolUse(payload(repo, "ses_invalid_config", "git merge untrusted-feature")));
});

test("Codex blocks a recorded Guardian branch merged into a protected worktree", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionWorktree = path.join(base, "codex-session");
  await writeConfig(repo, { commandInterceptionMode: "strict", branchPrefix: "guardian/" });
  await git(repo, ["worktree", "add", "-b", "codex/session", sessionWorktree]);
  await recordSession(repo, DEFAULT_CONFIG, {
    session_id: "ses_recorded_guardian",
    status: "active",
    branch: "codex/session",
    worktree_path: sessionWorktree,
  });

  assertBlocked(await runPreToolUse(payload(
    sessionWorktree,
    "ses_recorded_guardian",
    `git -C ${repo} merge codex/session`,
  )));
});

test("Codex blocks implicit transport commands that target Guardian-reserved refs", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await writeConfig(repo, { commandInterceptionMode: "strict" });
  await git(repo, ["config", "remote.origin.fetch", "+refs/heads/*:refs/stash"]);

  assertBlocked(await runPreToolUse(payload(repo, "ses_stash_fetch", "git fetch")));

  await git(repo, ["config", "remote.origin.push", "+refs/heads/*:refs/opencode-guardian/codex"]);
  assertBlocked(await runPreToolUse(payload(repo, "ses_guardian_push", "git push")));
});
