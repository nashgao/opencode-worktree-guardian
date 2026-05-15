import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, loadConfig, normalizeConfig } from "../src/config.ts";
import { createTempDir } from "./helpers.ts";

test("config defaults are conservative", () => {
  const config = normalizeConfig();
  assert.equal(config.finishMode, "preserve-only");
  assert.equal(config.autoFinish, false);
  assert.equal(config.autoCleanup, false);
  assert.equal(config.allowStashIfUnrelated, false);
  assert.deepEqual(config.protectedBranches, DEFAULT_CONFIG.protectedBranches);
});

test("repo-local config overrides defaults but keeps protected branch baseline", async () => {
  const repo = await createTempDir();
  await fs.mkdir(path.join(repo, ".opencode"));
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({
    finishMode: "create-pr",
    autoFinish: true,
    protectedBranches: ["release"],
  }));

  const { config, loaded } = await loadConfig(repo);
  assert.equal(loaded, true);
  assert.equal(config.finishMode, "create-pr");
  assert.equal(config.autoFinish, true);
  assert.equal(config.autoCleanup, false);
  assert.equal(config.allowStashIfUnrelated, false);
  assert.deepEqual(config.protectedBranches, ["main", "master", "develop", "production", "release"]);
});

test("invalid finish modes fail closed", () => {
  assert.throws(() => normalizeConfig({ finishMode: "delete-everything" }), /Unsupported/);
});
