import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const defaultRunTimeoutMs = 2 * 60 * 1000;
const expectedCommandAssets = [
  "commands/done.md",
  "commands/delete-worktree.md",
  "commands/finish.md",
  "commands/finish-workflow.md",
  "commands/hygiene.md",
  "commands/hygiene-cleanup.md",
  "commands/preserve.md",
  "commands/recover.md",
  "commands/report.md",
  "commands/start.md",
  "commands/status.md",
  "commands/unblock-finish.md",
];

async function run(command: string, args: string[], options: Record<string, any> = {}) {
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
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

test("package smoke run helper times out hung commands", async () => {
  await assert.rejects(
    () => run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 50 }),
    (error: Error & { killed?: boolean; signal?: NodeJS.Signals | null }) => error.killed === true || error.signal === "SIGTERM",
  );
});

test("packed artifact installs in a clean consumer and exposes plugin contract", async (t) => {
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  assert.equal(packageJson.exports["./server"], "./src/index.ts");
  assert.equal(packageJson.exports["./tui"], "./src/tui.ts");
  assert.equal(packageJson.files.includes("commands"), true);
  assert.equal(packageJson.files.includes("skills"), true);

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

  const packed = await run("npm", ["pack", projectRoot, "--pack-destination", packDir, "--json"], { cwd: base });
  const [packInfo] = JSON.parse(packed.stdout);
  assert.equal(packInfo.name, "opencode-worktree-guardian");
  assert.equal(packInfo.version, "0.1.0");
  assert.equal(packInfo.files.some((file: { path: string }) => file.path === "src/index.ts"), true);
  assert.equal(packInfo.files.some((file: { path: string }) => file.path === "src/tui.ts"), true);
  assert.equal(packInfo.files.some((file: { path: string }) => file.path === "scripts/readiness.ts"), true);
  assert.equal(packInfo.files.some((file: { path: string }) => file.path === "scripts/with-safe-node-temp.mjs"), true);
  for (const commandAsset of expectedCommandAssets) {
    assert.equal(packInfo.files.some((file: { path: string }) => file.path === commandAsset), true, commandAsset);
  }
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
    `tsx@${packageJson.devDependencies.tsx}`,
  ], { cwd: consumer });

  const smokeScript = `
    import plugin from "opencode-worktree-guardian";
    import serverPlugin from "opencode-worktree-guardian/server";
    import tuiPlugin from "opencode-worktree-guardian/tui";
    const hooks = await plugin.server({ directory: process.cwd(), worktree: process.cwd(), client: { app: { log: async () => {} } } });
    console.log(JSON.stringify({ id: plugin.id, serverId: serverPlugin.id, tuiId: tuiPlugin.id, hasTui: typeof tuiPlugin.tui === "function", tools: Object.keys(hooks.tool).sort(), hooks: Object.keys(hooks).filter((key) => key !== "tool").sort() }));
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
  assert.deepEqual(result.tools, ["guardian_delete_worktree", "guardian_done", "guardian_finish", "guardian_finish_workflow", "guardian_hygiene", "guardian_hygiene_cleanup", "guardian_preserve", "guardian_recover", "guardian_report_html", "guardian_start", "guardian_status", "guardian_unblock_finish"]);
  assert.equal(result.hooks.includes("tool.execute.before"), true);
});
