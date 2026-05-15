import assert from "node:assert/strict";
import test from "node:test";
import { classifyGuardCommand } from "../src/guards.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { readState, recordSession, getGuardianPaths } from "../src/state.ts";
import { createRepo } from "./helpers.ts";

test("long command strings classify quickly and safely", () => {
  const command = `${"printf safe && ".repeat(250)}bash -c "git restore ."`;
  const started = performance.now();
  const result = classifyGuardCommand(command);
  assert.equal(result.blocked, true);
  assert.equal(performance.now() - started < 250, true);
});

test("large guardian state remains readable", async () => {
  const repo = await createRepo();
  for (let index = 0; index < 40; index += 1) {
    await recordSession(repo, DEFAULT_CONFIG, {
      session_id: `ses_large_${index}`,
      status: "active",
      branch: `guardian/large-${index}`,
      worktree_path: repo,
      base_ref: "origin/main",
      safety_refs: [],
    });
  }
  const paths = await getGuardianPaths(repo);
  const started = performance.now();
  const state = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(Object.keys(state.sessions).length, 40);
  assert.equal(performance.now() - started < 250, true);
});
