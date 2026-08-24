import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { runGitNullSeparated } from "../src/git.ts";
import { guardianGoal } from "../src/goal.ts";
import { formatGuardianGoalOutput } from "../src/plugin/readable-output-goal.ts";
import type { GuardianConfig } from "../src/types.ts";
import { createRepoWithOrigin } from "./helpers.ts";

function residueGoalConfig(protectedPaths: readonly string[] = DEFAULT_CONFIG.protectedPaths, cleanupHygiene = true): GuardianConfig {
  return {
    ...DEFAULT_CONFIG,
    protectedPaths,
    goal: {
      ...DEFAULT_CONFIG.goal,
      commitDirty: false,
      landToBase: false,
      pushBase: false,
      cleanupWorktrees: false,
      cleanupBranches: false,
      cleanupHygiene,
      hygieneCompletion: "no-unprotected-residue",
    },
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return Object.fromEntries(Object.entries(value));
  throw new TypeError(`${name} must be an object`);
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(`${name} must be a non-empty string`);
}

async function applyGoal(repo: string, config: GuardianConfig, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const plan = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config, ...extra }), "goal plan");
  return record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "apply", config, confirm: true, confirmToken: nonEmptyString(plan.confirmToken, "plan.confirmToken"), ...extra }), "goal apply");
}

async function exists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true, () => false);
}

test("guardian_goal strict residue completion blocks on bounded reviewable inventory", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  for (const index of Array.from({ length: 9 }, (_, value) => value)) {
    await fs.writeFile(path.join(repo, `ordinary-${index}.txt`), "reviewable\n");
  }
  const config = residueGoalConfig();

  const plan = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config }), "goal plan");
  const result = await applyGoal(repo, config);
  const hygiene = record(result.hygienePostcondition, "hygiene postcondition");
  const shown = Array.isArray(hygiene.reviewableCandidatesShown) ? hygiene.reviewableCandidatesShown : [];
  const output = formatGuardianGoalOutput(result);

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned-partial");
  assert.equal(typeof plan.confirmToken, "string");
  assert.equal(result.ok, true);
  assert.equal(result.complete, false);
  assert.equal(result.status, "partial");
  assert.equal(hygiene.status, "residual-unprotected");
  assert.equal(hygiene.residualCount, 0);
  assert.equal(hygiene.reviewableCandidateCount, 9);
  assert.equal(shown.length, 8);
  assert.equal(hygiene.reviewableCandidatesOmittedCount, 1);
  assert.equal(hygiene.reviewableCandidatesTruncated, true);
  assert.equal(hygiene.reviewableInventoryComplete, true);
  assert.match(nonEmptyString(hygiene.reviewableDigest, "reviewable digest"), /^[0-9a-f]{64}$/);
  assert.match(output, /hygiene reviewable candidates: 9 \| omitted: 1/);
  assert.match(output, /reviewable digest: [0-9a-f]{64}/);
  assert.match(output, /guardian_delete_paths mode=plan paths=/);
  assert.match(output, /protectedPaths/);
  assert.match(output, /\.omo\/evidence/);
});

test("guardian_goal strict residue completion accepts intentionally protected reviewables", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "ordinary.txt"), "reviewable\n");
  const config = residueGoalConfig(["ordinary.txt"]);

  const result = await applyGoal(repo, config);
  const hygiene = record(result.hygienePostcondition, "hygiene postcondition");

  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.status, "complete");
  assert.equal(hygiene.status, "satisfied");
  assert.equal(hygiene.reviewableCandidateCount, 0);
  assert.equal(hygiene.protectedExclusionCount, 1);
  assert.equal(await exists(path.join(repo, "ordinary.txt")), true);
});

test("guardian_goal existing strict findings mode reports reviewables without blocking completion", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "ordinary.txt"), "reviewable\n");
  const strictResidueConfig = residueGoalConfig();
  const config: GuardianConfig = {
    ...strictResidueConfig,
    goal: { ...strictResidueConfig.goal, hygieneCompletion: "no-unprotected-findings" },
  };

  const result = await applyGoal(repo, config);
  const hygiene = record(result.hygienePostcondition, "hygiene postcondition");

  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(hygiene.residualCount, 0);
  assert.equal(hygiene.reviewableCandidateCount, 1);
});

test("guardian_goal strict residue completion fails closed on incomplete inventory coverage", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, "coverage-a"));
  await fs.mkdir(path.join(repo, "coverage-b"));
  const config = residueGoalConfig();
  const scanLimits = { emptyDirectoryMaxEntries: 1 };

  const plan = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config, ...scanLimits }), "goal plan");
  const result = await applyGoal(repo, config, scanLimits);
  const hygiene = record(result.hygienePostcondition, "hygiene postcondition");

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned-partial");
  assert.equal(result.ok, true);
  assert.equal(result.complete, false);
  assert.equal(result.status, "partial");
  assert.equal(hygiene.status, "scan-incomplete");
  assert.equal(hygiene.reviewableInventoryComplete, false);
  assert.match(nonEmptyString(result.reason, "goal reason"), /inventory is incomplete/);
});

test("guardian_goal strict residue completion scans when cleanupHygiene is disabled", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "ordinary.txt"), "reviewable\n");

  const plan = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config: residueGoalConfig(DEFAULT_CONFIG.protectedPaths, false) }), "goal plan");
  const hygiene = record(plan.hygienePostcondition, "hygiene postcondition");

  assert.equal(plan.status, "planned-partial");
  assert.equal(hygiene.phase, "plan");
  assert.equal(hygiene.reviewableCandidateCount, 1);
});

test("guardian_goal reviewable evidence uses deterministic code-unit ordering", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  for (const relative of ["reviewable-z.txt", "reviewable-ä.txt", "reviewable-a.txt"]) {
    await fs.writeFile(path.join(repo, relative), "same\n");
  }
  const config = residueGoalConfig();
  const reverseRunner = async (repoPath: string, args: readonly string[]): Promise<string[]> => [...await runGitNullSeparated(repoPath, args)].reverse();

  const forward = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config }), "forward plan");
  const reversed = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config, runGitNullSeparated: reverseRunner }), "reversed plan");
  const forwardHygiene = record(forward.hygienePostcondition, "forward hygiene");
  const reversedHygiene = record(reversed.hygienePostcondition, "reversed hygiene");
  const paths = Array.isArray(forwardHygiene.reviewableCandidatesShown)
    ? forwardHygiene.reviewableCandidatesShown.map((entry) => record(entry, "reviewable candidate").path)
    : [];

  assert.deepEqual(paths, ["reviewable-a.txt", "reviewable-z.txt", "reviewable-ä.txt"]);
  assert.equal(forwardHygiene.reviewableDigest, reversedHygiene.reviewableDigest);
  assert.deepEqual(forwardHygiene.reviewableCandidatesShown, reversedHygiene.reviewableCandidatesShown);
  assert.equal(forward.confirmToken, reversed.confirmToken);
});

test("guardian_goal token binds reviewable identities omitted from bounded output", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  for (const index of Array.from({ length: 9 }, (_, value) => value)) {
    await fs.writeFile(path.join(repo, `ordinary-${index}.txt`), "same\n");
  }
  const config = residueGoalConfig();

  const before = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config }), "before plan");
  const beforeHygiene = record(before.hygienePostcondition, "before hygiene");
  await fs.rename(path.join(repo, "ordinary-8.txt"), path.join(repo, "ordinary-9.txt"));
  const after = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config }), "after plan");
  const afterHygiene = record(after.hygienePostcondition, "after hygiene");

  assert.deepEqual(beforeHygiene.reviewableCandidatesShown, afterHygiene.reviewableCandidatesShown);
  assert.notEqual(beforeHygiene.reviewableDigest, afterHygiene.reviewableDigest);
  assert.notEqual(before.confirmToken, after.confirmToken);
});
