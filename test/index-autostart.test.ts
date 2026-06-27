import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
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

async function enableLazyAutoStart(repo: string) {
  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({ autoStartMode: "lazy" }));
  await git(repo, ["add", ".opencode/worktree-guardian.json"]);
  await git(repo, ["commit", "-m", "enable lazy guardian auto start"]);
}

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

test("lazy auto-start does not create ownership during chat transform", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await enableLazyAutoStart(repo);
  const records: Array<LooseRecord> = [];
  const sessionID = "ses_lazy_chat_transform";
  const hooks = await plugin.server({ client: createClient(records), directory: repo, worktree: repo });

  await hooks["experimental.chat.system.transform"](
    { sessionID, taskName: "lazy chat transform" },
    { system: [] },
  );

  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config: { ...DEFAULT_CONFIG, autoStartMode: "lazy" } });
  assert.equal(state.sessions[sessionID], undefined);
  assert.equal(records[0].invisibleStart, null);
});

test("lazy auto-start leaves read-only commands on the primary worktree", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await enableLazyAutoStart(repo);
  const sessionID = "ses_lazy_readonly";
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });

  await hooks["tool.execute.before"](
    { tool: "bash", sessionID, callID: "call_lazy_readonly" },
    { args: { command: "git status --short" } },
  );

  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config: { ...DEFAULT_CONFIG, autoStartMode: "lazy" } });
  assert.equal(state.sessions[sessionID], undefined);
});

test("lazy auto-start creates ownership before direct file mutation routing", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await enableLazyAutoStart(repo);
  const sessionID = "ses_lazy_direct_file";
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });
  const output = { args: { filePath: path.join(repo, "src", "feature.ts"), content: "export {};\n" } };

  await hooks["tool.execute.before"]({ tool: "write", sessionID, callID: "call_lazy_direct_file" }, output);

  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config: { ...DEFAULT_CONFIG, autoStartMode: "lazy" } });
  const session = requireSession(state.sessions[sessionID]);
  assert.equal(session.status, "active");
  assert.notEqual(session.worktree_path, repo);
  assert.equal(output.args.filePath, path.join(String(session.worktree_path), "src", "feature.ts"));
});

test("lazy auto-start creates ownership before mutating command routing", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await enableLazyAutoStart(repo);
  const sessionID = "ses_lazy_command";
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });
  const output: { args: { command: string; workdir?: string; cwd?: string } } = { args: { command: "touch lazy.txt" } };

  await hooks["tool.execute.before"]({ tool: "bash", sessionID, callID: "call_lazy_command" }, output);

  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config: { ...DEFAULT_CONFIG, autoStartMode: "lazy" } });
  const session = requireSession(state.sessions[sessionID]);
  assert.equal(output.args.workdir, session.worktree_path);
  assert.equal(output.args.cwd, session.worktree_path);
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
