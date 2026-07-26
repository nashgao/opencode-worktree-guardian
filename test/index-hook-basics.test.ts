import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import plugin from "../src/index.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

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

async function writeGuardianConfig(repo: string, config: unknown) {
  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify(config));
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
    {
      args: {
        command: "curl -H \"authorization: Basic audit-basic-secret\" -H \"authorization: Bearer audit-bearer-secret\" -H \"authorization: Custom audit-custom-secret\" https://example.test?api_key=abc",
      },
    },
  );

  const logged = JSON.stringify(records[0]);
  assert.doesNotMatch(logged, /audit-basic-secret|audit-bearer-secret|audit-custom-secret|api_key=abc/);
  assert.doesNotMatch(logged, /Basic|Bearer|Custom/);
  assert.match(logged, /Authorization: <redacted>/);
  assert.match(logged, /<redacted>/);
});

test("hook logs redact quoted JSON authorization values before truncating", async () => {
  const records: Array<LooseRecord> = [];
  const hooks = await plugin.server({
    client: { app: { async log(event: { readonly body: LooseRecord }) { records.push(event.body); } } },
    directory: "/repo",
    worktree: "/repo/.worktrees/example",
  });
  const credentialPrefix = "long-credential-prefix";
  const longJsonAuthorization = `${"x".repeat(120)} {"Authorization":"Basic ${credentialPrefix}${"x".repeat(80)}"}`;
  const parameterizedAuthorization = "aUtHoRiZaTiOn \t : \tDigest opaque=parameter-secret, nonce=unchanged\r\nsafe=value";

  await hooks["tool.execute.before"](
    { tool: "bash", sessionID: "ses_123", callID: "call_json" },
    { args: { command: "echo '{\"Authorization\":\"Basic json-secret\"}'" } },
  );
  await hooks["tool.execute.before"](
    { tool: "bash", sessionID: "ses_123", callID: "call_truncated" },
    { args: { command: longJsonAuthorization } },
  );
  await hooks["tool.execute.before"](
    { tool: "bash", sessionID: "ses_123", callID: "call_parameters" },
    { args: { command: parameterizedAuthorization } },
  );

  const logged = JSON.stringify(records);
  assert.doesNotMatch(logged, /Basic|Digest|json-secret|long-credential-prefix|parameter-secret|nonce=unchanged/);
  assert.match(logged, /Authorization: <redacted>/);
  assert.match(logged, /safe=value/);
});

test("tool.execute.before audits destructive commands by default", async () => {
  const records: Array<LooseRecord> = [];
  const hooks = await plugin.server({ client: createClient(records), directory: "/repo", worktree: "/repo/.worktrees/example" });

  await assert.doesNotReject(
    () => hooks["tool.execute.before"](
      { tool: "bash", sessionID: "ses_123", callID: "call_123" },
      { args: { command: "git worktree remove /repo/.worktrees/example" } },
    ),
  );

  const logged = records.find((record) => record.message === "tool.execute.before");
  assert.ok(logged);
  const guard = recordValue(logged.guard);
  assert.equal(guard.blocked, true);
  assert.equal(logged.auditOnly, true);
});

test("tool.execute.before throws for destructive commands in strict mode", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await writeGuardianConfig(repo, { commandInterceptionMode: "strict" });
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });

  await assert.rejects(
    () => hooks["tool.execute.before"](
      { tool: "bash", sessionID: "ses_123", callID: "call_123" },
      { args: { command: `git worktree remove ${path.join(repo, ".worktrees", "example")}` } },
    ),
    /Worktree Guardian blocked command/,
  );
});

test("tool.execute.before fails closed when commandInterceptionMode is invalid", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await writeGuardianConfig(repo, { commandInterceptionMode: "enforce" });
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });

  await assert.rejects(
    () => hooks["tool.execute.before"](
      { tool: "bash", sessionID: "ses_invalid_mode", callID: "call_invalid_mode" },
      { args: { command: `git worktree remove ${path.join(repo, ".worktrees", "example")}` } },
    ),
    /Unsupported worktree guardian commandInterceptionMode: enforce/,
  );
});

test("tool.execute.before fails closed when repo config is not an object", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await writeGuardianConfig(repo, "audit");
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });

  await assert.rejects(
    () => hooks["tool.execute.before"](
      { tool: "bash", sessionID: "ses_invalid_config", callID: "call_invalid_config" },
      { args: { command: "git worktree remove /tmp/example" } },
    ),
  );
});

test("tool.execute.before blocks fetch when HEAD maps to refs/stash in strict mode", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await writeGuardianConfig(repo, { commandInterceptionMode: "strict" });
  await git(repo, ["config", "remote.origin.fetch", "+HEAD:refs/stash"]);
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });

  await assert.rejects(
    () => hooks["tool.execute.before"](
      { tool: "bash", sessionID: "ses_stash_fetch", callID: "call_stash_fetch" },
      { args: { command: "git fetch origin" } },
    ),
    /Worktree Guardian blocked command/,
  );
});

test("tool.execute.before audits context-mode code payload worktree creation by default", async () => {
  const records: Array<LooseRecord> = [];
  const hooks = await plugin.server({ client: createClient(records), directory: "/repo", worktree: "/repo/.worktrees/example" });

  await assert.doesNotReject(
    () => hooks["tool.execute.before"](
      { tool: "context-mode_ctx_execute", sessionID: "ses_123", callID: "call_code", args: { code: "git worktree add /tmp/unmanaged main" } },
      {},
    ),
  );

  const logged = records.find((record) => record.message === "tool.execute.before");
  assert.ok(logged);
  const guard = recordValue(logged.guard);
  assert.equal(guard.blocked, true);
  assert.equal(logged.auditOnly, true);
});

test("tool.execute.before blocks manual protected-branch finish bypasses", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await writeGuardianConfig(repo, { commandInterceptionMode: "strict" });
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });

  await assert.rejects(
    () => hooks["tool.execute.before"](
      { tool: "bash", sessionID: "ses_bypass", callID: "call_bypass" },
      { args: { command: "git push origin HEAD:main" } },
    ),
    /protected branch.*guardian_finish|guardian_finish.*protected branch/,
  );
});
