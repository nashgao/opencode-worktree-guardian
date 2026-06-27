import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../src/index.ts";

test("exports the current OpenCode plugin object shape", () => {
  assert.equal(plugin.id, "opencode-worktree-guardian");
  assert.equal(typeof plugin.server, "function");
});

test("exposes guardian native tools", async () => {
  const hooks = await plugin.server({ directory: "/repo", worktree: "/repo/.worktrees/example" });
  assert.deepEqual(Object.keys(hooks.tool).sort(), [
    "guardian_delete_paths",
    "guardian_delete_worktree",
    "guardian_done",
    "guardian_finish",
    "guardian_finish_workflow",
    "guardian_gc",
    "guardian_hygiene",
    "guardian_preserve",
    "guardian_project_status",
    "guardian_recover",
    "guardian_report_html",
    "guardian_start",
    "guardian_status",
    "guardian_unblock_finish",
  ]);
});
