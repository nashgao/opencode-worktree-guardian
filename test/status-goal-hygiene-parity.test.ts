import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianGoal } from "../src/goal.ts";
import { formatGuardianStatusOutput } from "../src/plugin/readable-output-status.ts";
import { guardianStatus } from "../src/recover.ts";
import type { GuardianConfig } from "../src/types.ts";
import { createRepoWithOrigin } from "./helpers.ts";

function record(value: unknown, name: string): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return Object.fromEntries(Object.entries(value));
  throw new TypeError(`${name} must be an object`);
}

test("guardian_status and strict guardian_goal both reject default-bound incomplete hygiene coverage", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const nested = Array.from({ length: 13 }, (_, index) => `depth-${index}`);
  await fs.mkdir(path.join(repo, ...nested), { recursive: true });
  const config: GuardianConfig = {
    ...DEFAULT_CONFIG,
    goal: {
      ...DEFAULT_CONFIG.goal,
      commitDirty: false,
      landToBase: false,
      pushBase: false,
      cleanupWorktrees: false,
      cleanupBranches: false,
      hygieneCompletion: "no-unprotected-residue",
    },
  };

  const status = await guardianStatus({ repoRoot: repo, cwd: repo, config });
  const goal = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config }), "goal plan");
  const hygiene = record(status.hygiene, "status hygiene");
  const summary = record(hygiene.summary, "status hygiene summary");
  const goalHygiene = record(goal.hygienePostcondition, "goal hygiene postcondition");

  assert.equal(summary.filesystemOnlyEmptyDirectoryScanComplete, false);
  assert.match(formatGuardianStatusOutput("guardian_status", status), /^\[WARN\] Guardian Status: Needs review/m);
  assert.equal(goal.status, "planned-partial");
  assert.equal(goalHygiene.status, "scan-incomplete");
});
