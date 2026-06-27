import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { expectedCodexAdapterFiles, expectedCodexSkillNames, expectedCommandAssets, expectedPackageExports, expectedPackageFiles, expectedSlashNames, expectedToolNames, legacyHygieneCommandNameParts, projectRoot, run, sortedPackPaths } from "./package-smoke-helpers.ts";

test("package smoke run helper times out hung commands", async () => {
  await assert.rejects(
    () => run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 50 }),
    (error: Error & { killed?: boolean; signal?: NodeJS.Signals | null }) => error.killed === true || error.signal === "SIGTERM",
  );
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
  assert.deepEqual(sortedPackPaths(packInfo.files, "codex/"), [...expectedCodexAdapterFiles].sort((left, right) => left.localeCompare(right)));
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
  for (const codexSkillName of expectedCodexSkillNames) {
    await fs.access(path.join(consumer, "node_modules", "opencode-worktree-guardian", "codex", "skills", codexSkillName, "SKILL.md"));
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
