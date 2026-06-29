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
    /raw git reset is blocked/,
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
