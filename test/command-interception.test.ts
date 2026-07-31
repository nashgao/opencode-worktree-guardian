import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { getRichDirtyStatus } from "../src/delete-worktree-dirty-proof.ts";
import { guardianDone } from "../src/done.ts";
import { dirtySnapshot } from "../src/done-primary-snapshot.ts";
import { getDirtyFiles, getIgnoredFiles, runGit, runGitNullSeparated } from "../src/git.ts";
import { GUARDIAN_SUBPROCESS_TIMEOUT_MS } from "../src/git-process.ts";
import plugin from "../src/index.ts";
import { guardianStart } from "../src/start.ts";
import { getGuardianPaths } from "../src/state.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepo, createRepoWithOrigin, createTempDir, git } from "./helpers.ts";
import { installFakeGh } from "./delete-fixtures.ts";

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

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(`${name} must be a non-empty string`);
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

test("git NUL-separated streaming preserves non-empty filenames with whitespace", async () => {
  // Given a git command emits non-empty NUL-delimited filenames with significant whitespace.
  const repo = await createRepo();
  const script = path.join(await createTempDir("guardian-hygiene-whitespace-"), "emit-whitespace-output.mjs");
  await fs.writeFile(script, 'process.stdout.write(" leading\\0trailing \\0   \\0");\n');

  // When the consumer reads the command output as filenames.
  await git(repo, ["config", "alias.guardian-whitespace", `!node ${JSON.stringify(script)}`]);
  const entries = await runGitNullSeparated(repo, ["guardian-whitespace"]);

  // Then every non-empty raw filename is returned exactly.
  assert.deepEqual(entries, [" leading", "trailing ", "   "]);
});

test("ignored-file inventory preserves newline and significant whitespace in ignored paths", async () => {
  // Given ignored files whose paths cannot be represented safely by line-delimited status output.
  const repo = await createRepo();
  const newlinePath = "line\nbreak.ignored";
  const whitespacePath = " leading and trailing .ignored ";
  await fs.writeFile(path.join(repo, ".gitignore"), "*.ignored\n leading and trailing .ignored\\ \n");
  await fs.writeFile(path.join(repo, newlinePath), "newline\n");
  await fs.writeFile(path.join(repo, whitespacePath), "whitespace\n");

  // When Guardian inventories ignored files.
  const ignoredFiles = await getIgnoredFiles(repo);

  // Then it returns the exact Git path bytes after the porcelain marker.
  assert.deepEqual(ignoredFiles.sort(), [newlinePath, whitespacePath].sort());
});

test("Git subprocesses ignore inherited Git overrides while honoring trusted temp-index options", async () => {
  // Given a disposable repository and inherited configuration that injects Git aliases.
  const repo = await createRepo();
  const inheritedConfig = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "alias.inherited-override",
    GIT_CONFIG_VALUE_0: "!printf inherited",
    GIT_OBJECT_DIRECTORY: "/unsafe/object-directory",
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "/unsafe/alternate-object-directory",
    GIT_OPTIONAL_LOCKS: "1",
    GIT_TERMINAL_PROMPT: "enabled",
    GH_PROMPT_DISABLED: "0",
  };
  const original = Object.fromEntries(Object.keys(inheritedConfig).map((key) => [key, process.env[key]]));
  Object.assign(process.env, inheritedConfig);

  try {
    // When internal callers do not explicitly trust those values.
    await assert.rejects(runGit(repo, ["inherited-override"]));
    await assert.rejects(runGitNullSeparated(repo, ["inherited-override"]));

    const environmentScript = path.join(await createTempDir("guardian-process-environment-"), "emit-environment.mjs");
    await fs.writeFile(environmentScript, 'process.stdout.write([process.env.GIT_TERMINAL_PROMPT, process.env.GH_PROMPT_DISABLED, String(process.env.GIT_OBJECT_DIRECTORY), String(process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES), String(process.env.GIT_OPTIONAL_LOCKS)].join("\\0"));\n');
    await runGit(repo, ["config", "alias.guardian-environment", `!node ${JSON.stringify(environmentScript)}`]);
    const environmentCommand = ["guardian-environment"];
    assert.deepEqual((await runGit(repo, environmentCommand)).stdout.split("\0"), ["0", "1", "undefined", "undefined", "undefined"]);
    assert.deepEqual(await runGitNullSeparated(repo, environmentCommand), ["0", "1", "undefined", "undefined", "undefined"]);
    assert.equal(Number.isSafeInteger(GUARDIAN_SUBPROCESS_TIMEOUT_MS) && GUARDIAN_SUBPROCESS_TIMEOUT_MS > 0, true);

    // Then explicit internal options remain available to candidate-index style operations.
    const indexPath = path.join(await createTempDir("guardian-trusted-index-"), "index");
    const { stdout } = await runGit(repo, ["rev-parse", "--git-path", "index"], { env: { GIT_INDEX_FILE: indexPath } });
    assert.equal(stdout, indexPath);
    await assert.rejects(runGitNullSeparated(repo, ["trusted-override"], {
      env: { ...inheritedConfig, GIT_CONFIG_KEY_0: "alias.trusted-override", GIT_CONFIG_VALUE_0: "!printf 'trusted\\0'" },
    }));
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("dirty-status consumers ignore hostile Git routing and fsmonitor", async () => {
  const repo = await createRepo();
  const poisonedRepo = await createRepo();
  const marker = path.join(await createTempDir("guardian-fsmonitor-"), "ran");
  const monitor = path.join(await createTempDir("guardian-fsmonitor-script-"), "monitor.sh");
  await fs.writeFile(path.join(repo, "dirty.txt"), "dirty\n");
  await fs.writeFile(monitor, `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`);
  await fs.chmod(monitor, 0o755);
  await git(repo, ["config", "core.fsmonitor", monitor]);
  const poisoned = { GIT_DIR: path.join(poisonedRepo, ".git"), GIT_WORK_TREE: poisonedRepo, GIT_INDEX_FILE: path.join(poisonedRepo, ".git", "index") };
  const original = Object.fromEntries(Object.keys(poisoned).map((key) => [key, process.env[key]]));
  Object.assign(process.env, poisoned);
  try {
    assert.deepEqual(await getDirtyFiles(repo), ["dirty.txt"]);
    assert.deepEqual((await dirtySnapshot(repo)).paths, ["dirty.txt"]);
    assert.deepEqual((await getRichDirtyStatus(repo)).map((entry) => entry.path), ["dirty.txt"]);
    await assert.rejects(fs.access(marker));
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("guardian_done apply lands literal pathspec-looking dirty filenames", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "land-clean-literal-pathspec-session";
  const commitMessage = "fix: stage literal pathspec filenames";
  const literalGlobPath = ":(glob)*";
  const literalExcludePath = ":(exclude)*";
  const started = await guardianStart({
    repoRoot: repo,
    cwd: repo,
    sessionId,
    taskName: "land literal pathspec filenames",
    createWorktree: true,
    config: DEFAULT_CONFIG,
  });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");
  await fs.writeFile(path.join(worktree, literalGlobPath), "glob literal\n", "utf8");
  await fs.writeFile(path.join(worktree, literalExcludePath), "exclude literal\n", "utf8");
  await installFakeGh(t, { repo, branch, dynamicHead: true });

  // When
  const request = {
    repoRoot: repo,
    cwd: worktree,
    sessionId,
    commitMessage,
    timestamp: "2026-07-27T00:00:00.000Z",
    config: DEFAULT_CONFIG,
  };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");
  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });

  // Then
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "landed-and-cleaned");
  const commit = requireString(result.commit, "result.commit");
  await git(repo, ["fetch", "origin", "main"]);
  await git(repo, ["merge-base", "--is-ancestor", commit, "origin/main"]);
  const landedPaths = (await git(repo, ["ls-tree", "-z", "--name-only", commit])).stdout.split("\0");
  assert.ok(landedPaths.includes(literalGlobPath));
  assert.ok(landedPaths.includes(literalExcludePath));
});
