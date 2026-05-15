import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import plugin from "../src/index.ts";
import { getGuardianPaths, readState } from "../src/state.ts";
import { createRepoWithOrigin } from "./helpers.ts";

function createClient(records: Array<Record<string, any>>) {
  return {
    app: {
      async log(event: any) {
        records.push(event.body);
      },
    },
  };
}

test("exports the current OpenCode plugin object shape", () => {
  assert.equal(plugin.id, "opencode-worktree-guardian");
  assert.equal(typeof plugin.server, "function");
});

test("exposes guardian native tools", async () => {
  const hooks = await plugin.server({ directory: "/repo", worktree: "/repo/.worktrees/example" });
  assert.deepEqual(Object.keys(hooks.tool).sort(), [
    "guardian_finish",
    "guardian_preserve",
    "guardian_recover",
    "guardian_start",
    "guardian_status",
  ]);
});

test("hooks log visibility data without mutating safe hook payloads", async () => {
  const records: Array<Record<string, any>> = [];
  const client = {
    app: {
      async log(event: any) {
        records.push(event.body);
      },
    },
  };
  const hooks = await plugin.server({
    client,
    directory: "/repo",
    worktree: "/repo/.worktrees/example",
  });

  const toolBeforeInput = { tool: "bash", sessionID: "ses_123", callID: "call_123" };
  const toolBeforeOutput = { args: { command: "git status --short" } };
  const toolAfterInput = { ...toolBeforeInput, args: toolBeforeOutput.args };
  const toolAfterOutput = { title: "git", output: "ok", metadata: { exit: 0 } };
  const commandInput = { command: "noop", sessionID: "ses_123", arguments: [] };
  const commandOutput = { parts: [{ type: "text", text: "status" }] };
  const systemInput = { sessionID: "ses_123" };
  const systemOutput = { system: ["one", "two"] };

  const beforeArgsSnapshot = structuredClone(toolBeforeOutput.args);
  const commandPartsSnapshot = structuredClone(commandOutput.parts);
  const systemSnapshot = structuredClone(systemOutput.system);

  await hooks["experimental.chat.system.transform"](systemInput, systemOutput);
  await hooks["tool.execute.before"](toolBeforeInput, toolBeforeOutput);
  await hooks["tool.execute.after"](toolAfterInput, toolAfterOutput);
  await hooks["command.execute.before"](commandInput, commandOutput);

  assert.deepEqual(toolBeforeOutput.args, beforeArgsSnapshot);
  assert.deepEqual(commandOutput.parts, commandPartsSnapshot);
  assert.deepEqual(systemOutput.system, systemSnapshot);
  assert.equal(records.length, 4);
  assert.deepEqual(
    records.map((record) => record.message),
    [
      "chat.system.transform",
      "tool.execute.before",
      "tool.execute.after",
      "command.execute.before",
    ],
  );
  assert.equal(records[1].directory, "/repo");
  assert.equal(records[1].worktree, "/repo/.worktrees/example");
  assert.equal(records[1].input.sessionID, "ses_123");
  assert.equal(records[1].output.args.command, "git status --short");
});

test("hook logs redact likely secret values", async () => {
  const records: Array<Record<string, any>> = [];
  const hooks = await plugin.server({
    client: { app: { async log(event: any) { records.push(event.body); } } },
    directory: "/repo",
    worktree: "/repo/.worktrees/example",
  });

  await hooks["tool.execute.before"](
    { tool: "bash", sessionID: "ses_123", callID: "call_123" },
    { args: { command: "curl -H \"authorization: Bearer secret-token\" https://example.test?api_key=abc" } },
  );

  const logged = JSON.stringify(records[0]);
  assert.doesNotMatch(logged, /secret-token|api_key=abc/);
  assert.match(logged, /<redacted>/);
});

test("tool.execute.before throws to block destructive commands", async () => {
  const hooks = await plugin.server({ directory: "/repo", worktree: "/repo/.worktrees/example" });
  await assert.rejects(
    () => hooks["tool.execute.before"](
      { tool: "bash", sessionID: "ses_123", callID: "call_123" },
      { args: { command: "git worktree remove /repo/.worktrees/example" } },
    ),
    /Worktree Guardian blocked command/,
  );
});

test("auto-start records an owned worktree while host context remains repo root", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const records: Array<Record<string, any>> = [];
  const sessionID = "ses_auto_start_root_context";
  const hooks = await plugin.server({ client: createClient(records), directory: repo, worktree: repo });

  await hooks["experimental.chat.system.transform"](
    { sessionID, taskName: "fail closed root context" },
    { system: [] },
  );

  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });
  const session = state.sessions[sessionID];
  assert.equal(session.status, "active");
  assert.notEqual(session.worktree_path, repo);
  assert.equal(records[0].directory, repo);
  assert.equal(records[0].worktree, repo);
});

test("tool.execute.before blocks mutating commands outside the auto-start owned worktree", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionID = "ses_auto_start_block_mutation";
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });

  await hooks["experimental.chat.system.transform"](
    { sessionID, taskName: "block root mutation" },
    { system: [] },
  );
  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });
  assert.notEqual(state.sessions[sessionID].worktree_path, repo);

  await assert.rejects(
    () => hooks["tool.execute.before"](
      { tool: "bash", sessionID, callID: "call_root_mutation" },
      { args: { command: "touch repo-root-mutation.txt" } },
    ),
    /Worktree Guardian blocked command/,
  );
});

test("tool.execute.before allows read-only commands after auto-start leaves host at repo root", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionID = "ses_auto_start_allow_readonly";
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });

  await hooks["experimental.chat.system.transform"](
    { sessionID, taskName: "allow readonly root context" },
    { system: [] },
  );

  await assert.doesNotReject(() => hooks["tool.execute.before"](
    { tool: "bash", sessionID, callID: "call_root_readonly" },
    { args: { command: "git status --short" } },
  ));
});


test("/guardian slash commands rewrite to native tool instructions", async () => {
  const hooks = await plugin.server({ directory: "/repo", worktree: "/repo/.worktrees/example" });
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "/guardian status", sessionID: "ses_123", arguments: [] }, output);
  assert.deepEqual(output.parts, [{ type: "text", text: "Use the guardian_status native tool." }]);
});

test("session idle auto-finish is opt-in and deduplicated", async () => {
  const records: Array<Record<string, any>> = [];
  const hooks = await plugin.server({
    client: { app: { async log(event: any) { records.push(event.body); } } },
    directory: "/not-a-repo",
    worktree: "/not-a-repo",
  });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_idle" } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_idle" } } });
  assert.equal(records.some((record) => record.message === "event"), false);
});

test("hook blocks rm -rf against sibling guardian worktree", async () => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { repo } = await createRepoWithOrigin();
  const a = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_hook_a", taskName: "a", createWorktree: true, config: DEFAULT_CONFIG });
  const b = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_hook_b", taskName: "b", createWorktree: true, config: DEFAULT_CONFIG });
  const hooks = await plugin.server({ directory: repo, worktree: a.session.worktree_path });
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_hook_a", callID: "call" }, { args: { command: `rm -rf ${b.session.worktree_path}` } }),
    /Worktree Guardian blocked command/,
  );
});

test("hook blocks recorded session mutating git commands outside the owned worktree", async () => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { repo } = await createRepoWithOrigin();
  const start = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_owned", taskName: "owned", createWorktree: true, config: DEFAULT_CONFIG });
  const hooks = await plugin.server({ directory: repo, worktree: repo });

  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_owned", callID: "call" }, { args: { command: "git add README.md" } }),
    (error: Error) => error.message.includes(start.session.worktree_path) && error.message.includes("actual cwd") && error.message.includes("actual worktree"),
  );
});

test("hook allows recorded session commands in the owned worktree", async () => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { repo } = await createRepoWithOrigin();
  const start = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_owned_ok", taskName: "owned-ok", createWorktree: true, config: DEFAULT_CONFIG });
  const hooks = await plugin.server({ directory: repo, worktree: start.session.worktree_path });

  await hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_owned_ok", callID: "call" }, { args: { command: "git status --short" } });
});

test("session idle auto-finish preserves when repo opts in", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { createRepoWithOrigin, makeBranchCommit } = await import("./helpers.ts");
  const { recordSession } = await import("../src/state.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { guardianStatus } = await import("../src/recover.ts");
  const { repo } = await createRepoWithOrigin();
  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({ autoFinish: true }));
  const { git } = await import("./helpers.ts");
  await git(repo, ["add", ".opencode/worktree-guardian.json"]);
  await git(repo, ["commit", "-m", "add guardian config"]);
  const { branch, commit } = await makeBranchCommit(repo, "guardian/idle");
  await recordSession(repo, DEFAULT_CONFIG, {
    session_id: "ses_idle_finish",
    status: "active",
    branch,
    worktree_path: repo,
    base_ref: "origin/main",
    head_commit: commit,
    safety_refs: [],
  });
  const records: Array<Record<string, any>> = [];
  const hooks = await plugin.server({ client: { app: { async log(event: any) { records.push(event.body); } } }, directory: repo, worktree: repo });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_idle_finish" } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_idle_finish" } } });
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.sessions.find((session: Record<string, any>) => session.session_id === "ses_idle_finish").status, "preserved");
  assert.equal(records.filter((record: Record<string, any>) => record.message === "event").length, 1);
});


test("session idle auto-finish uses the recorded worktree when host context is repo root", async (t) => {
  const path = await import("node:path");
  const { guardianStart } = await import("../src/tools.ts");
  const { guardianStatus } = await import("../src/recover.ts");
  const { git } = await import("./helpers.ts");
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({ autoFinish: true }));
  await git(repo, ["add", ".opencode/worktree-guardian.json"]);
  await git(repo, ["commit", "-m", "enable guardian auto finish"]);

  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_idle_recorded_worktree", taskName: "idle recorded worktree", createWorktree: true, config: { ...DEFAULT_CONFIG, autoFinish: true } });
  const records: Array<Record<string, any>> = [];
  const hooks = await plugin.server({ client: createClient(records), directory: repo, worktree: repo });

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_idle_recorded_worktree" } } });

  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const session = status.sessions.find((candidate: Record<string, any>) => candidate.session_id === "ses_idle_recorded_worktree");
  assert.equal(session.status, "preserved");
  assert.equal(session.worktree_path, started.session.worktree_path);
  assert.equal(records.filter((record) => record.message === "event").length, 1);
});

test("tool.execute.before allows read-only inspection outside a recorded session worktree", async (t) => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(path.dirname(repo), { recursive: true, force: true }));
  await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_readonly", taskName: "readonly", createWorktree: true, config: DEFAULT_CONFIG });
  const hooks = await plugin.server({ directory: repo, worktree: repo });

  await hooks["tool.execute.before"](
    { tool: "bash", sessionID: "ses_readonly", callID: "call_readonly" },
    { args: { command: "git status --short" } },
  );
});

test("tool.execute.before blocks mutating commands outside a recorded session worktree", async (t) => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(path.dirname(repo), { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_blocked", taskName: "blocked", createWorktree: true, config: DEFAULT_CONFIG });
  const hooks = await plugin.server({ directory: repo, worktree: repo });

  await assert.rejects(
    () => hooks["tool.execute.before"](
      { tool: "bash", sessionID: "ses_blocked", callID: "call_blocked" },
      { args: { command: "touch changed.txt" } },
    ),
    (error: Error) => error.message.includes(started.session.worktree_path) && error.message.includes("actual cwd") && error.message.includes("actual worktree"),
  );
});

test("tool.execute.before does not alignment-block when no session worktree is recorded", async () => {
  const hooks = await plugin.server({ directory: "/repo", worktree: "/repo" });
  await hooks["tool.execute.before"](
    { tool: "bash", sessionID: "ses_missing", callID: "call_missing" },
    { args: { command: "touch changed.txt" } },
  );
});
