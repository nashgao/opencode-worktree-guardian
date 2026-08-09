import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianGoal } from "../src/goal.ts";
import type { GuardianConfig } from "../src/types.ts";
import { createRepo } from "./helpers.ts";

const GOAL_CONFIG: GuardianConfig = {
  ...DEFAULT_CONFIG,
  goal: {
    ...DEFAULT_CONFIG.goal,
    commitDirty: false,
    landToBase: false,
    pushBase: false,
    cleanupWorktrees: false,
    cleanupBranches: false,
    cleanupHygiene: false,
  },
};

const BLOCKED_GOAL_CONFIG: GuardianConfig = {
  ...GOAL_CONFIG,
  goal: {
    ...GOAL_CONFIG.goal,
    commitDirty: true,
  },
};

function record(value: unknown, name: string): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return Object.fromEntries(Object.entries(value));
  throw new TypeError(`${name} must be an object`);
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(`${name} must be a non-empty string`);
}

async function planGoal(repo: string, config = GOAL_CONFIG): Promise<Record<string, unknown>> {
  return record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config }), "goal plan");
}

test("guardian_goal apply reports complete false when its fresh plan is blocked", async (t) => {
  // Given
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const plan = await planGoal(repo, BLOCKED_GOAL_CONFIG);

  // When
  const result = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, config: BLOCKED_GOAL_CONFIG }), "goal apply");

  // Then
  assert.equal(plan.complete, null);
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.complete, false);
});

test("guardian_goal apply reports complete false when confirmation is missing", async (t) => {
  // Given
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const plan = await planGoal(repo);

  // When
  const result = record(
    await guardianGoal({ repoRoot: repo, cwd: repo, mode: "apply", config: GOAL_CONFIG, confirmToken: nonEmptyString(plan.confirmToken, "plan.confirmToken") }),
    "goal apply",
  );

  // Then
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.complete, false);
});

test("guardian_goal apply reports complete false when its confirmation token is missing", async (t) => {
  // Given
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await planGoal(repo);

  // When
  const result = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, config: GOAL_CONFIG }), "goal apply");

  // Then
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.complete, false);
});

test("guardian_goal apply reports complete false when its confirmation token mismatches", async (t) => {
  // Given
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await planGoal(repo);

  // When
  const result = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: "mismatched-token", config: GOAL_CONFIG }), "goal apply");

  // Then
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.complete, false);
});
