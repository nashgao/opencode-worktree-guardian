import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import plugin from "../src/index.ts";
import { getGuardianPaths, readState, recordSession } from "../src/state.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

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
    "guardian_delete_worktree",
    "guardian_finish",
    "guardian_hygiene",
    "guardian_hygiene_cleanup",
    "guardian_preserve",
    "guardian_recover",
    "guardian_report_html",
    "guardian_start",
    "guardian_status",
    "guardian_unblock_finish",
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

test("tool.execute.before blocks context-mode code payload worktree creation", async () => {
  const hooks = await plugin.server({ directory: "/repo", worktree: "/repo/.worktrees/example" });
  await assert.rejects(
    () => hooks["tool.execute.before"](
      { tool: "context-mode_ctx_execute", sessionID: "ses_123", callID: "call_code", args: { code: "git worktree add /tmp/unmanaged main" } },
      {},
    ),
    /git worktree add outside Guardian-owned roots/,
  );
});


test("tool.execute.before blocks manual protected-branch finish bypasses", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });

  await assert.rejects(
    () => hooks["tool.execute.before"](
      { tool: "bash", sessionID: "ses_bypass", callID: "call_bypass" },
      { args: { command: "git push origin HEAD:main" } },
    ),
    /protected branch.*guardian_finish|guardian_finish.*protected branch/,
  );
});

test("default chat transform auto-starts and owns a worktree", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const records: Array<Record<string, any>> = [];
  const sessionID = "ses_default_auto_start";
  const hooks = await plugin.server({ client: createClient(records), directory: repo, worktree: repo });

  await hooks["experimental.chat.system.transform"](
    { sessionID, taskName: "default auto start" },
    { system: [] },
  );

  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(state.sessions[sessionID].status, "active");
  assert.notEqual(state.sessions[sessionID].worktree_path, repo);
  assert.equal(records[0].invisibleStart.ok, true);
  assert.equal(records[0].directory, repo);
  assert.equal(records[0].worktree, repo);
});

test("explicit autoStart=false disables default chat transform ownership", async (t) => {
  const path = await import("node:path");
  const { git } = await import("./helpers.ts");
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({ autoStart: false }));
  await git(repo, ["add", ".opencode/worktree-guardian.json"]);
  await git(repo, ["commit", "-m", "disable guardian auto start"]);
  const records: Array<Record<string, any>> = [];
  const sessionID = "ses_auto_start_disabled";
  const hooks = await plugin.server({ client: createClient(records), directory: repo, worktree: repo });

  await hooks["experimental.chat.system.transform"](
    { sessionID, taskName: "disabled auto start" },
    { system: [] },
  );

  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config: { ...DEFAULT_CONFIG, autoStart: false } });
  assert.equal(state.sessions[sessionID], undefined);
  assert.equal(records[0].invisibleStart, null);
  assert.equal(records[0].directory, repo);
  assert.equal(records[0].worktree, repo);
});

test("default chat transform does not recreate terminal session worktrees", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const records: Array<Record<string, any>> = [];
  const hooks = await plugin.server({ client: createClient(records), directory: repo, worktree: repo });

  for (const status of ["deleted", "abandoned", "finished", "preserved"]) {
    const sessionID = `ses_terminal_auto_start_${status}`;
    const branch = `guardian/terminal-auto-start-${status}`;
    await git(repo, ["branch", branch, "main"]);
    const { stdout: head } = await git(repo, ["rev-parse", branch]);
    const terminalPath = `${repo}/.worktrees/opencode-worktree-guardian/guardian-session-terminal-auto-start-${status}`;
    await recordSession(repo, DEFAULT_CONFIG, {
      session_id: sessionID,
      status,
      branch,
      worktree_path: terminalPath,
      deleted_worktree_path: terminalPath,
      deleted_branch: branch,
      base_ref: "origin/main",
      head_commit: head,
      safety_refs: [],
    });

    await hooks["experimental.chat.system.transform"](
      { sessionID, taskName: `terminal auto start ${status}` },
      { system: [] },
    );
  }

  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });
  for (const status of ["deleted", "abandoned", "finished", "preserved"]) {
    const sessionID = `ses_terminal_auto_start_${status}`;
    assert.equal(state.sessions[sessionID].status, status);
    assert.match(state.sessions[sessionID].worktree_path, new RegExp(`terminal-auto-start-${status}$`));
  }
  assert.equal(records.length, 4);
  for (const record of records) {
    assert.equal(record.invisibleStart.ok, false);
    assert.match(record.invisibleStart.reason, /terminal/);
  }
});

test("tool.execute.before routes mutating commands to the default auto-start owned worktree", async (t) => {
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

  const output: { args: { command: string; workdir?: string; cwd?: string } } = { args: { command: "touch repo-root-mutation.txt" } };

  await hooks["tool.execute.before"]({ tool: "bash", sessionID, callID: "call_root_mutation" }, output);

  assert.equal(output.args.workdir, state.sessions[sessionID].worktree_path);
  assert.equal(output.args.cwd, state.sessions[sessionID].worktree_path);
});

test("default auto-start repairs poisoned primary ownership before routing mutating commands", async (t) => {
  const { git } = await import("./helpers.ts");
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionID = "ses_auto_start_repair_poisoned";
  const { stdout: commit } = await git(repo, ["rev-parse", "HEAD"]);
  await recordSession(repo, DEFAULT_CONFIG, {
    session_id: sessionID,
    status: "active",
    branch: "main",
    worktree_path: repo,
    base_ref: "origin/main",
    head_commit: commit,
    safety_refs: [],
  });
  const records: Array<Record<string, any>> = [];
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient(records) });

  await hooks["experimental.chat.system.transform"](
    { sessionID, taskName: "repair poisoned" },
    { system: [] },
  );

  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });
  const session = state.sessions[sessionID];
  assert.notEqual(session.worktree_path, repo);
  assert.match(session.branch, /^guardian\//);
  assert.equal(records[0].invisibleStart.repaired, true);

  const output: { args: { command: string; workdir?: string; cwd?: string } } = { args: { command: "touch repaired.txt" } };
  await hooks["tool.execute.before"]({ tool: "bash", sessionID, callID: "call_repaired_poisoned" }, output);

  assert.equal(output.args.workdir, session.worktree_path);
  assert.equal(output.args.cwd, session.worktree_path);
});

test("tool.execute.before allows read-only commands after default auto-start leaves host at repo root", async (t) => {
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

  const deleteOutput = { parts: [] };
  await hooks["command.execute.before"]({ command: "/guardian delete-worktree", sessionID: "ses_123", arguments: [] }, deleteOutput);
  assert.deepEqual(deleteOutput.parts, [{ type: "text", text: "Use the guardian_delete_worktree native tool. Run mode=plan first. Stale local Guardian branch cleanup requires an exact branch or terminal sessionId plus deleteBranch=true and Guardian ownership proof from terminal state or safety refs. Intentional unmerged local abandonment requires deleteBranch=true plus abandonUnmerged=true in both plan and apply after inspecting unmerged commit evidence." }]);

  const cleanupOutput = { parts: [] };
  await hooks["command.execute.before"]({ command: "/guardian hygiene-cleanup", sessionID: "ses_123", arguments: [] }, cleanupOutput);
  assert.deepEqual(cleanupOutput.parts, [{ type: "text", text: "Use the guardian_hygiene_cleanup native tool. Run mode=plan first, inspect exact targets/blockers, get explicit user confirmation, then apply with confirmDelete=true. guardian_hygiene remains report-only." }]);
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

test("hook routes recorded session mutating git commands to the owned worktree", async () => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { repo } = await createRepoWithOrigin();
  const start = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_owned", taskName: "owned", createWorktree: true, config: DEFAULT_CONFIG });
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const addOutput: { args: { command: string; workdir?: string; cwd?: string } } = { args: { command: "git add README.md" } };
  const commitOutput: { args: { command: string; workdir?: string; cwd?: string } } = { args: { command: "git commit -m test" } };

  await hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_owned", callID: "call" }, addOutput);
  await hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_owned", callID: "call" }, commitOutput);

  assert.equal(addOutput.args.workdir, start.session.worktree_path);
  assert.equal(addOutput.args.cwd, start.session.worktree_path);
  assert.equal(commitOutput.args.workdir, start.session.worktree_path);
  assert.equal(commitOutput.args.cwd, start.session.worktree_path);
});

test("hook still blocks destructive recorded session commands instead of routing them", async () => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { repo } = await createRepoWithOrigin();
  await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_destructive", taskName: "destructive", createWorktree: true, config: DEFAULT_CONFIG });
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const output: { args: { command: string; workdir?: string } } = { args: { command: "git reset --hard HEAD~1" } };

  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_destructive", callID: "call" }, output),
    /git reset --hard is blocked/,
  );
  assert.equal(output.args.workdir, undefined);
});

test("hook blocks recorded session mutating commands when the owned worktree is missing", async () => {
  const fs = await import("node:fs/promises");
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { repo } = await createRepoWithOrigin();
  const start = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_missing_owned", taskName: "missing-owned", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.rm(start.session.worktree_path, { recursive: true, force: true });
  const hooks = await plugin.server({ directory: repo, worktree: repo });

  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_missing_owned", callID: "call" }, { args: { command: "git add README.md" } }),
    /recorded worktree.*missing|missing.*recorded worktree/,
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

test("hook allows recorded session commit commands when tool cwd targets the owned worktree", async () => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { repo } = await createRepoWithOrigin();
  const start = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_owned_commit", taskName: "owned-commit", createWorktree: true, config: DEFAULT_CONFIG });
  const hooks = await plugin.server({ directory: repo, worktree: repo });

  await hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_owned_commit", callID: "call", args: { cwd: start.session.worktree_path } }, { args: { command: "git add README.md" } });
  await hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_owned_commit", callID: "call", args: { workdir: start.session.worktree_path } }, { args: { command: "git commit -m test" } });
});

test("hook rewrites symlinked cwd to the recorded owned worktree", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { repo } = await createRepoWithOrigin();
  const start = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_owned_symlink", taskName: "owned-symlink", createWorktree: true, config: DEFAULT_CONFIG });
  const symlinkToBase = path.join(start.session.worktree_path, "base-link");
  await fs.symlink(repo, symlinkToBase, "dir");
  const hooks = await plugin.server({ directory: repo, worktree: repo });

  const output: { args: { command: string; workdir?: string; cwd?: string } } = { args: { command: "git add README.md" } };

  await hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_owned_symlink", callID: "call", args: { cwd: symlinkToBase } }, output);

  assert.equal(output.args.workdir, start.session.worktree_path);
  assert.equal(output.args.cwd, start.session.worktree_path);
});

test("session idle auto-finish uses default create-pr mode when repo opts in", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { guardianStatus } = await import("../src/recover.ts");
  const { repo } = await createRepoWithOrigin();
  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({ autoFinish: true }));
  const { git } = await import("./helpers.ts");
  await git(repo, ["add", ".opencode/worktree-guardian.json"]);
  await git(repo, ["commit", "-m", "add guardian config"]);
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_idle_finish", taskName: "idle finish", createWorktree: true, config: { ...DEFAULT_CONFIG, autoFinish: true } });
  await fs.writeFile(path.join(started.session.worktree_path, "feature.txt"), "idle finish\n");
  await git(started.session.worktree_path, ["add", "feature.txt"]);
  await git(started.session.worktree_path, ["commit", "-m", "add idle finish"]);
  const records: Array<Record<string, any>> = [];
  const hooks = await plugin.server({ client: { app: { async log(event: any) { records.push(event.body); } } }, directory: repo, worktree: repo });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_idle_finish" } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_idle_finish" } } });
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.sessions.find((session: Record<string, any>) => session.session_id === "ses_idle_finish").status, "preserved");
  assert.equal(records.filter((record: Record<string, any>) => record.message === "event").length, 1);
});

test("session idle auto-finish retries after failed finish", async (t) => {
  const path = await import("node:path");
  const { git } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { guardianStatus } = await import("../src/recover.ts");
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({ autoFinish: true }));
  await git(repo, ["add", ".opencode/worktree-guardian.json"]);
  await git(repo, ["commit", "-m", "enable guardian auto finish"]);

  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_idle_retry_finish", taskName: "idle retry", createWorktree: true, config: { ...DEFAULT_CONFIG, autoFinish: true } });
  await fs.writeFile(path.join(started.session.worktree_path, "feature.txt"), "idle retry\n");
  await git(started.session.worktree_path, ["add", "feature.txt"]);
  await git(started.session.worktree_path, ["commit", "-m", "add idle retry"]);
  const dirtyPath = path.join(started.session.worktree_path, "dirty.txt");
  await fs.writeFile(dirtyPath, "dirty\n");

  const records: Array<Record<string, any>> = [];
  const hooks = await plugin.server({ client: createClient(records), directory: repo, worktree: repo });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_idle_retry_finish" } } });

  const firstEvents = records.filter((record) => record.message === "event");
  assert.equal(firstEvents.length, 1);
  assert.equal(firstEvents[0].autoFinish.ok, false);
  assert.match(firstEvents[0].autoFinish.reason, /uncommitted changes|dirty/i);
  let status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.sessions.find((session: Record<string, any>) => session.session_id === "ses_idle_retry_finish").status, "active");

  await fs.rm(dirtyPath);
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_idle_retry_finish" } } });

  const events = records.filter((record) => record.message === "event");
  assert.equal(events.length, 2);
  assert.equal(events[1].autoFinish.ok, true);
  assert.equal(events[1].autoFinish.status, "pr-suggested");
  status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.sessions.find((session: Record<string, any>) => session.session_id === "ses_idle_retry_finish").status, "preserved");
});

test("session idle auto-finish blocks poisoned primary protected ownership with repair guidance", async (t) => {
  const path = await import("node:path");
  const { git } = await import("./helpers.ts");
  const { guardianStatus } = await import("../src/recover.ts");
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({ autoFinish: true }));
  await git(repo, ["add", ".opencode/worktree-guardian.json"]);
  await git(repo, ["commit", "-m", "enable guardian auto finish"]);
  const { stdout: commit } = await git(repo, ["rev-parse", "HEAD"]);
  await recordSession(repo, DEFAULT_CONFIG, {
    session_id: "ses_idle_poisoned_finish",
    status: "active",
    branch: "main",
    worktree_path: repo,
    base_ref: "origin/main",
    head_commit: commit,
    safety_refs: [],
  });

  const records: Array<Record<string, any>> = [];
  const hooks = await plugin.server({ client: createClient(records), directory: repo, worktree: repo });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_idle_poisoned_finish" } } });

  const events = records.filter((record) => record.message === "event");
  assert.equal(events.length, 1);
  assert.equal(events[0].autoFinish.ok, false);
  assert.equal(events[0].autoFinish.status, "blocked");
  assert.match(events[0].autoFinish.reason, /createWorktree=true/);
  assert.equal(events[0].autoFinish.suggestedCommand, "guardian_start createWorktree=true");
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.sessions.find((session: Record<string, any>) => session.session_id === "ses_idle_poisoned_finish").status, "active");
  assert.equal(status.poisonedSessions.some((session: Record<string, any>) => session.session_id === "ses_idle_poisoned_finish"), true);
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

test("tool.execute.before routes mutating commands outside a recorded session worktree", async (t) => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(path.dirname(repo), { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_blocked", taskName: "blocked", createWorktree: true, config: DEFAULT_CONFIG });
  const hooks = await plugin.server({ directory: repo, worktree: repo });

  const output: { args: { command: string; workdir?: string; cwd?: string } } = { args: { command: "touch changed.txt" } };

  await hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_blocked", callID: "call_blocked" }, output);

  assert.equal(output.args.workdir, started.session.worktree_path);
  assert.equal(output.args.cwd, started.session.worktree_path);
});

test("tool.execute.before blocks routed mutating commands when recorded branch binding is stale", async (t) => {
  const { createRepoWithOrigin, git } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(path.dirname(repo), { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_stale_branch", taskName: "stale branch", createWorktree: true, config: DEFAULT_CONFIG });
  await git(started.session.worktree_path, ["checkout", "-b", "feature/tampered-binding"]);
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const output: { args: { command: string; workdir?: string; cwd?: string } } = { args: { command: "git add README.md" } };

  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_stale_branch", callID: "call_stale_branch" }, output),
    /recorded branch does not match checked-out worktree branch/,
  );
  assert.equal(output.args.workdir, undefined);
  assert.equal(output.args.cwd, undefined);
});

test("tool.execute.before does not alignment-block when no session worktree is recorded", async () => {
  const hooks = await plugin.server({ directory: "/repo", worktree: "/repo" });
  await hooks["tool.execute.before"](
    { tool: "bash", sessionID: "ses_missing", callID: "call_missing" },
    { args: { command: "touch changed.txt" } },
  );
});
