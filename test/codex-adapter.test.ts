import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRepo, createRepoWithOrigin, createTempDir, git, installFakeGh } from "./helpers.ts";
import { CONFIG_PATH, DEFAULT_CONFIG } from "../src/config.ts";
import { guardianStart } from "../src/tools.ts";
import { getGuardianPaths } from "../src/state.ts";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const codexCliPath = path.join(projectRoot, "codex", "hooks", "guardian-hook.ts");

type CodexCliOptions = {
  readonly cwd?: string;
  readonly expectedExitCode?: number;
  readonly sessionId?: string;
  readonly stateHome?: string;
};

function preToolPayload(cwd: string, command: string) {
  return {
    hook_event_name: "PreToolUse",
    session_id: "ses_codex_hook",
    cwd,
    tool_name: "Bash",
    tool_input: { command },
  };
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true, () => false);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runCodexCli(args: readonly string[], input = "", options: CodexCliOptions = {}) {
  const child = spawn(process.execPath, [codexCliPath, ...args], {
    cwd: options.cwd ?? projectRoot,
    env: { ...process.env, CODEX_SESSION_ID: options.sessionId ?? "", XDG_STATE_HOME: options.stateHome ?? "" },
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

test("Codex pre-tool hook audits destructive shell commands with missing or default config", async () => {
  const repo = await createRepo();
  const payload = preToolPayload(repo, "git reset --hard");

  const missingConfig = await runCodexCli(["hook", "pre-tool-use"], `${JSON.stringify(payload)}\n`);
  assert.equal(missingConfig.stdout, "");

  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, CONFIG_PATH), `${JSON.stringify(DEFAULT_CONFIG)}\n`);

  const defaultConfig = await runCodexCli(["hook", "pre-tool-use"], `${JSON.stringify(payload)}\n`);
  assert.equal(defaultConfig.stdout, "");
});

test("Codex pre-tool hook blocks classified shell commands in strict mode", async () => {
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, CONFIG_PATH), `${JSON.stringify({ commandInterceptionMode: "strict" })}\n`);
  const payload = preToolPayload(repo, "git reset --hard");

  const { stdout } = await runCodexCli(["hook", "pre-tool-use"], `${JSON.stringify(payload)}\n`);
  const output = JSON.parse(stdout);

  assert.equal(output.decision, "block");
  assert.match(output.reason, /Worktree Guardian blocked command/);
});

test("Codex pre-tool hook fails closed for invalid configuration", async () => {
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, CONFIG_PATH), `${JSON.stringify({ commandInterceptionMode: "enforce" })}\n`);
  const payload = preToolPayload(repo, "git reset --hard");

  const { stdout, stderr } = await runCodexCli(["hook", "pre-tool-use"], `${JSON.stringify(payload)}\n`);
  const output = JSON.parse(stdout);

  assert.equal(output.decision, "block");
  assert.match(output.reason, /Unsupported worktree guardian commandInterceptionMode: enforce/);
  assert.equal(stderr, "");
});

test("Codex pre-tool hook ignores read-only shell commands", async () => {
  const payload = preToolPayload(projectRoot, "git status --short");

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
  const configPath = path.join(repo, CONFIG_PATH);

  const { stdout } = await runCodexCli(["tool", "guardian_status", JSON.stringify({ repoRoot: repo, cwd: repo })]);

  assert.match(stdout, /^\[GOOD\] Guardian Status: Clean/m);
  assert.match(stdout, /Config\n  defaults active; .*worktree-guardian\.json not written\n  guardian_init to write repo config/);
  assert.match(stdout, /Work Now\n  Active sessions: 0\n  Worktrees: \d+\n  Dirty files: 0\n  Stashes: 0\n  Orphaned sessions: 0\n  Poisoned sessions: 0\n  Recovery candidates: 0/);
  assert.match(stdout, /History\n  Retained terminal sessions: 0\n  Safety refs: 0\n  Preserved refs: 0/);
  assert.match(stdout, new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(await pathExists(configPath), false);
});

test("Codex guardian_init writes default repo config idempotently", async () => {
  const repo = await createRepo();
  const configPath = path.join(repo, CONFIG_PATH);

  const created = await runCodexCli(["tool", "guardian_init", JSON.stringify({ repoRoot: repo, cwd: repo })]);
  const existing = await runCodexCli(["tool", "guardian_init", JSON.stringify({ repoRoot: repo, cwd: repo })]);

  assert.match(created.stdout, /\[GOOD\] guardian_init created/);
  assert.match(created.stdout, /wrote default Guardian config/);
  assert.match(existing.stdout, /\[INFO\] guardian_init exists/);
  assert.match(existing.stdout, /config already exists; left unchanged/);
  assert.equal(await pathExists(configPath), true);
  assert.equal(JSON.parse(await fs.readFile(configPath, "utf8")).protectedPaths.includes(".milestones"), true);
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

test("Codex guardian_goal guides confirmed apply for strict planned-partial plans without exposing tokens", async () => {
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, CONFIG_PATH), `${JSON.stringify({
    ...DEFAULT_CONFIG,
    goal: {
      ...DEFAULT_CONFIG.goal,
      commitDirty: false,
      landToBase: false,
      pushBase: false,
      cleanupWorktrees: false,
      cleanupBranches: false,
      cleanupHygiene: true,
      hygieneCompletion: "no-unprotected-findings",
    },
  })}\n`);
  await fs.mkdir(path.join(repo, "guardian-suspicious"));
  await fs.writeFile(path.join(repo, "guardian-suspicious", "notes.txt"), "notes\n");

  const { stdout } = await runCodexCli(["tool", "guardian_goal", JSON.stringify({ repoRoot: repo, cwd: repo, mode: "plan" })]);

  assert.match(stdout, /\[WARN\] guardian_goal planned-partial/);
  assert.match(stdout, /After explicit user confirmation/);
  assert.doesNotMatch(stdout, /trackGoal alone is not approval/);
  assert.doesNotMatch(stdout, /confirmToken|[a-f0-9]{64}/i);
});

test("Codex continues an explicitly tracked Guardian Goal across CLI processes", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "ses_codex_goal_continuation";
  const options = { sessionId, stateHome: path.join(base, "codex-state") };
  const plan = await runCodexCli(["tool", "guardian_goal", JSON.stringify({ repoRoot: repo, cwd: repo, mode: "plan", trackGoal: true })], "", options);
  assert.match(plan.stdout, /guardian_goal planned/);
  assert.match(plan.stdout, /If the user requested Guardian Goal completion/);
  assert.match(plan.stdout, /trackGoal alone is not approval/);

  const stopped = await runCodexCli(["hook", "stop"], `${JSON.stringify({ hook_event_name: "Stop", session_id: sessionId, turn_id: "turn_goal", cwd: projectRoot, stop_hook_active: false })}\n`, options);
  const decision = JSON.parse(stopped.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /Guardian Goal remains incomplete/);

  const unchanged = await runCodexCli(["hook", "stop"], `${JSON.stringify({ hook_event_name: "Stop", session_id: sessionId, turn_id: "turn_goal_continued", cwd: projectRoot, stop_hook_active: true })}\n`, options);
  assert.equal(unchanged.stdout, "");

  const resumed = await runCodexCli(["hook", "session-start"], `${JSON.stringify({ hook_event_name: "SessionStart", session_id: sessionId, cwd: projectRoot, source: "resume" })}\n`, options);
  const reminder = JSON.parse(resumed.stdout);
  assert.match(reminder.hookSpecificOutput.additionalContext, /tracked Guardian Goal for .* remains planned/);
  assert.doesNotMatch(resumed.stdout, /confirmToken|[a-f0-9]{64}/i);
});

test("Codex package registers Guardian Goal continuation hooks", async () => {
  for (const relativePath of ["hooks/hooks.json", "codex/hooks/hooks.json"]) {
    const configuration = JSON.parse(await fs.readFile(path.join(projectRoot, relativePath), "utf8")) as { hooks: Record<string, unknown> };
    assert.match(JSON.stringify(configuration.hooks["Stop"]), /guardian-hook\.ts.*hook stop/);
    assert.match(JSON.stringify(configuration.hooks["SessionStart"]), /guardian-hook\.ts.*hook session-start/);
  }
});

test("Codex does not claim durable Guardian Goal tracking without a session identity", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const plan = await runCodexCli(["tool", "guardian_goal", JSON.stringify({ repoRoot: repo, cwd: repo, mode: "plan", trackGoal: true })]);

  assert.match(plan.stdout, /continuation checkpoint unavailable because CODEX_SESSION_ID is absent/);
});

test("Codex tracked Guardian Goal still applies with its planned token and clears the checkpoint", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "ses_codex_goal_complete";
  const args = { repoRoot: repo, cwd: repo, trackGoal: true };
  const options = { sessionId, stateHome: path.join(base, "codex-state") };
  await runCodexCli(["tool", "guardian_goal", JSON.stringify({ ...args, mode: "plan" })], "", options);

  const applied = await runCodexCli(["tool", "guardian_goal", JSON.stringify({ ...args, mode: "apply", confirm: true })], "", options);
  assert.match(applied.stdout, /guardian_goal complete/);

  const stopped = await runCodexCli(["hook", "stop"], `${JSON.stringify({ hook_event_name: "Stop", session_id: sessionId, turn_id: "turn_done", cwd: repo, stop_hook_active: false })}\n`, options);
  assert.equal(stopped.stdout, "");
});

test("Codex continuation bookkeeping does not stale a proven clean Guardian Goal", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, CONFIG_PATH), `${JSON.stringify({ goal: { quarantineSessionResidue: true } })}\n`);
  await git(repo, ["add", CONFIG_PATH]);
  await git(repo, ["commit", "-m", "enable clean completion proof"]);
  await git(repo, ["push", "origin", "main"]);
  const sessionId = "ses_codex_goal_proven";
  const args = { repoRoot: repo, cwd: repo, trackGoal: true };
  const options = { sessionId, stateHome: path.join(base, "codex-state") };
  await runCodexCli(["tool", "guardian_goal", JSON.stringify({ ...args, mode: "plan" })], "", options);
  const applied = await runCodexCli(["tool", "guardian_goal", JSON.stringify({ ...args, mode: "apply", confirm: true })], "", options);
  assert.match(applied.stdout, /guardian_goal complete/);

  const status = await runCodexCli(["tool", "guardian_status", JSON.stringify({ repoRoot: repo, cwd: repo })], "", options);
  assert.match(status.stdout, /Clean Completion Proof\n  status: proven/);
});

test("Codex pauses a tracked Guardian Goal when an approving review is required", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "ses_codex_goal_review_wait";
  const options = { sessionId, stateHome: path.join(base, "codex-state") };
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "review wait", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  const branch = started.session.branch;
  await fs.writeFile(path.join(worktree, "feature.txt"), "review pending\n");
  await git(worktree, ["add", "feature.txt"]);
  await git(worktree, ["commit", "-m", "add review-pending feature"]);
  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  await installFakeGh(t, { repo, branch, head, mergeFails: true });
  const args = { repoRoot: repo, cwd: worktree, sessionId, intentionalPaths: ["feature.txt"], trackGoal: true };
  const plan = await runCodexCli(["tool", "guardian_goal", JSON.stringify({ ...args, mode: "plan" })], "", options);
  assert.match(plan.stdout, /guardian_goal planned/);

  const applied = await runCodexCli(["tool", "guardian_goal", JSON.stringify({ ...args, mode: "apply", confirm: true })], "", options);
  assert.match(applied.stdout, /approving review/i);
  const stopped = await runCodexCli(["hook", "stop"], `${JSON.stringify({ hook_event_name: "Stop", session_id: sessionId, turn_id: "turn_review", cwd: repo, stop_hook_active: false })}\n`, options);
  assert.equal(stopped.stdout, "");
  await fs.access(worktree);
});

test("Codex reports a completed Guardian Goal after its session worktree is removed", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "ses_codex_goal_removed_worktree";
  const options = { sessionId, stateHome: path.join(base, "codex-state") };
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "completed goal", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  const branch = started.session.branch;
  await fs.writeFile(path.join(worktree, "feature.txt"), "finished feature\n");
  await git(worktree, ["add", "feature.txt"]);
  await git(worktree, ["commit", "-m", "add completed feature"]);
  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  await installFakeGh(t, { repo, branch, head });
  const args = { repoRoot: repo, cwd: worktree, sessionId, intentionalPaths: ["feature.txt"], trackGoal: true };
  const plan = await runCodexCli(["tool", "guardian_goal", JSON.stringify({ ...args, mode: "plan" })], "", options);
  assert.match(plan.stdout, /guardian_goal planned/);

  const applied = await runCodexCli(["tool", "guardian_goal", JSON.stringify({ ...args, mode: "apply", confirm: true })], "", options);
  assert.match(applied.stdout, /guardian_goal complete/);
  assert.equal(await pathExists(worktree), false);
  const stopped = await runCodexCli(["hook", "stop"], `${JSON.stringify({ hook_event_name: "Stop", session_id: sessionId, cwd: repo })}\n`, options);
  assert.equal(stopped.stdout, "");
});

test("Codex surfaces a corrupt continuation checkpoint without hiding Guardian output", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "ses_codex_goal_corrupt_checkpoint";
  const stateHome = path.join(base, "codex-state");
  const options = { sessionId, stateHome };
  await runCodexCli(["tool", "guardian_goal", JSON.stringify({ repoRoot: repo, cwd: repo, mode: "plan", trackGoal: true })], "", options);
  const sessionKey = createHash("sha256").update(sessionId).digest("hex");
  await fs.writeFile(path.join(stateHome, "opencode-worktree-guardian", "codex-goals", `${sessionKey}.json`), "invalid-json\n");

  const stopped = await runCodexCli(["hook", "stop"], `${JSON.stringify({ hook_event_name: "Stop", session_id: sessionId, cwd: repo })}\n`, options);
  assert.match(JSON.parse(stopped.stdout).systemMessage, /continuation check failed/i);
  const plan = await runCodexCli(["tool", "guardian_goal", JSON.stringify({ repoRoot: repo, cwd: repo, mode: "plan", trackGoal: true })], "", options);
  assert.match(plan.stdout, /guardian_goal planned/);
  assert.match(plan.stdout, /continuation checkpoint failed/);
});

test("Codex does not replace an unfinished tracked goal with another repository", async (t) => {
  const first = await createRepoWithOrigin();
  const second = await createRepoWithOrigin();
  t.after(() => fs.rm(first.base, { recursive: true, force: true }));
  t.after(() => fs.rm(second.base, { recursive: true, force: true }));
  const sessionId = "ses_codex_goal_two_repos";
  const options = { sessionId, stateHome: path.join(first.base, "codex-state") };
  await runCodexCli(["tool", "guardian_goal", JSON.stringify({ repoRoot: first.repo, cwd: first.repo, mode: "plan", trackGoal: true })], "", options);

  const competing = await runCodexCli(["tool", "guardian_goal", JSON.stringify({ repoRoot: second.repo, cwd: second.repo, mode: "plan", trackGoal: true })], "", options);
  assert.match(competing.stdout, /guardian_goal planned/);
  assert.match(competing.stdout, /already tracks an unfinished Guardian Goal/);
  const resumed = await runCodexCli(["hook", "session-start"], `${JSON.stringify({ hook_event_name: "SessionStart", session_id: sessionId, cwd: second.repo })}\n`, options);
  assert.match(JSON.parse(resumed.stdout).hookSpecificOutput.additionalContext, new RegExp(escapeRegExp(first.repo)));
  assert.doesNotMatch(resumed.stdout, new RegExp(escapeRegExp(second.repo)));
});

test("Codex tracks one repository consistently across its primary and session worktrees", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "ses_codex_goal_same_repo_worktrees";
  const options = { sessionId, stateHome: path.join(base, "codex-state") };
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "same repo worktrees", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  const first = await runCodexCli(["tool", "guardian_goal", JSON.stringify({ repoRoot: worktree, cwd: worktree, sessionId, mode: "plan", trackGoal: true })], "", options);
  assert.match(first.stdout, /guardian_goal blocked/);

  const second = await runCodexCli(["tool", "guardian_goal", JSON.stringify({ repoRoot: repo, cwd: repo, sessionId, mode: "plan", trackGoal: true })], "", options);
  assert.match(second.stdout, /guardian_goal planned/);
  assert.doesNotMatch(second.stdout, /already tracks an unfinished Guardian Goal/);
  const resumed = await runCodexCli(["hook", "session-start"], `${JSON.stringify({ hook_event_name: "SessionStart", session_id: sessionId, cwd: repo })}\n`, options);
  assert.match(JSON.parse(resumed.stdout).hookSpecificOutput.additionalContext, new RegExp(escapeRegExp(repo)));
});

test("Codex gives a blocked tracked Guardian Goal one recovery pass", async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const sessionId = "ses_codex_goal_blocked";
  const stateHome = await createTempDir("guardian-codex-state-");
  t.after(() => fs.rm(stateHome, { recursive: true, force: true }));
  const options = { sessionId, stateHome };
  const plan = await runCodexCli(["tool", "guardian_goal", JSON.stringify({ repoRoot: repo, cwd: repo, mode: "plan", trackGoal: true })], "", options);
  assert.match(plan.stdout, /guardian_goal blocked/);

  const payload = `${JSON.stringify({ hook_event_name: "Stop", session_id: sessionId, turn_id: "turn_blocked", cwd: repo, stop_hook_active: false })}\n`;
  const first = await runCodexCli(["hook", "stop"], payload, options);
  assert.match(JSON.parse(first.stdout).reason, /Guardian Goal remains incomplete/);
  const unchanged = await runCodexCli(["hook", "stop"], payload, options);
  assert.equal(unchanged.stdout, "");
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

test("Codex guardian_goal cache keys normalize allowed remote branches", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  // When
  await runCodexCli(["tool", "guardian_goal", JSON.stringify({
    repoRoot: repo,
    cwd: repo,
    mode: "plan",
    allowedRemoteBranches: ["ä", "z", "ä"],
  })]);

  // Then
  const cachePath = path.join((await getGuardianPaths(repo)).dir, "codex-plan-cache.json");
  const cache = JSON.parse(await fs.readFile(cachePath, "utf8")) as { readonly entries?: Record<string, string> };
  const keys = Object.keys(cache.entries ?? {});
  assert.equal(keys.length, 1);
  assert.deepEqual(JSON.parse(keys[0]).allowedRemoteBranches, ["z", "ä"]);
});

test("Codex guardian_done lands one dirty session from the primary cwd", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_codex_done_anywhere", taskName: "codex done anywhere", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  const branch = started.session.branch;
  await fs.writeFile(path.join(worktree, "codex-session.txt"), "codex session\n");

  const planArgs = { repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: codex session done", timestamp: "20260629T010101" };
  const plan = await runCodexCli(["tool", "guardian_done", JSON.stringify(planArgs)]);

  assert.match(plan.stdout, /\[WARN\] guardian_done planned/);
  assert.match(plan.stdout, /lane: session-finish/);
  assert.match(plan.stdout, /selectedTarget: session session=ses_codex_done_anywhere/);
  assert.match(plan.stdout, /dirty files: 1\n  - codex-session\.txt/);
  assert.match(plan.stdout, /commitMessage: feat: codex session done/);

  await installFakeGh(t, { repo, branch, dynamicHead: true });
  const apply = await runCodexCli(["tool", "guardian_done", JSON.stringify({ ...planArgs, mode: "apply", confirm: true })]);

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
