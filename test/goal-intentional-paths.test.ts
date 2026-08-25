import assert from "node:assert/strict";
import test from "node:test";
import { createGoalConfirmToken } from "../src/goal-confirm-token.ts";
import { GoalIntentionalPathsError, normalizeGoalIntentionalPaths } from "../src/goal-intentional-paths.ts";

function token(intentionalPaths: readonly string[]): string {
  const plan = {
    repoRoot: "/repo",
    cwd: "/repo/.worktrees/repo/guardian-work",
    intentionalPaths,
    goal: { hygieneCompletion: "no-unprotected-residue" },
    steps: [],
    blockers: [],
    complete: null,
    hygienePostcondition: { status: "satisfied" },
  };
  return createGoalConfirmToken(plan);
}

test("intentionalPaths normalize deterministically and bind the goal token", () => {
  const normalized = normalizeGoalIntentionalPaths(["src/ä.ts", "src/z.ts", "src/ä.ts"]);

  assert.deepEqual(normalized, ["src/z.ts", "src/ä.ts"]);
  assert.equal(token(normalized), token(["src/z.ts", "src/ä.ts"]));
  assert.notEqual(token(normalized), token(["src/z.ts"]));
});

test("intentionalPaths reject unsafe or broad acknowledgments", () => {
  for (const value of [
    "",
    ".",
    "../escape",
    "src/../escape",
    "/absolute",
    "C:/absolute",
    "src/*.ts",
    "src/file?.ts",
  ]) {
    assert.throws(
      () => normalizeGoalIntentionalPaths([value]),
      (error: unknown) => error instanceof GoalIntentionalPathsError && error.code === "invalid_intentional_paths",
      value,
    );
  }
  assert.throws(() => normalizeGoalIntentionalPaths("src/file.ts"), GoalIntentionalPathsError);
});
