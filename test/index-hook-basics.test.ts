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
