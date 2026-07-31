import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { mergePullRequest } from "../src/done-github-pr.ts";
import { getHeadCommit } from "../src/git.ts";
import { installFakeGh } from "./delete-fixtures.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";
import { expectedCodexAdapterFiles, expectedCodexSkillNames, expectedCommandAssets, expectedPackagedCommandTools, expectedSlashNames, expectedToolNames, findLegacyHygieneReferences, projectRoot } from "./package-smoke-helpers.ts";

const ownedRoots: string[] = [];

function hasRuntimeImport(importClause: ts.ImportClause | undefined): boolean {
  if (!importClause || ts.isTypeOnlyImportDeclaration(importClause)) return false;
  if (importClause.name || !importClause.namedBindings) return true;
  if (ts.isNamespaceImport(importClause.namedBindings)) return true;
  return importClause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function resolveRelativeTypeScriptImport(importingFile: string, moduleSpecifier: string): string {
  const unresolvedPath = path.resolve(path.dirname(importingFile), moduleSpecifier);
  const candidates = unresolvedPath.endsWith(".ts") ? [unresolvedPath] : [`${unresolvedPath}.ts`, path.join(unresolvedPath, "index.ts")];
  const resolvedPath = candidates.find((candidate) => fsSync.existsSync(candidate));
  if (!resolvedPath) throw new Error(`could not resolve relative TypeScript import ${moduleSpecifier} from ${importingFile}`);
  return resolvedPath;
}

function runtimeRelativeImports(sourcePath: string): readonly string[] {
  const sourceFile = ts.createSourceFile(sourcePath, fsSync.readFileSync(sourcePath, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const imports: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !hasRuntimeImport(statement.importClause)) continue;
    if (statement.moduleSpecifier.text.startsWith(".")) imports.push(resolveRelativeTypeScriptImport(sourcePath, statement.moduleSpecifier.text));
  }
  return imports;
}

function runtimeImportCycles(entryPath: string): readonly (readonly string[])[] {
  const states = new Map<string, "visiting" | "visited">(), stack: string[] = [], cycles: string[][] = [];
  const visit = (sourcePath: string): void => {
    states.set(sourcePath, "visiting"); stack.push(sourcePath);
    for (const importedPath of runtimeRelativeImports(sourcePath)) {
      const state = states.get(importedPath);
      if (state === "visiting") { cycles.push([...stack.slice(stack.indexOf(importedPath)), importedPath]); continue; }
      if (state !== "visited") visit(importedPath);
    }
    stack.pop(); states.set(sourcePath, "visited");
  };
  visit(entryPath);
  return cycles;
}

test.after(async () => {
  const remaining = await Promise.all(ownedRoots.map((root) => fs.access(root).then(() => root, () => null)));
  assert.deepEqual(remaining.filter((root): root is string => root !== null), []);
});

test("public docs and package inventory stay aligned with guardian command surface", async () => {
  const readme = await fs.readFile(path.join(projectRoot, "README.md"), "utf8");

  for (const commandAsset of expectedCommandAssets) {
    await fs.access(path.join(projectRoot, commandAsset));
  }

  for (const codexAdapterFile of expectedCodexAdapterFiles) {
    await fs.access(path.join(projectRoot, codexAdapterFile));
  }

  for (const codexSkillName of expectedCodexSkillNames) {
    const skill = await fs.readFile(path.join(projectRoot, "codex", "skills", codexSkillName, "SKILL.md"), "utf8");
    assert.match(skill, new RegExp(`^---\\nname: ${codexSkillName}\\n`), `${codexSkillName} must have Codex skill frontmatter`);
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

  const doneCommand = await fs.readFile(path.join(projectRoot, "commands", "done.md"), "utf8");
  const doneSkill = await fs.readFile(path.join(projectRoot, "codex", "skills", "guardian-done", "SKILL.md"), "utf8");
  for (const surface of [readme, doneCommand, doneSkill]) {
    assert.match(surface, /one dirty implementation target|exactly one dirty implementation target/);
    assert.match(surface, /needs-selection/);
    assert.match(surface, /primary=true/);
    assert.match(surface, /sessionId=\.\.\./);
    assert.match(surface, /branch=\.\.\./);
  }

  assert.deepEqual(await findLegacyHygieneReferences(), []);
});

test("package metadata excludes the vulnerable visual HUD dependency chain", async () => {
  const [packageText, lockText, tsconfigText, tuiText] = await Promise.all([
    fs.readFile(path.join(projectRoot, "package.json"), "utf8"),
    fs.readFile(path.join(projectRoot, "package-lock.json"), "utf8"),
    fs.readFile(path.join(projectRoot, "tsconfig.json"), "utf8"),
    fs.readFile(path.join(projectRoot, "src", "tui.ts"), "utf8"),
  ]);
  const packageJson = JSON.parse(packageText);
  const tsconfig = JSON.parse(tsconfigText);
  const prohibitedDependencies = ["@opentui/core", "@opentui/keymap", "@opentui/solid", "solid-js"];

  assert.deepEqual(prohibitedDependencies.filter((dependency) => dependency in packageJson.dependencies), []);
  for (const dependency of [...prohibitedDependencies, "brace-expansion"]) {
    assert.doesNotMatch(lockText, new RegExp(`node_modules/${dependency.replace("/", "\\/")}`));
  }
  assert.equal("jsx" in tsconfig.compilerOptions, false);
  assert.equal("jsxImportSource" in tsconfig.compilerOptions, false);
  assert.doesNotMatch(tuiText, /hud\/Hud\.tsx/);
});

test("physical HUD source removal remains owned by the parent deletion step", async () => {
  await assert.rejects(fs.access(path.join(projectRoot, "src", "hud", "Hud.tsx")));
});

test("release checklist requires the HUD fallback manual check", async () => {
  const checklist = await fs.readFile(path.join(projectRoot, "docs", "release-checklist.md"), "utf8");
  assert.match(checklist, /Run `\/guardian-hud`/);
  assert.match(checklist, /Guardian HUD unavailable/);
  assert.match(checklist, /opens no dialog, and submits no prompt/);
  assert.match(checklist, /`\/guardian-status` still returns repository inventory/);
});

test("Codex plugin payload is packaged and points at Guardian hooks", async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  const pluginJson = JSON.parse(await fs.readFile(path.join(projectRoot, "codex", ".codex-plugin", "plugin.json"), "utf8"));
  const hooksJson = JSON.parse(await fs.readFile(path.join(projectRoot, "codex", "hooks", "hooks.json"), "utf8"));
  const rootPluginJson = JSON.parse(await fs.readFile(path.join(projectRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const rootHooksJson = JSON.parse(await fs.readFile(path.join(projectRoot, "hooks", "hooks.json"), "utf8"));
  const codexSkillNames = (await fs.readdir(path.join(projectRoot, "codex", "skills"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.equal(packageJson.files.includes("codex"), true);
  assert.equal(packageJson.exports["./codex"], "./codex/hooks/guardian-hook.ts");
  assert.equal(pluginJson.hooks, "./hooks/hooks.json");
  assert.equal(pluginJson.skills, "./skills/");
  assert.match(hooksJson.hooks.PreToolUse[0].hooks[0].command, /^node "\$\{PLUGIN_ROOT\}\/hooks\/guardian-hook\.ts" hook pre-tool-use$/);
  assert.match(hooksJson.hooks.PostToolUse[0].hooks[0].command, /^node "\$\{PLUGIN_ROOT\}\/hooks\/guardian-hook\.ts" hook post-tool-use$/);
  assert.doesNotMatch(hooksJson.hooks.PreToolUse[0].hooks[0].command, /\.\.\/node_modules|\/Users\//);
  assert.equal(rootPluginJson.hooks, "./hooks/hooks.json");
  assert.equal(rootPluginJson.skills, "./codex/skills/");
  assert.match(rootHooksJson.hooks.PreToolUse[0].hooks[0].command, /^node "\$\{PLUGIN_ROOT\}\/codex\/hooks\/guardian-hook\.ts" hook pre-tool-use$/);
  assert.match(rootHooksJson.hooks.PostToolUse[0].hooks[0].command, /^node "\$\{PLUGIN_ROOT\}\/codex\/hooks\/guardian-hook\.ts" hook post-tool-use$/);
  assert.deepEqual(codexSkillNames, [
    "guardian-delete-paths",
    "guardian-delete-worktree",
    "guardian-done",
    "guardian-finish",
    "guardian-finish-workflow",
    "guardian-gc",
    "guardian-goal",
    "guardian-hud",
    "guardian-hygiene",
    "guardian-init",
    "guardian-preserve",
    "guardian-project-status",
    "guardian-recover",
    "guardian-report",
    "guardian-start",
    "guardian-status",
    "guardian-unblock-finish",
    "worktree-guardian",
  ]);
});

test("reference transaction hook refuses a direct fake-gh merge before invocation", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  ownedRoots.push(base);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const head = await getHeadCommit(repo);
  const fakeGh = await installFakeGh(t, { repo, branch: "guardian/merge-probe", head });
  const marker = path.join(base, "gh-hook-ran"); const hooks = path.join(repo, "reference-transaction-hooks");
  await fs.mkdir(hooks, { recursive: true });
  await fs.writeFile(path.join(hooks, "reference-transaction"), `#!/bin/sh\nprintf hook > ${JSON.stringify(marker)}\n`, "utf8");
  await fs.chmod(path.join(hooks, "reference-transaction"), 0o755); await git(repo, ["config", "core.hooksPath", hooks]);

  const result = await mergePullRequest(repo, { number: 1, url: "https://github.example/acme/widget/pull/1", headRefName: "guardian/merge-probe", headRefOid: head }, head, false);

  assert.equal(result.ok, false, JSON.stringify(result));
  await assert.rejects(fs.access(marker));
  await assert.rejects(fs.access(fakeGh.logPath));
});

test("runtime value imports reachable from done-land-clean-commit contain no DFS back-edges", () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url));
  const entryPath = path.join(testDirectory, "..", "src", "done-land-clean-commit.ts");

  assert.deepEqual(runtimeImportCycles(entryPath), []);
});
