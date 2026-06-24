import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, loadConfig, normalizeConfig } from "../src/config.ts";
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
  assert.deepEqual(config.protectedBranches, DEFAULT_CONFIG.protectedBranches);
});

test("repo-local config overrides defaults but keeps protected branch baseline", async () => {
  const repo = await createTempDir();
  await fs.mkdir(path.join(repo, ".opencode"));
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({
    finishMode: "create-pr",
    autoStart: false,
    autoStartMode: "lazy",
    autoFinish: true,
    allowDirtyPaths: [".claude/logs/**", "", ".claude/logs/**", ".omx/**"],
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
  assert.deepEqual(config.protectedBranches, ["main", "master", "develop", "production", "release"]);
});

test("missing config loads defaults without pretending a file was read", async () => {
  const repo = await createTempDir();

  const { config, loaded } = await loadConfig(repo);

  assert.equal(loaded, false);
  assert.deepEqual(config, DEFAULT_CONFIG);
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
