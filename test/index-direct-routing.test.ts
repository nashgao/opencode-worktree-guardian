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
