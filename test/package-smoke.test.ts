import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);

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
    ...options,
    env,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

test("packed artifact installs in a clean consumer and exposes plugin contract", async (t) => {
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
  assert.equal(packInfo.files.some((file: { path: string }) => file.path === "scripts/readiness.ts"), true);
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
  ], { cwd: consumer });

  const smokeScript = `
    import plugin from "opencode-worktree-guardian";
    const hooks = await plugin.server({ directory: process.cwd(), worktree: process.cwd(), client: { app: { log: async () => {} } } });
    console.log(JSON.stringify({ id: plugin.id, tools: Object.keys(hooks.tool).sort(), hooks: Object.keys(hooks).filter((key) => key !== "tool").sort() }));
  `;
  const tsxLoader = path.join(projectRoot, "node_modules", "tsx", "dist", "loader.mjs");
  const smoke = await run("node", ["--import", tsxLoader, "--input-type=module", "-e", smokeScript], {
    cwd: consumer,
    env: {
      HOME: base,
      XDG_CONFIG_HOME: path.join(base, "xdg-config"),
      XDG_CACHE_HOME: path.join(base, "xdg-cache"),
      XDG_DATA_HOME: path.join(base, "xdg-data"),
    },
  });

  const result = JSON.parse(smoke.stdout);
  assert.equal(result.id, "opencode-worktree-guardian");
  assert.deepEqual(result.tools, ["guardian_finish", "guardian_preserve", "guardian_recover", "guardian_start", "guardian_status"]);
  assert.equal(result.hooks.includes("tool.execute.before"), true);
});
