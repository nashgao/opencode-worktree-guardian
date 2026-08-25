import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianGoal } from "../src/goal.ts";
import { scanWorkspaceHygiene } from "../src/hygiene.ts";
import { PROTECTED_INVENTORY_MAX_ROOTS } from "../src/hygiene-protected-inventory.ts";
import { formatGuardianGoalOutput } from "../src/plugin/readable-output-goal.ts";
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
  await fs.mkdir(path.join(repo, ".opencode"));
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
  const protectedInventory = record(goalHygiene.protectedInventory, "goal protected inventory");

  assert.equal(summary.filesystemOnlyEmptyDirectoryScanComplete, false);
  assert.equal(summary.protectedInventoryRootsTruncated, false);
  assert.equal(summary.protectedInventoryBytesTruncated, true);
  assert.match(formatGuardianStatusOutput("guardian_status", status), /^\[WARN\] Guardian Status: Needs review/m);
  assert.equal(goal.status, "planned-partial");
  assert.equal(goalHygiene.status, "scan-incomplete");
  assert.equal(protectedInventory.rootsTruncated, false);
  assert.equal(protectedInventory.bytesTruncated, true);
  assert.doesNotMatch(formatGuardianGoalOutput(goal), /additional protected roots|omitted: >/);
});

test("incomplete discovery does not report omitted roots after a candidate reveals their parent", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const protectedChildren = Array.from({ length: PROTECTED_INVENTORY_MAX_ROOTS + 1 }, (_, index) => `dist/child-${String(index).padStart(3, "0")}`);
  await Promise.all(protectedChildren.map((entry) => fs.mkdir(path.join(repo, entry), { recursive: true })));
  await fs.writeFile(path.join(repo, "a-distinct"), "distinct\n", "utf8");
  await fs.writeFile(path.join(repo, "dist", "candidate.txt"), "candidate\n", "utf8");
  const config: GuardianConfig = { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths, "a-distinct", ...protectedChildren] };

  const scan = await scanWorkspaceHygiene({ repoRoot: repo, config, emptyDirectoryMaxEntries: 1 });

  assert.equal(scan.summary.filesystemOnlyEmptyDirectoryScanComplete, false);
  assert.deepEqual(scan.exclusions.map((entry) => entry.path), ["a-distinct", "dist"]);
  assert.equal(scan.summary.protectedInventoryRootsTruncated, false);
  assert.equal(scan.summary.protectedInventoryBytesTruncated, true);
});
