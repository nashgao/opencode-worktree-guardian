import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import plugin from "../src/index.ts";
import { createRepoWithOrigin } from "./helpers.ts";

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

async function writeGuardianConfig(repo: string, config: LooseRecord) {
  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify(config));
}

test("tool.execute.before rewrites direct file mutations from primary into the recorded worktree", async (t) => {
  const path = await import("node:path");
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionID = "ses_direct_file_route";
  const started = await (await import("../src/tools.ts")).guardianStart({ repoRoot: repo, cwd: repo, sessionId: sessionID, taskName: "direct file route", createWorktree: true, config: DEFAULT_CONFIG });
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });
  const output = { args: { filePath: "src/feature.ts", content: "export {};\n" } };

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

test("tool.execute.before audits direct file mutations when the recorded worktree is missing", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionID = "ses_direct_file_missing";
  const started = await (await import("../src/tools.ts")).guardianStart({ repoRoot: repo, cwd: repo, sessionId: sessionID, taskName: "direct file missing", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.rm(started.session.worktree_path, { recursive: true, force: true });
  const records: Array<LooseRecord> = [];
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient(records) });
  const output = { args: { filePath: "README.md", content: "updated\n" } };

  await assert.doesNotReject(
    () => hooks["tool.execute.before"]({ tool: "write", sessionID, callID: "call_direct_file_missing" }, output),
  );
  const logged = recordValue(records[0]);
  const directFileRoute = recordValue(logged.directFileRoute);
  assert.equal(directFileRoute.blocked, true);
  assert.equal(logged.auditOnly, true);
});

test("tool.execute.before blocks direct file mutations when the recorded worktree is missing in strict mode", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await writeGuardianConfig(repo, { commandInterceptionMode: "strict" });
  const sessionID = "ses_direct_file_missing_strict";
  const started = await (await import("../src/tools.ts")).guardianStart({ repoRoot: repo, cwd: repo, sessionId: sessionID, taskName: "direct file missing strict", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.rm(started.session.worktree_path, { recursive: true, force: true });
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });
  const output = { args: { filePath: "README.md", content: "updated\n" } };

  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "write", sessionID, callID: "call_direct_file_missing_strict" }, output),
    /blocked direct file mutation.*recorded worktree/,
  );
});

test("tool.execute.before audits a relative missing target whose repo ancestor is a symlink escape", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const outside = await fs.mkdtemp(path.join(base, "outside-"));
  await fs.symlink(outside, path.join(repo, "escape"));
  const sessionID = "ses_direct_file_repo_escape_audit";
  await (await import("../src/tools.ts")).guardianStart({ repoRoot: repo, cwd: repo, sessionId: sessionID, taskName: "direct file repo escape audit", createWorktree: true, config: DEFAULT_CONFIG });
  const records: Array<LooseRecord> = [];
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient(records) });
  const output = { args: { filePath: "escape/missing-target.txt", content: "updated\n" } };

  await assert.doesNotReject(
    () => hooks["tool.execute.before"]({ tool: "write", sessionID, callID: "call_direct_file_repo_escape_audit" }, output),
  );

  const logged = recordValue(records[0]);
  assert.equal(recordValue(logged.directFileRoute).blocked, true);
  assert.equal(logged.auditOnly, true);
  assert.equal(output.args.filePath, "escape/missing-target.txt");
});

test("tool.execute.before strictly blocks an absolute missing target whose routed worktree ancestor is a symlink escape", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await writeGuardianConfig(repo, { commandInterceptionMode: "strict" });
  await fs.mkdir(path.join(repo, "escape"));
  const sessionID = "ses_direct_file_worktree_escape_strict";
  const started = await (await import("../src/tools.ts")).guardianStart({ repoRoot: repo, cwd: repo, sessionId: sessionID, taskName: "direct file worktree escape strict", createWorktree: true, config: DEFAULT_CONFIG });
  const outside = await fs.mkdtemp(path.join(base, "outside-"));
  await fs.symlink(outside, path.join(started.session.worktree_path, "escape"));
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });
  const target = path.join(repo, "escape", "missing-target.txt");
  const output = { args: { filePath: target, content: "updated\n" } };

  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "write", sessionID, callID: "call_direct_file_worktree_escape_strict" }, output),
    /blocked direct file mutation/,
  );
  assert.equal(output.args.filePath, target);
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

test("tool.execute.before recomputes strict interception after routing from an audit primary worktree", async (t) => {
  // Given an audit primary worktree and a recorded session worktree configured for strict interception.
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await writeGuardianConfig(repo, { commandInterceptionMode: "audit", autoStart: false });
  const sessionID = "ses_routed_strict_context";
  const started = await (await import("../src/tools.ts")).guardianStart({ repoRoot: repo, cwd: repo, sessionId: sessionID, taskName: "routed strict context", createWorktree: true, config: DEFAULT_CONFIG });
  await writeGuardianConfig(started.session.worktree_path, { commandInterceptionMode: "strict", autoStart: false });
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });
  const output: { args: { command: string; workdir?: string; cwd?: string } } = { args: { command: "git reset --hard" } };

  // When a guarded command is routed into the recorded strict worktree.
  // Then the final strict context blocks it rather than preserving the initial audit decision.
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "bash", sessionID, callID: "call_routed_strict_context" }, output),
    /Worktree Guardian blocked command/,
  );
  assert.equal(output.args.workdir, started.session.worktree_path);
  assert.equal(output.args.cwd, started.session.worktree_path);
});

test("tool.execute.before preserves audit allow-and-log behavior after routing into an audit worktree", async (t) => {
  // Given an audit primary worktree and a recorded session worktree that remains in audit mode.
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await writeGuardianConfig(repo, { commandInterceptionMode: "audit", autoStart: false });
  const sessionID = "ses_routed_audit_context";
  const started = await (await import("../src/tools.ts")).guardianStart({ repoRoot: repo, cwd: repo, sessionId: sessionID, taskName: "routed audit context", createWorktree: true, config: DEFAULT_CONFIG });
  await writeGuardianConfig(started.session.worktree_path, { commandInterceptionMode: "audit", autoStart: false });
  const records: Array<LooseRecord> = [];
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient(records) });
  const output: { args: { command: string; workdir?: string; cwd?: string } } = { args: { command: "git reset --hard" } };

  // When the same guarded command is routed into the recorded audit worktree.
  await assert.doesNotReject(
    () => hooks["tool.execute.before"]({ tool: "bash", sessionID, callID: "call_routed_audit_context" }, output),
  );

  // Then it is routed, allowed, and logged as an audited block.
  const record = records.find((candidate) => candidate.message === "tool.execute.before");
  assert.ok(record);
  assert.equal(recordValue(record.guard).blocked, true);
  assert.equal(record.auditOnly, true);
  assert.equal(output.args.workdir, started.session.worktree_path);
  assert.equal(output.args.cwd, started.session.worktree_path);
});

test("tool.execute.before audits routed mutating commands when recorded branch binding is stale", async (t) => {
  const { createRepoWithOrigin, git } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(path.dirname(repo), { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_stale_branch", taskName: "stale branch", createWorktree: true, config: DEFAULT_CONFIG });
  await git(started.session.worktree_path, ["checkout", "-b", "feature/tampered-binding"]);
  const records: Array<LooseRecord> = [];
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient(records) });
  const output: { args: { command: string; workdir?: string; cwd?: string } } = { args: { command: "git add README.md" } };

  await assert.doesNotReject(
    () => hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_stale_branch", callID: "call_stale_branch" }, output),
  );
  const logged = records.find((record) => typeof record.routeError === "string");
  assert.ok(logged);
  assert.match(String(logged.routeError), /recorded branch does not match checked-out worktree branch/);
  assert.equal(logged.auditOnly, true);
  assert.equal(output.args.workdir, undefined);
  assert.equal(output.args.cwd, undefined);
});

test("tool.execute.before blocks routed mutating commands when recorded branch binding is stale in strict mode", async (t) => {
  const { createRepoWithOrigin, git } = await import("./helpers.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(path.dirname(repo), { recursive: true, force: true }));
  await writeGuardianConfig(repo, { commandInterceptionMode: "strict" });
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_stale_branch_strict", taskName: "stale branch strict", createWorktree: true, config: DEFAULT_CONFIG });
  await git(started.session.worktree_path, ["checkout", "-b", "feature/tampered-binding"]);
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const output: { args: { command: string; workdir?: string; cwd?: string } } = { args: { command: "git add README.md" } };

  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_stale_branch_strict", callID: "call_stale_branch_strict" }, output),
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
