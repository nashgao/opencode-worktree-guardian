import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { createPackedConsumer, run } from "./package-smoke-helpers.ts";

const prohibitedPackages = ["@opentui/solid", "solid-js", "babel-plugin-module-resolver", "glob", "minimatch", "brace-expansion"] as const;
const NpmTreeSchema = z.object({
  version: z.string().optional(),
  resolved: z.string().optional(),
  path: z.string().optional(),
  dependencies: z.record(z.string(), z.unknown()).optional(),
});
const PackageLockSchema = z.object({ packages: z.record(z.string(), z.unknown()).optional() });
const AuditSchema = z.object({ metadata: z.object({ vulnerabilities: z.object({ total: z.number() }) }) });

function prohibitedDependencyNames(tree: unknown): string[] {
  const dependencyTree = NpmTreeSchema.parse(tree);
  return Object.entries(dependencyTree.dependencies ?? {}).flatMap(([name, child]) => {
    const dependency = NpmTreeSchema.parse(child);
    const isInstalledOrResolved = [dependency.version, dependency.resolved, dependency.path].some((value) => value !== undefined && value.length > 0);
    return [
      ...(isInstalledOrResolved && prohibitedPackages.some((prohibitedPackage) => prohibitedPackage === name) ? [name] : []),
      ...prohibitedDependencyNames(dependency),
    ];
  });
}

function prohibitedLockPackagePaths(lockfile: unknown): string[] {
  const { packages = {} } = PackageLockSchema.parse(lockfile);
  return Object.keys(packages).filter((lockPath) => {
    const packageName = lockPath.split("node_modules/").at(-1);
    return packageName !== undefined && prohibitedPackages.some((prohibitedPackage) => prohibitedPackage === packageName);
  });
}

test("Given optional peer metadata, when scanning prohibited package names, then only installed or resolved nodes are rejected", () => {
  assert.deepEqual(prohibitedDependencyNames({ dependencies: { "@opentui/solid": {} } }), []);
  assert.deepEqual(prohibitedDependencyNames({ dependencies: { glob: { version: "9.3.4" } } }), ["glob"]);
});

test("Given a packed consumer, when guardian-hud runs without a dialog API, then it remains a toast-only dependency-free fallback", async (t) => {
  const packedConsumer = await createPackedConsumer();
  t.after(packedConsumer.cleanup);
  const { base, consumer, packInfo } = packedConsumer;

  const hudScript = `
    import tuiPlugin from "opencode-worktree-guardian/tui";
    const toasts = [];
    const prompts = [];
    let layer;
    await tuiPlugin.tui({
      keymap: { registerLayer(input) { layer = input; return () => {}; } },
      route: { current: { name: "session", params: { sessionID: "ses_package_hud" } } },
      state: { path: { directory: process.cwd() } },
      client: { session: { promptAsync: async (input) => { prompts.push(input); } } },
      ui: { toast: (input) => { toasts.push(input); } },
    });
    await layer.commands.find((command) => command.slashName === "guardian-hud").run();
    console.log(JSON.stringify({ toasts, prompts }));
  `;
  const tsxLoader = path.join(consumer, "node_modules", "tsx", "dist", "loader.mjs");
  const hud = await run("node", ["--import", tsxLoader, "--input-type=module", "-e", hudScript], {
    cwd: consumer,
    coverage: "suppress",
    exitMode: "capture",
    env: {
      HOME: base,
      XDG_CONFIG_HOME: path.join(base, "xdg-config"),
      XDG_CACHE_HOME: path.join(base, "xdg-cache"),
      XDG_DATA_HOME: path.join(base, "xdg-data"),
    },
  });
  const dependencyTree = await run("npm", ["ls", "--all", "--omit=dev", "--json", "--registry=https://registry.npmjs.org"], {
    cwd: consumer,
    coverage: "suppress",
    exitMode: "capture",
  });
  const audit = await run("npm", ["audit", "--omit=dev", "--audit-level=low", "--json", "--registry=https://registry.npmjs.org"], {
    cwd: consumer,
    coverage: "suppress",
    exitMode: "capture",
  });
  const installedProhibitedPackages = (await Promise.all(prohibitedPackages.map(async (packageName) => {
    const packagePath = path.join(consumer, "node_modules", packageName);
    return fs.access(packagePath).then(() => packageName, () => null);
  }))).flatMap((packageName) => packageName === null ? [] : [packageName]);
  const packageLock = JSON.parse(await fs.readFile(path.join(consumer, "package-lock.json"), "utf8"));

  assert.equal(hud.exitCode, 0, hud.stderr);
  const hudResult = z.object({ toasts: z.array(z.unknown()), prompts: z.array(z.unknown()) }).parse(JSON.parse(hud.stdout));
  assert.deepEqual(hudResult.toasts, [{
    variant: "warning",
    title: "Guardian HUD unavailable",
    message: "The visual Guardian HUD is temporarily unavailable. Use /guardian-status instead.",
  }]);
  assert.deepEqual(hudResult.prompts, []);
  assert.equal(packInfo.files.some((file) => file.path === "src/hud/Hud.tsx"), false);
  assert.equal(packInfo.files.some((file) => file.path === "src/hud/model.ts"), true);
  assert.equal(dependencyTree.exitCode, 0, dependencyTree.stderr);
  assert.deepEqual(prohibitedDependencyNames(JSON.parse(dependencyTree.stdout)).sort(), []);
  assert.deepEqual(installedProhibitedPackages.sort(), []);
  assert.deepEqual(prohibitedLockPackagePaths(packageLock).sort(), []);
  assert.equal(audit.exitCode, 0, audit.stderr);
  assert.equal(AuditSchema.parse(JSON.parse(audit.stdout)).metadata.vulnerabilities.total, 0);
});
