import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import plugin from "../src/index.ts";
import { getGuardianPaths } from "../src/state.ts";
import { createRepoWithOrigin } from "./helpers.ts";

type LogRecord = Record<string, unknown>;

function createClient(records: LogRecord[]) {
  return {
    app: {
      async log(event: { readonly body: LogRecord }) {
        records.push(event.body);
      },
    },
  };
}

function isLogRecord(value: unknown): value is LogRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordValue(value: unknown): LogRecord {
  if (!isLogRecord(value)) throw new TypeError("expected hook log record");
  return value;
}

async function writeConfig(repo: string, mode: "audit" | "strict"): Promise<void> {
  const configPath = path.join(repo, ".opencode", "worktree-guardian.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ commandInterceptionMode: mode, autoStart: false }));
}

async function writeMalformedState(repo: string): Promise<void> {
  const paths = await getGuardianPaths(repo);
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(paths.statePath, "{\"schema_version\":\"broken\"}\n");
}

function dangerousMerge(): string {
  return "git merge unprefixed-recorded-session-branch";
}

test("strict OpenCode interception fails closed when Guardian state/worktree inventory is malformed", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await writeConfig(repo, "strict");
  await writeMalformedState(repo);
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });

  await assert.rejects(
    () => hooks["tool.execute.before"](
      { tool: "bash", sessionID: "ses_malformed_inventory", callID: "call_malformed_inventory" },
      { args: { command: dangerousMerge(), workdir: repo } },
    ),
    /Worktree Guardian blocked command/,
  );
});

test("audit OpenCode interception records malformed Guardian inventory as an audited block", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await writeConfig(repo, "audit");
  await writeMalformedState(repo);
  const records: LogRecord[] = [];
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient(records) });

  await assert.doesNotReject(
    () => hooks["tool.execute.before"](
      { tool: "bash", sessionID: "ses_malformed_inventory", callID: "call_malformed_inventory" },
      { args: { command: dangerousMerge(), workdir: repo } },
    ),
  );

  const record = records.find((candidate) => candidate.message === "tool.execute.before");
  assert.ok(record);
  assert.equal(recordValue(record.guard).blocked, true);
  assert.equal(record.auditOnly, true);
});
