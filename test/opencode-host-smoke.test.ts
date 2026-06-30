import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import plugin from "../src/index.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianStart } from "../src/tools.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

type HostLogRecord = Record<string, unknown>;
type HostToolResult = {
  readonly metadata: {
    readonly repoRoot?: unknown;
    readonly safetyRefs?: unknown;
    readonly worktrees?: unknown;
  };
  readonly output: string;
};
function createClient(records: HostLogRecord[]) {
  return {
    app: {
      _client: { records },
      async log(event: { readonly body: HostLogRecord }) {
        this._client.records.push(event.body);
      },
    },
  };
}

function createToolContext(repo: string) {
  return {
    sessionID: "ses_host",
    messageID: "msg_host",
    agent: "build",
    directory: repo,
    worktree: repo,
    abort: new AbortController().signal,
    async ask() { return undefined; },
    metadata() {},
  };
}

function isHostToolResult(value: unknown): value is HostToolResult {
  return value !== null
    && typeof value === "object"
    && "metadata" in value
    && "output" in value
    && typeof value.output === "string"
    && value.metadata !== null
    && typeof value.metadata === "object";
}

async function runHostTool(execute: unknown, input: Record<string, unknown>, context: ReturnType<typeof createToolContext>): Promise<HostToolResult> {
  if (typeof execute !== "function") throw new TypeError("expected tool execute function");
  const result: unknown = await Reflect.apply(execute, undefined, [input, context]);
  if (!isHostToolResult(result)) throw new TypeError("expected host tool result");
  return result;
}

test("project-local plugin shim exports only the guardian server function", async (t) => {
  const { repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(path.dirname(repo), { recursive: true, force: true }));
  const pluginDir = path.join(repo, ".opencode", "plugins");
  await fs.writeFile(path.join(repo, "package.json"), JSON.stringify({ type: "module" }));
  await fs.mkdir(pluginDir, { recursive: true });
  const shim = path.join(pluginDir, "worktree-guardian.ts");
  await fs.writeFile(shim, `import Guardian from ${JSON.stringify(pathToFileURL(path.resolve("src/index.ts")).href)};\nexport const WorktreeGuardian = Guardian.server;\nexport default Guardian.server;\n`);

  const module = await import(`${pathToFileURL(shim).href}?${Date.now()}`);
  assert.equal(typeof module.WorktreeGuardian, "function");
  assert.equal(module.default, module.WorktreeGuardian);
  const hooks = await module.WorktreeGuardian({ directory: repo, worktree: repo, client: createClient([]) });
  assert.equal(typeof hooks.tool.guardian_status.execute, "function");
});

test("host-like guardian_status smoke runs in a disposable repo", async (t) => {
  const { repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(path.dirname(repo), { recursive: true, force: true }));
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });
  const result = await runHostTool(hooks.tool.guardian_status.execute, { repoRoot: repo }, createToolContext(repo));
  assert.equal(result.metadata.repoRoot, repo);
  assert.equal(Array.isArray(result.metadata.worktrees), true);
  assert.equal(Array.isArray(result.metadata.safetyRefs), true);
  assert.match(result.output, /^\[GOOD\] guardian_status: No active Guardian sessions/m);
  assert.match(result.output, /worktrees: \d+/);
});

test("host-like chat transform preserves OpenCode client method binding", async (t) => {
  const { repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(path.dirname(repo), { recursive: true, force: true }));
  const records: HostLogRecord[] = [];
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient(records) });

  await hooks["experimental.chat.system.transform"](
    { sessionID: "ses_host", taskName: "binding smoke" },
    { parts: [] },
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].message, "chat.system.transform");
});

test("host-like smoke blocks destructive commands before disposable repo mutation", async (t) => {
  const { repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(path.dirname(repo), { recursive: true, force: true }));
  const before = await git(repo, ["rev-parse", "HEAD"]);
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });

  await assert.rejects(
    () => hooks["tool.execute.before"](
      { tool: "bash", sessionID: "ses_host", callID: "call_host" },
      { args: { command: "git reset --hard HEAD~1" } },
    ),
    /Worktree Guardian blocked command/,
  );
  const after = await git(repo, ["rev-parse", "HEAD"]);
  assert.equal(after.stdout, before.stdout);
});

test("host-like smoke handles quoted worktree paths with spaces", async (t) => {
  const { repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(path.dirname(repo), { recursive: true, force: true }));
  const config = { ...DEFAULT_CONFIG, worktreeRoot: path.join(path.dirname(repo), "worktree root with spaces", "$REPO") };
  const worktreePath = path.join(path.dirname(repo), "worktree root with spaces", path.basename(repo), "worktree with spaces");
  const worktree = await guardianStart({
    repoRoot: repo,
    cwd: repo,
    sessionId: "ses_space",
    taskName: "path space",
    createWorktree: true,
    worktreePath,
    config,
  });
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });
  await assert.rejects(
    () => hooks["tool.execute.before"](
      { tool: "bash", sessionID: "ses_host", callID: "call_host" },
      { args: { command: `rm -rf ${JSON.stringify(worktree.session.worktree_path)}` } },
    ),
    /Worktree Guardian blocked command/,
  );
});
