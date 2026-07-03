import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CONFIG_PATH, DEFAULT_CONFIG, initializeConfig, loadConfig, normalizeConfig } from "../src/config.ts";
import { createTempDir } from "./helpers.ts";

test("config defaults are delivery-first and cleanup-conservative", () => {
  const config = normalizeConfig();
  assert.equal(config.finishMode, "create-pr");
  assert.equal(config.autoStart, true);
  assert.equal(config.autoStartMode, "eager");
  assert.equal(config.autoFinish, false);
  assert.equal(config.autoCleanup, false);
  assert.equal(config.allowStashIfUnrelated, false);
  assert.deepEqual(config.allowDirtyPaths, []);
  assert.deepEqual(config.protectedPaths, [".omo", ".omc", ".omx", ".sisyphus", ".milestones"]);
  assert.deepEqual(config.protectedBranches, DEFAULT_CONFIG.protectedBranches);
});

test("repo-local config overrides defaults but keeps protected baselines", async () => {
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
  assert.deepEqual(config.protectedPaths, [".omo", ".omc", ".omx", ".sisyphus", ".milestones", ".agent-state"]);
  assert.deepEqual(config.protectedBranches, ["main", "master", "develop", "production", "release"]);
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
  assert.equal(await fs.readFile(configPath, "utf8"), `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
});

test("non-object config payload is ignored at the boundary", async () => {
  const repo = await createTempDir();
  await fs.mkdir(path.join(repo, ".opencode"));
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify(["create-pr"]));

  const { config, loaded } = await loadConfig(repo);

  assert.equal(loaded, false);
  assert.deepEqual(config, DEFAULT_CONFIG);
});

test("invalid finish modes fail closed", () => {
  assert.throws(() => normalizeConfig({ finishMode: "delete-everything" }), /Unsupported/);
});

test("invalid auto-start modes fail closed", () => {
  assert.throws(() => normalizeConfig({ autoStartMode: "sometimes" }), /Unsupported/);
});
