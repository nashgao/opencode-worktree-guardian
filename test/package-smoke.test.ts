import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPackedConsumer, expectedCodexAdapterFiles, expectedCodexSkillNames, expectedCommandAssets, expectedPackageExports, expectedPackageFiles, expectedSlashNames, expectedToolNames, legacyHygieneCommandNameParts, projectRoot, run, sortedPackPaths } from "./package-smoke-helpers.ts";

function isSameOrInside(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

test("package smoke run helper times out hung commands", async () => {
  await assert.rejects(
    () => run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 50 }),
    (error: Error & { killed?: boolean; signal?: NodeJS.Signals | null }) => error.killed === true || error.signal === "SIGTERM",
  );
});

test("package smoke run helper suppresses inherited coverage env", async () => {
  const result = await run(process.execPath, ["-e", "console.log(JSON.stringify({ coverage: process.env.NODE_V8_COVERAGE, marker: process.env.OPENCODE_WORKTREE_GUARDIAN_COVERAGE_RUN, compile: process.env.NODE_COMPILE_CACHE }))"], {
    coverage: "suppress",
    env: {
      NODE_V8_COVERAGE: "parent-coverage",
      OPENCODE_WORKTREE_GUARDIAN_COVERAGE_RUN: "parent-marker",
      NODE_COMPILE_CACHE: "parent-compile-cache",
    },
  });

  assert.deepEqual(JSON.parse(result.stdout), { coverage: "", marker: "", compile: "" });
});

test("safe node temp wrapper rejects TMPDIR inside a different Git worktree", async (t) => {
  const base = await fs.mkdtemp(path.join("/tmp", "guardian-safe-temp-git-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const project = path.join(base, "no-repository-project");
  const gitWorktree = path.join(base, "different-git-worktree");
  await fs.mkdir(project);
  await run("git", ["init", "--quiet", gitWorktree]);

  const script = path.join(projectRoot, "scripts", "with-safe-node-temp.mjs");
  const result = await run(process.execPath, [script, "--", process.execPath, "-e", "console.log(process.env.TMPDIR)"], {
    cwd: project,
    env: { TMPDIR: gitWorktree },
  });
  const tempRoot = result.stdout.trim();
  const realTempRoot = await fs.realpath(tempRoot);
  const realGitWorktree = await fs.realpath(gitWorktree);

  assert.equal(isSameOrInside(realTempRoot, realGitWorktree), false, `${realTempRoot} must be outside ${realGitWorktree}`);
});

test("Given npm setup fails after a packed consumer temp base is created, when createPackedConsumer rejects, then it leaves no temp directory", async (t) => {
  const tempRoot = os.tmpdir();
  const prefix = "guardian-package-smoke-";
  const before = new Set((await fs.readdir(tempRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name));
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = "";
    await assert.rejects(() => createPackedConsumer());
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  const leaked = (await fs.readdir(tempRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix) && !before.has(entry.name))
    .map((entry) => path.join(tempRoot, entry.name));
  t.after(() => Promise.all(leaked.map((directory) => fs.rm(directory, { recursive: true, force: true }))));

  assert.deepEqual(leaked, []);
});

test("safe node temp wrapper creates fresh coverage directories", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-safe-temp-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  await fs.mkdir(project);
  const coverageInsideProject = path.join(project, "coverage");
  const externalCoverage = path.join(base, "external-coverage");
  await fs.mkdir(externalCoverage);

  const script = path.join(projectRoot, "scripts", "with-safe-node-temp.mjs");
  const command = "console.log(JSON.stringify({ compile: process.env.NODE_COMPILE_CACHE, coverage: process.env.NODE_V8_COVERAGE, tmp: process.env.TMPDIR }))";
  const first = await run(process.execPath, [script, "--", process.execPath, "--experimental-test-coverage", "-e", command], {
    cwd: project,
    env: { NODE_V8_COVERAGE: coverageInsideProject },
  });
  const second = await run(process.execPath, [script, "--", process.execPath, "--experimental-test-coverage", "-e", command], {
    cwd: project,
    env: { NODE_V8_COVERAGE: coverageInsideProject },
  });
  const explicitWithExternalCoverage = await run(process.execPath, [script, "--", process.execPath, "--experimental-test-coverage", "-e", command], {
    cwd: project,
    env: { NODE_V8_COVERAGE: externalCoverage },
  });
  const inheritedExternalCoverage = await run(process.execPath, [script, "--", process.execPath, "-e", command], {
    cwd: project,
    env: { NODE_V8_COVERAGE: externalCoverage },
  });

  const firstEnv = JSON.parse(first.stdout.split("\n")[0]) as { readonly compile: string; readonly coverage: string; readonly tmp: string };
  const secondEnv = JSON.parse(second.stdout.split("\n")[0]) as { readonly compile: string; readonly coverage: string; readonly tmp: string };
  const explicitExternalEnv = JSON.parse(explicitWithExternalCoverage.stdout.split("\n")[0]) as { readonly compile: string; readonly coverage: string; readonly tmp: string };
  const inheritedExternalEnv = JSON.parse(inheritedExternalCoverage.stdout.split("\n")[0]) as { readonly compile: string; readonly coverage: string; readonly tmp: string };
  const firstCoverageParent = path.dirname(firstEnv.coverage);
  const secondCoverageParent = path.dirname(secondEnv.coverage);
  const explicitExternalCoverageParent = path.dirname(explicitExternalEnv.coverage);
  const explicitWithWrapperCoverage = await run(process.execPath, [script, "--", process.execPath, "--experimental-test-coverage", "-e", command], {
    cwd: project,
    env: {
      NODE_V8_COVERAGE: firstEnv.coverage,
      NODE_COMPILE_CACHE: firstEnv.compile,
      OPENCODE_WORKTREE_GUARDIAN_COVERAGE_RUN: firstCoverageParent,
    },
  });
  const explicitWrapperEnv = JSON.parse(explicitWithWrapperCoverage.stdout.split("\n")[0]) as { readonly compile: string; readonly coverage: string; readonly tmp: string };
  const nestedScript = `
    import { execFileSync } from "node:child_process";
    const output = execFileSync(process.execPath, [${JSON.stringify(script)}, "--", process.execPath, "--experimental-test-coverage", "-e", ${JSON.stringify(command)}], {
      cwd: ${JSON.stringify(project)},
      env: process.env,
      encoding: "utf8",
    });
    console.log(output.trim().split("\\n")[0]);
  `;
  const nested = await run(process.execPath, [script, "--", process.execPath, "--input-type=module", "-e", nestedScript], {
    cwd: project,
    env: {
      NODE_V8_COVERAGE: "",
      NODE_COMPILE_CACHE: "",
      OPENCODE_WORKTREE_GUARDIAN_COVERAGE_RUN: "",
      TMPDIR: firstEnv.tmp,
    },
  });
  const nestedEnv = JSON.parse(nested.stdout.split("\n")[0]) as { readonly compile: string; readonly coverage: string; readonly tmp: string };
  assert.equal(firstEnv.tmp, secondEnv.tmp);
  assert.equal(firstEnv.tmp, explicitExternalEnv.tmp);
  assert.equal(firstEnv.tmp, inheritedExternalEnv.tmp);
  assert.equal(firstEnv.tmp, explicitWrapperEnv.tmp);
  assert.equal(firstEnv.tmp, nestedEnv.tmp);
  assert.notEqual(firstCoverageParent, secondCoverageParent);
  assert.notEqual(explicitExternalEnv.coverage, externalCoverage);
  assert.equal(inheritedExternalEnv.coverage, externalCoverage);
  assert.equal(explicitWrapperEnv.coverage, firstEnv.coverage);
  assert.equal(explicitWrapperEnv.compile, firstEnv.compile);
  assert.equal(path.basename(firstEnv.compile).startsWith(`node-compile-cache-${path.basename(firstCoverageParent)}-`), true);
  assert.equal(path.basename(secondEnv.compile).startsWith(`node-compile-cache-${path.basename(secondCoverageParent)}-`), true);
  assert.equal(path.basename(explicitExternalEnv.compile).startsWith(`node-compile-cache-${path.basename(explicitExternalCoverageParent)}-`), true);
  assert.equal(path.basename(nestedEnv.compile).startsWith(`node-compile-cache-${path.basename(path.dirname(nestedEnv.coverage))}-`), true);
  assert.equal(path.relative(firstEnv.tmp, firstEnv.compile).startsWith(".."), true);
  assert.equal(path.relative(secondEnv.tmp, secondEnv.compile).startsWith(".."), true);
  assert.equal(path.relative(explicitExternalEnv.tmp, explicitExternalEnv.compile).startsWith(".."), true);
  assert.equal(path.relative(nestedEnv.tmp, nestedEnv.compile).startsWith(".."), true);
  assert.equal(path.relative(firstCoverageParent, firstEnv.compile).startsWith(".."), true);
  assert.equal(path.relative(secondCoverageParent, secondEnv.compile).startsWith(".."), true);
  assert.equal(path.relative(explicitExternalCoverageParent, explicitExternalEnv.compile).startsWith(".."), true);
  assert.equal(path.relative(path.dirname(nestedEnv.coverage), nestedEnv.compile).startsWith(".."), true);
  assert.notEqual(path.dirname(nestedEnv.tmp), firstEnv.tmp);
  assert.notEqual(firstEnv.coverage, secondEnv.coverage);
  assert.equal(path.basename(firstCoverageParent).startsWith("coverage-run-"), true);
  assert.equal(path.basename(secondCoverageParent).startsWith("coverage-run-"), true);
  assert.equal(path.basename(explicitExternalCoverageParent).startsWith("coverage-run-"), true);
  assert.equal(path.basename(firstEnv.coverage).startsWith("node-coverage-"), true);
  assert.equal(path.basename(secondEnv.coverage).startsWith("node-coverage-"), true);
  assert.equal(path.basename(explicitExternalEnv.coverage).startsWith("node-coverage-"), true);
  assert.equal(path.relative(firstCoverageParent, firstEnv.coverage).startsWith(".."), false);
  assert.equal(path.relative(secondCoverageParent, secondEnv.coverage).startsWith(".."), false);
  assert.equal(path.relative(explicitExternalCoverageParent, explicitExternalEnv.coverage).startsWith(".."), false);
  assert.equal(path.relative(project, firstEnv.tmp).startsWith(".."), true);
  assert.equal(path.relative(project, secondEnv.tmp).startsWith(".."), true);
  assert.equal(path.relative(project, explicitExternalEnv.tmp).startsWith(".."), true);
  assert.equal(path.relative(project, inheritedExternalEnv.tmp).startsWith(".."), true);
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

  const packedConsumer = await createPackedConsumer();
  t.after(packedConsumer.cleanup);
  const { base, consumer, packInfo } = packedConsumer;
  assert.equal(packInfo.name, "opencode-worktree-guardian");
  assert.equal(packInfo.version, packageJson.version);
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
    coverage: "suppress",
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
