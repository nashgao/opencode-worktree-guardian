import assert from "node:assert/strict";
import { execFile, type ExecFileOptions } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const defaultRunTimeoutMs = 4 * 60 * 1000;
const expectedToolNames = [
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
] as const;
const expectedSlashNames = [
  "guardian-delete-paths",
  "guardian-delete-worktree",
  "guardian-done",
  "guardian-finish",
  "guardian-finish-workflow",
  "guardian-gc",
  "guardian-hygiene",
  "guardian-preserve",
  "guardian-recover",
  "guardian-report",
  "guardian-start",
  "guardian-status",
  "guardian-unblock-finish",
] as const;
const expectedCommandAssets = [
  "commands/done.md",
  "commands/delete-paths.md",
  "commands/delete-worktree.md",
  "commands/finish.md",
  "commands/finish-workflow.md",
  "commands/gc.md",
  "commands/hygiene.md",
  "commands/preserve.md",
  "commands/recover.md",
  "commands/report.md",
  "commands/start.md",
  "commands/status.md",
  "commands/unblock-finish.md",
] as const;
const expectedCodexAdapterFiles = [
  "codex/.codex-plugin/plugin.json",
  "codex/hooks/guardian-hook.ts",
  "codex/hooks/hooks.json",
  "codex/skills/worktree-guardian/SKILL.md",
] as const;
const expectedPackagedCommandTools = [
  ["done", "guardian_done"],
  ["delete-paths", "guardian_delete_paths"],
  ["delete-worktree", "guardian_delete_worktree"],
  ["finish", "guardian_finish"],
  ["finish-workflow", "guardian_finish_workflow"],
  ["gc", "guardian_gc"],
  ["hygiene", "guardian_hygiene"],
  ["preserve", "guardian_preserve"],
  ["recover", "guardian_recover"],
  ["report", "guardian_report_html"],
  ["start", "guardian_start"],
  ["status", "guardian_status"],
  ["unblock-finish", "guardian_unblock_finish"],
] as const;
const expectedPackageExports = {
  ".": "./src/index.ts",
  "./codex": "./codex/hooks/guardian-hook.ts",
  "./server": "./src/index.ts",
  "./tui": "./src/tui.ts",
} as const;
const expectedPackageFiles = ["CHANGELOG.md", "codex", "commands", "docs", "src", "scripts", "skills", "README.md", "LICENSE"] as const;
const legacyHygieneCommandNameParts = ["hygiene", "cleanup"] as const;
const publicDriftScanEntries = ["README.md", "docs", "commands", "skills", "codex", "src", "test", "package.json", "package-lock.json"] as const;

type RunOptions = Omit<ExecFileOptions, "env"> & {
  readonly env?: NodeJS.ProcessEnv;
};

async function run(command: string, args: readonly string[], options: RunOptions = {}) {
  const env = {
    ...process.env,
    CI: "true",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_audit: "false",
    npm_config_fund: "false",
    ...options.env,
  };
  const { stdout, stderr } = await execFileAsync(command, args, {
    maxBuffer: 20 * 1024 * 1024,
    timeout: defaultRunTimeoutMs,
    killSignal: "SIGTERM",
    ...options,
    env,
  });
  const stdoutText = typeof stdout === "string" ? stdout : stdout.toString("utf8");
  const stderrText = typeof stderr === "string" ? stderr : stderr.toString("utf8");
  return { stdout: stdoutText.trim(), stderr: stderrText.trim() };
}

function sortedPackPaths(files: readonly { readonly path: string }[], prefix: string): string[] {
  return files
    .map((file) => file.path)
    .filter((filePath) => filePath.startsWith(prefix))
    .sort((left, right) => left.localeCompare(right));
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

async function collectTextFilePaths(relativeEntries: readonly string[]): Promise<string[]> {
  const found: string[] = [];

  async function visit(relativePath: string): Promise<void> {
    const absolutePath = path.join(projectRoot, relativePath);
    const stats = await fs.stat(absolutePath);
    if (!stats.isDirectory()) {
      found.push(relativePath);
      return;
    }

    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      await visit(path.join(relativePath, entry.name));
    }
  }

  for (const relativeEntry of relativeEntries) await visit(relativeEntry);
  return found.sort((left, right) => left.localeCompare(right));
}

function legacyHygieneReferences(): readonly string[] {
  return [
    legacyHygieneCommandNameParts.join("-"),
    ["guardian", ...legacyHygieneCommandNameParts].join("_"),
  ];
}

async function findLegacyHygieneReferences(): Promise<string[]> {
  const files = await collectTextFilePaths(publicDriftScanEntries);
  const legacyReferences = legacyHygieneReferences();
  const matches: string[] = [];

  for (const file of files) {
    const content = await fs.readFile(path.join(projectRoot, file), "utf8");
    for (const legacyReference of legacyReferences) {
      if (content.includes(legacyReference)) matches.push(`${normalizeRelativePath(file)}: ${legacyReference}`);
    }
  }

  return matches;
}

test("package smoke run helper times out hung commands", async () => {
  await assert.rejects(
    () => run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 50 }),
    (error: Error & { killed?: boolean; signal?: NodeJS.Signals | null }) => error.killed === true || error.signal === "SIGTERM",
  );
});

test("public docs and package inventory stay aligned with guardian command surface", async () => {
  const readme = await fs.readFile(path.join(projectRoot, "README.md"), "utf8");

  for (const commandAsset of expectedCommandAssets) {
    await fs.access(path.join(projectRoot, commandAsset));
  }

  for (const codexAdapterFile of expectedCodexAdapterFiles) {
    await fs.access(path.join(projectRoot, codexAdapterFile));
  }

  for (const [commandName, toolName] of expectedPackagedCommandTools) {
    const command = await fs.readFile(path.join(projectRoot, "commands", `${commandName}.md`), "utf8");
    assert.equal(command.includes(`\`${toolName}\``), true, `${commandName} must route to ${toolName}`);
    assert.equal(readme.includes(`/opencode-worktree-guardian:${commandName}`), true, `README must document packaged command ${commandName}`);
  }

  for (const toolName of expectedToolNames) {
    assert.equal(readme.includes(`\`${toolName}\``), true, `README must document native tool ${toolName}`);
  }

  for (const slashName of expectedSlashNames) {
    assert.equal(readme.includes(`/${slashName}`), true, `README must document slash command /${slashName}`);
  }

  assert.deepEqual(await findLegacyHygieneReferences(), []);
});

test("packed artifact installs in a clean consumer and exposes plugin contract", async (t) => {
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  assert.deepEqual(packageJson.exports, expectedPackageExports);
  assert.deepEqual([...packageJson.files].sort(), [...expectedPackageFiles].sort());
  assert.match(packageJson.dependencies.zod, /^\^4\./);

  const readme = await fs.readFile(path.join(projectRoot, "README.md"), "utf8");
  assert.equal(readme.includes('"plugin": ["opencode-worktree-guardian"]'), true);
  assert.equal(readme.includes('"plugin": ["opencode-worktree-guardian/server"]'), false);
  assert.equal(readme.includes('"plugin": ["opencode-worktree-guardian/tui"]'), false);

  const base = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-package-smoke-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const packDir = path.join(base, "pack");
  const consumer = path.join(base, "consumer");
  const npmCache = path.join(base, "npm-cache");
  await fs.mkdir(packDir, { recursive: true });
  await fs.mkdir(consumer, { recursive: true });

  const packed = await run("npm", ["pack", projectRoot, "--pack-destination", packDir, "--json", "--cache", npmCache], { cwd: base });
  const [packInfo] = JSON.parse(packed.stdout);
  assert.equal(packInfo.name, "opencode-worktree-guardian");
  assert.equal(packInfo.version, "0.1.0");
  assert.deepEqual(sortedPackPaths(packInfo.files, "commands/"), [...expectedCommandAssets].sort((left, right) => left.localeCompare(right)));
  assert.deepEqual(sortedPackPaths(packInfo.files, "codex/"), expectedCodexAdapterFiles);
  assert.equal(packInfo.files.some((file: { path: string }) => file.path === "src/index.ts"), true);
  assert.equal(packInfo.files.some((file: { path: string }) => file.path === "src/tui.ts"), true);
  const packedHooks = await fs.readFile(path.join(projectRoot, "codex", "hooks", "hooks.json"), "utf8");
  assert.equal(packedHooks.includes("${PLUGIN_ROOT}/hooks/guardian-hook.ts"), true);
  assert.equal(packedHooks.includes("../node_modules"), false);
  assert.equal(packInfo.files.some((file: { path: string }) => file.path === "scripts/readiness.ts"), true);
  assert.equal(packInfo.files.some((file: { path: string }) => file.path === "scripts/with-safe-node-temp.mjs"), true);
  assert.equal(packInfo.files.some((file: { path: string }) => file.path === "CHANGELOG.md"), true);
  assert.equal(packInfo.files.some((file: { path: string }) => file.path === "docs/adr/0001-guardian-safety-policy.md"), true);
  assert.equal(packInfo.files.some((file: { path: string }) => file.path === "docs/publishing.md"), true);
  assert.equal(packInfo.files.some((file: { path: string }) => file.path === "docs/release-checklist.md"), true);
  for (const commandAsset of expectedCommandAssets) {
    assert.equal(packInfo.files.some((file: { path: string }) => file.path === commandAsset), true, commandAsset);
  }
  assert.equal(packInfo.files.some((file: { path: string }) => {
    if (!file.path.startsWith("commands/")) return false;
    return legacyHygieneCommandNameParts.every((part) => file.path.includes(part));
  }), false);
  assert.equal(packInfo.files.some((file: { path: string }) => file.path === "skills/worktree-guardian/SKILL.md"), true);
  assert.equal(packInfo.files.some((file: { path: string }) => file.path.startsWith("test/")), false);
  assert.equal(packInfo.files.some((file: { path: string }) => file.path.startsWith(".milestones/")), false);
  assert.equal(packInfo.files.some((file: { path: string }) => file.path === "IMPLEMENTATION_PLAN.md"), false);

  await run("npm", ["init", "-y"], { cwd: consumer });
  await run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--cache",
    npmCache,
    path.join(packDir, packInfo.filename),
    `tsx@${packageJson.dependencies.tsx}`,
  ], { cwd: consumer });

  const smokeScript = `
    import plugin from "opencode-worktree-guardian";
    import serverPlugin from "opencode-worktree-guardian/server";
    import tuiPlugin from "opencode-worktree-guardian/tui";
    const hooks = await plugin.server({ directory: process.cwd(), worktree: process.cwd(), client: { app: { log: async () => {} } } });
    let layer;
    await tuiPlugin.tui({
      keymap: {
        registerLayer(input) {
          layer = input;
          return () => {};
        },
      },
      route: { current: { name: "session", params: { sessionID: "ses_package_smoke" } } },
      state: { path: { directory: process.cwd() } },
      client: { session: { promptAsync: async () => {} } },
      ui: { toast: () => {} },
    });
    console.log(JSON.stringify({
      id: plugin.id,
      serverId: serverPlugin.id,
      tuiId: tuiPlugin.id,
      hasTui: typeof tuiPlugin.tui === "function",
      tools: Object.keys(hooks.tool).sort(),
      hooks: Object.keys(hooks).filter((key) => key !== "tool").sort(),
      slashes: layer.commands.map((command) => command.slashName).sort(),
    }));
  `;
  const tsxLoader = path.join(consumer, "node_modules", "tsx", "dist", "loader.mjs");
  const smoke = await run("node", ["--import", tsxLoader, "--input-type=module", "-e", smokeScript], {
    cwd: consumer,
    env: {
      HOME: base,
      XDG_CONFIG_HOME: path.join(base, "xdg-config"),
      XDG_CACHE_HOME: path.join(base, "xdg-cache"),
      XDG_DATA_HOME: path.join(base, "xdg-data"),
    },
  });

  for (const commandAsset of expectedCommandAssets) {
    await fs.access(path.join(consumer, "node_modules", "opencode-worktree-guardian", commandAsset));
  }
  await fs.access(path.join(consumer, "node_modules", "opencode-worktree-guardian", "skills", "worktree-guardian", "SKILL.md"));

  const result = JSON.parse(smoke.stdout);
  assert.equal(result.id, "opencode-worktree-guardian");
  assert.equal(result.serverId, "opencode-worktree-guardian");
  assert.equal(result.tuiId, "opencode-worktree-guardian");
  assert.equal(result.hasTui, true);
  assert.deepEqual(result.tools, expectedToolNames);
  assert.deepEqual(result.slashes, expectedSlashNames);
  assert.equal(result.hooks.includes("tool.execute.before"), true);
});
