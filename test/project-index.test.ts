import assert from "node:assert/strict";
import test from "node:test";
import plugin, { buildProjectSnapshot, collectProjectSnapshot } from "../src/index.ts";

test("project intelligence exports are public", async () => {
  assert.equal(typeof collectProjectSnapshot, "function");
  assert.equal(buildProjectSnapshot, collectProjectSnapshot);
  const hooks = await plugin.server({ directory: "/repo", worktree: "/repo/.worktrees/example" });
  assert.equal(Object.hasOwn(hooks.tool, "guardian_project_status"), true);
});
