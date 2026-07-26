import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CONFIG_PATH, DEFAULT_CONFIG, initializeConfig, loadConfig, normalizeConfig } from "../src/config.ts";
import { isRecordLike } from "../src/types.ts";
import { createTempDir } from "./helpers.ts";

const TEMPLATE_PROTECTED_PATHS = [".omo", ".omc", ".omx", ".sisyphus", ".milestones", ".opencode", ".codegraph", ".worktrees"];

test("config defaults are delivery-first and cleanup-conservative", () => {
  const config = normalizeConfig();
  assert.equal(config.finishMode, "create-pr");
  assert.equal(config.commandInterceptionMode, "audit");
  assert.equal(config.autoStart, true);
  assert.equal(config.autoStartMode, "eager");
  assert.equal(config.autoFinish, false);
  assert.equal(config.autoCleanup, false);
  assert.equal(config.allowStashIfUnrelated, false);
  assert.deepEqual(config.allowDirtyPaths, []);
  assert.deepEqual(config.protectedPaths, TEMPLATE_PROTECTED_PATHS);
  assert.deepEqual(config.protectedBranches, DEFAULT_CONFIG.protectedBranches);
});

test("command interception defaults to audit", () => {
  assert.equal(DEFAULT_CONFIG.commandInterceptionMode, "audit");
  assert.equal(normalizeConfig({}).commandInterceptionMode, "audit");
});

test("command interception accepts strict mode", () => {
  assert.equal(normalizeConfig({ commandInterceptionMode: "strict" }).commandInterceptionMode, "strict");
});

test("invalid command interception modes fail closed", () => {
  assert.throws(
    () => normalizeConfig({ commandInterceptionMode: "block" }),
    (error: unknown) => isRecordLike(error) && error.configErrorKind === "unsupported_command_interception_mode",
  );
});

test("repo-local config replaces template protected paths", async () => {
  const repo = await createTempDir();
  await fs.mkdir(path.join(repo, ".opencode"));
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({
    finishMode: "create-pr",
    autoStart: false,
    autoStartMode: "lazy",
    autoFinish: true,
    allowDirtyPaths: [".claude/logs/**", "", ".claude/logs/**", ".omx/**"],
    protectedPaths: ["./.agent-state", ".omo/cache", "../outside", "/tmp/outside", ".agent-state/logs"],
    protectedBranches: ["release"],
  }));

  const { config, loaded } = await loadConfig(repo);
  assert.equal(loaded, true);
  assert.equal(config.finishMode, "create-pr");
  assert.equal(config.autoStart, false);
  assert.equal(config.autoStartMode, "lazy");
  assert.equal(config.autoFinish, true);
  assert.equal(config.autoCleanup, false);
  assert.equal(config.allowStashIfUnrelated, false);
  assert.deepEqual(config.allowDirtyPaths, [".claude/logs/**", ".omx/**"]);
  assert.deepEqual(config.protectedPaths, [".agent-state", ".omo/cache"]);
  assert.deepEqual(config.protectedBranches, ["main", "master", "develop", "production", "release"]);
});

test("repo-local config uses template protected paths when the field is absent", async () => {
  const repo = await createTempDir();
  await fs.mkdir(path.join(repo, ".opencode"));
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({
    autoStartMode: "lazy",
  }));

  const { config, loaded } = await loadConfig(repo);

  assert.equal(loaded, true);
  assert.equal(config.autoStartMode, "lazy");
  assert.deepEqual(config.protectedPaths, TEMPLATE_PROTECTED_PATHS);
});

test("missing config loads defaults without pretending a file was read", async () => {
  const repo = await createTempDir();

  const { config, loaded } = await loadConfig(repo);

  assert.equal(loaded, false);
  assert.deepEqual(config, DEFAULT_CONFIG);
});

test("config initialization writes defaults once", async () => {
  const repo = await createTempDir();
  const configPath = path.join(repo, CONFIG_PATH);

  const created = await initializeConfig(repo);
  const existing = await initializeConfig(repo);
  const loaded = await loadConfig(repo);

  assert.equal(created.status, "created");
  assert.equal(created.created, true);
  assert.equal(created.configPath, configPath);
  assert.equal(existing.status, "exists");
  assert.equal(existing.created, false);
  assert.deepEqual(loaded.config, DEFAULT_CONFIG);
  assert.deepEqual(loaded.config.protectedPaths, TEMPLATE_PROTECTED_PATHS);
  assert.equal(await fs.readFile(configPath, "utf8"), `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
});

test("non-object config payloads fail closed at the boundary", async () => {
  for (const payload of [[], null, "create-pr", 1, true]) {
    const repo = await createTempDir();
    await fs.mkdir(path.join(repo, ".opencode"));
    await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify(payload));

    await assert.rejects(
      () => loadConfig(repo),
      (error: unknown) => isRecordLike(error) && error.configErrorKind === "invalid_config_root",
    );
  }
});

test("invalid finish modes fail closed", () => {
  assert.throws(() => normalizeConfig({ finishMode: "delete-everything" }), /Unsupported/);
});

test("invalid auto-start modes fail closed", () => {
  assert.throws(() => normalizeConfig({ autoStartMode: "sometimes" }), /Unsupported/);
});
