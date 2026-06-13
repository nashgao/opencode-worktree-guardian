import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import plugin from "../src/index.ts";
import { getGuardianPaths, readState, recordSession } from "../src/state.ts";
import type { GuardianSession } from "../src/types.ts";
import { createRepoWithOrigin, git, seedSession } from "./helpers.ts";

type LooseRecord = Record<string, unknown>;

function isLooseRecord(value: unknown): value is LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordValue(value: unknown): LooseRecord {
  if (!isLooseRecord(value)) throw new TypeError("expected record");
  return value;
}

function createClient(records: Array<LooseRecord>) {
  return {
    app: {
      async log(event: { readonly body: LooseRecord }) {
        records.push(event.body);
      },
    },
  };
}

function requireSession(session: GuardianSession | undefined): GuardianSession {
  assert.ok(session);
  return session;
}

function findSession(sessions: readonly GuardianSession[], sessionId: string): GuardianSession {
  return requireSession(sessions.find((session) => session.session_id === sessionId));
}

test("exports the current OpenCode plugin object shape", () => {
  assert.equal(plugin.id, "opencode-worktree-guardian");
  assert.equal(typeof plugin.server, "function");
});

test("exposes guardian native tools", async () => {
  const hooks = await plugin.server({ directory: "/repo", worktree: "/repo/.worktrees/example" });
  assert.deepEqual(Object.keys(hooks.tool).sort(), [
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
  ]);
});

test("hooks log visibility data without mutating safe hook payloads", async () => {
  const records: Array<LooseRecord> = [];
  const client = {
    app: {
      async log(event: { readonly body: LooseRecord }) {
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
  assert.equal(recordValue(records[1].input).sessionID, "ses_123");
  assert.equal(recordValue(recordValue(records[1].output).args).command, "git status --short");
});

test("hook logs redact likely secret values", async () => {
  const records: Array<LooseRecord> = [];
  const hooks = await plugin.server({
    client: { app: { async log(event: { readonly body: LooseRecord }) { records.push(event.body); } } },
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
  const records: Array<LooseRecord> = [];
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
  assert.equal(recordValue(records[0].invisibleStart).ok, true);
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
  const records: Array<LooseRecord> = [];
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
  const records: Array<LooseRecord> = [];
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
    const session = requireSession(state.sessions[sessionID]);
    assert.equal(session.status, status);
    assert.match(String(session.worktree_path), new RegExp(`terminal-auto-start-${status}$`));
  }
  assert.equal(records.length, 4);
  for (const record of records) {
    const invisibleStart = recordValue(record.invisibleStart);
    assert.equal(invisibleStart.ok, false);
    assert.match(String(invisibleStart.reason), /terminal/);
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
  await seedSession(repo, {
    session_id: sessionID,
    status: "active",
    branch: "main",
    worktree_path: repo,
    base_ref: "origin/main",
    head_commit: commit,
    safety_refs: [],
  });
  const records: Array<LooseRecord> = [];
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient(records) });

  await hooks["experimental.chat.system.transform"](
    { sessionID, taskName: "repair poisoned" },
    { system: [] },
  );

  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });
  const session = requireSession(state.sessions[sessionID]);
  assert.notEqual(session.worktree_path, repo);
  assert.match(String(session.branch), /^guardian\//);
  assert.equal(recordValue(records[0].invisibleStart).repaired, true);

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

test("tool.execute.before allows normal git when stale guardian state cannot route", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionID = "ses_stale_normal_git";
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });
  const missingWorktree = `${repo}/.worktrees/opencode-worktree-guardian/missing-normal-git`;
  const { stdout: head } = await git(repo, ["rev-parse", "HEAD"]);
  await recordSession(repo, DEFAULT_CONFIG, {
    session_id: sessionID,
    status: "active",
    branch: "guardian/missing-normal-git",
    worktree_path: missingWorktree,
    base_ref: "origin/main",
    head_commit: head,
    safety_refs: [],
  });

  for (const command of ["git add README.md", "git commit -m noop", "git fetch --prune origin", "git push origin main"]) {
    await assert.doesNotReject(() => hooks["tool.execute.before"](
      { tool: "bash", sessionID, callID: `call_${command.replace(/\W+/g, "_")}` },
      { args: { command } },
    ), command);
  }

  await assert.rejects(
    () => hooks["tool.execute.before"](
      { tool: "bash", sessionID, callID: "call_stale_destructive" },
      { args: { command: "git reset --hard" } },
    ),
    /Worktree Guardian blocked command/,
  );
});


test("/guardian slash commands rewrite to native tool instructions", async () => {
  const hooks = await plugin.server({ directory: "/repo", worktree: "/repo/.worktrees/example" });
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "/guardian status", sessionID: "ses_123", arguments: [] }, output);
  assert.deepEqual(output.parts, [{ type: "text", text: "Use the guardian_status native tool." }]);

  const deleteOutput = { parts: [] };
  await hooks["command.execute.before"]({ command: "/guardian delete-worktree", sessionID: "ses_123", arguments: [] }, deleteOutput);
  assert.deepEqual(deleteOutput.parts, [{ type: "text", text: "Use the guardian_delete_worktree native tool. Run mode=plan first. Stale local Guardian branch cleanup requires an exact branch or terminal sessionId plus deleteBranch=true and Guardian ownership proof from terminal state or safety refs. Intentional unmerged local abandonment requires deleteBranch=true plus abandonUnmerged=true in both plan and apply after inspecting unmerged commit evidence." }]);

  const deletePathsOutput = { parts: [] };
  await hooks["command.execute.before"]({ command: "/guardian delete-paths src/old.ts", sessionID: "ses_123", arguments: [] }, deletePathsOutput);
  assert.deepEqual(deletePathsOutput.parts, [{ type: "text", text: "Use the guardian_delete_paths native tool. Run mode=plan first with exact paths, inspect target status and blockers, get explicit user confirmation, then apply with confirmDelete=true. Tracked source deletion requires allowTracked=true; directory deletion requires allowRecursive=true. User arguments: src/old.ts" }]);

  const doneOutput = { parts: [] };
  await hooks["command.execute.before"]({ command: "/guardian done", sessionID: "ses_123", arguments: [] }, doneOutput);
  assert.deepEqual(doneOutput.parts, [{ type: "text", text: "Use the guardian_done native tool. Run mode=plan first. Dirty primary-main publishing requires an explicit commitMessage and explicit user confirmation; apply with confirm=true so the plugin reuses the matching internal plan token. Cleanup after publish returns a separate cleanup plan and must not be silently applied." }]);
});

test("session idle auto-finish is opt-in and deduplicated", async () => {
  const records: Array<LooseRecord> = [];
  const hooks = await plugin.server({
    client: { app: { async log(event: { readonly body: LooseRecord }) { records.push(event.body); } } },
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

test("hook scopes rm -rf blocking to the known repo root", async (t) => {
  const { repo } = await createRepoWithOrigin();
  const outside = await fs.mkdtemp(`${repo}-outside-`);
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.mkdir(`${outside}/scratch`);
  const hooks = await plugin.server({ directory: repo, worktree: repo });

  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "bash", callID: "call_repo_rm" }, { args: { command: "rm -rf src", cwd: repo } }),
    /Worktree Guardian blocked command/,
  );
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "bash", callID: "call_shell_repo_rm" }, { args: { command: "bash -lc \\\"rm -rf src\\\"", cwd: repo } }),
    /Worktree Guardian blocked command/,
  );
  await assert.doesNotReject(() => hooks["tool.execute.before"](
    { tool: "bash", callID: "call_outside_rm" },
    { args: { command: `rm -rf ${outside}/scratch`, cwd: outside } },
  ));
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

test("hook allows normal git when the recorded owned worktree is missing", async () => {
  const fs = await import("node:fs/promises");
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { repo } = await createRepoWithOrigin();
  const start = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_missing_owned", taskName: "missing-owned", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.rm(start.session.worktree_path, { recursive: true, force: true });
  const hooks = await plugin.server({ directory: repo, worktree: repo });

  await assert.doesNotReject(
    () => hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_missing_owned", callID: "call" }, { args: { command: "git add README.md" } }),
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
  const records: Array<LooseRecord> = [];
  const hooks = await plugin.server({ client: { app: { async log(event: { readonly body: LooseRecord }) { records.push(event.body); } } }, directory: repo, worktree: repo });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_idle_finish" } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_idle_finish" } } });
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(findSession(status.sessions, "ses_idle_finish").status, "preserved");
  assert.equal(records.filter((record: LooseRecord) => record.message === "event").length, 1);
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

  const records: Array<LooseRecord> = [];
  const hooks = await plugin.server({ client: createClient(records), directory: repo, worktree: repo });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_idle_retry_finish" } } });

  const firstEvents = records.filter((record) => record.message === "event");
  assert.equal(firstEvents.length, 1);
  const firstAutoFinish = recordValue(firstEvents[0].autoFinish);
  assert.equal(firstAutoFinish.ok, false);
  assert.match(String(firstAutoFinish.reason), /uncommitted changes|dirty/i);
  let status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(findSession(status.sessions, "ses_idle_retry_finish").status, "active");

  await fs.rm(dirtyPath);
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_idle_retry_finish" } } });

  const events = records.filter((record) => record.message === "event");
  assert.equal(events.length, 2);
  const secondAutoFinish = recordValue(events[1].autoFinish);
  assert.equal(secondAutoFinish.ok, true);
  assert.equal(secondAutoFinish.status, "pr-suggested");
  status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(findSession(status.sessions, "ses_idle_retry_finish").status, "preserved");
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
  await seedSession(repo, {
    session_id: "ses_idle_poisoned_finish",
    status: "active",
    branch: "main",
    worktree_path: repo,
    base_ref: "origin/main",
    head_commit: commit,
    safety_refs: [],
  });

  const records: Array<LooseRecord> = [];
  const hooks = await plugin.server({ client: createClient(records), directory: repo, worktree: repo });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_idle_poisoned_finish" } } });

  const events = records.filter((record) => record.message === "event");
  assert.equal(events.length, 1);
  const autoFinish = recordValue(events[0].autoFinish);
  assert.equal(autoFinish.ok, false);
  assert.equal(autoFinish.status, "blocked");
  assert.match(String(autoFinish.reason), /createWorktree=true/);
  assert.equal(autoFinish.suggestedCommand, "guardian_start createWorktree=true");
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(findSession(status.sessions, "ses_idle_poisoned_finish").status, "active");
  assert.equal(status.poisonedSessions.some((session: LooseRecord) => session.session_id === "ses_idle_poisoned_finish"), true);
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
  const records: Array<LooseRecord> = [];
  const hooks = await plugin.server({ client: createClient(records), directory: repo, worktree: repo });

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_idle_recorded_worktree" } } });

  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const session = findSession(status.sessions, "ses_idle_recorded_worktree");
  assert.equal(session.status, "preserved");
  assert.equal(session.worktree_path, started.session.worktree_path);
  assert.equal(records.filter((record) => record.message === "event").length, 1);
});



test("tool.execute.before rewrites direct file mutations from primary into the recorded worktree", async (t) => {
  const path = await import("node:path");
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionID = "ses_direct_file_route";
  const started = await (await import("../src/tools.ts")).guardianStart({ repoRoot: repo, cwd: repo, sessionId: sessionID, taskName: "direct file route", createWorktree: true, config: DEFAULT_CONFIG });
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });
  const output = { args: { filePath: path.join(repo, "src", "feature.ts"), content: "export {};\n" } };

  await hooks["tool.execute.before"]({ tool: "write", sessionID, callID: "call_direct_file" }, output);

  assert.equal(output.args.filePath, path.join(started.session.worktree_path, "src", "feature.ts"));
});

test("tool.execute.before leaves direct file mutations alone without a recorded session", async (t) => {
  const path = await import("node:path");
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });
  const output = { args: { filePath: path.join(repo, "README.md"), content: "updated\n" } };

  await hooks["tool.execute.before"]({ tool: "write", callID: "call_direct_file_no_session" }, output);

  assert.equal(output.args.filePath, path.join(repo, "README.md"));
});

test("tool.execute.before blocks direct file mutations when the recorded worktree is missing", async (t) => {
  const path = await import("node:path");
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionID = "ses_direct_file_missing";
  const started = await (await import("../src/tools.ts")).guardianStart({ repoRoot: repo, cwd: repo, sessionId: sessionID, taskName: "direct file missing", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.rm(started.session.worktree_path, { recursive: true, force: true });
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });
  const output = { args: { filePath: path.join(repo, "README.md"), content: "updated\n" } };

  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "write", sessionID, callID: "call_direct_file_missing" }, output),
    /blocked direct file mutation.*recorded worktree/,
  );
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
