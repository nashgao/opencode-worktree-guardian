import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianGoal } from "../src/goal.ts";
import { guardianHygiene } from "../src/hygiene.ts";
import { formatGuardianGoalOutput } from "../src/plugin/readable-output-goal.ts";
import type { GuardianConfig, GuardianGoalHygieneCompletion } from "../src/types.ts";
import { createRepoWithOrigin, createTempDir, git } from "./helpers.ts";

function hygieneGoalConfig(hygieneCompletion: GuardianGoalHygieneCompletion, protectedPaths: readonly string[] = DEFAULT_CONFIG.protectedPaths): GuardianConfig {
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
      cleanupHygiene: true,
      hygieneCompletion,
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

function stepResult(result: Record<string, unknown>, tool: string): Record<string, unknown> {
  const steps = Array.isArray(result.steps) ? result.steps.map((entry) => record(entry, "goal step")) : [];
  return record(steps.find((step) => step.tool === tool)?.result, `${tool} result`);
}

async function exists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true, () => false);
}

async function createNestedRepository(repo: string, relative: string, dirty = false): Promise<string> {
  const nested = path.join(repo, relative);
  await fs.mkdir(nested, { recursive: true });
  await git(nested, ["init", "-b", "main"]);
  await git(nested, ["config", "user.email", "guardian@example.test"]);
  await git(nested, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(nested, "README.md"), "nested\n");
  await git(nested, ["add", "README.md"]);
  await git(nested, ["commit", "-m", "nested initial"]);
  if (dirty) await fs.writeFile(path.join(nested, "dirty.txt"), "dirty\n");
  return nested;
}

async function createMixedResidue(repo: string): Promise<void> {
  await fs.mkdir(path.join(repo, "node-compile-cache"));
  await fs.writeFile(path.join(repo, "node-compile-cache", "cache.bin"), "cache\n");
  await createNestedRepository(repo, "research-clone");
  await fs.mkdir(path.join(repo, "guardian-suspicious"));
  await fs.writeFile(path.join(repo, "guardian-suspicious", "notes.txt"), "notes\n");
}

async function applyGoal(repo: string, config: GuardianConfig, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const plan = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config, ...extra }), "goal plan");
  return record(
    await guardianGoal({ repoRoot: repo, cwd: repo, mode: "apply", config, confirm: true, confirmToken: nonEmptyString(plan.confirmToken, "plan.confirmToken"), ...extra }),
    "goal apply",
  );
}

test("guardian_goal legacy hygiene completion removes approved caches but completes with residual findings", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await createMixedResidue(repo);

  const config = hygieneGoalConfig("authorized-cleanup");
  const plan = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config }), "goal plan");
  const result = await applyGoal(repo, config);

  assert.equal(plan.ok, true);
  assert.equal(plan.complete, null);
  assert.equal(plan.status, "planned");
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.status, "complete");
  assert.equal(await exists(path.join(repo, "node-compile-cache")), false);
  assert.equal(await exists(path.join(repo, "research-clone")), true);
  assert.equal(await exists(path.join(repo, "guardian-suspicious")), true);
  const hygiene = record(result.hygienePostcondition, "hygiene postcondition");
  assert.equal(hygiene.status, "residual-unprotected");
  assert.equal(hygiene.residualCount, 2);
  assert.deepEqual(hygiene.residualByCategory, { "known-cleanable": 0, "nested-git": 1, suspicious: 1 });
});

test("guardian_goal strict hygiene completion removes approved caches and reports remaining nested and suspicious findings", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await createMixedResidue(repo);
  const config = hygieneGoalConfig("no-unprotected-findings");

  const plan = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config }), "goal plan");
  const result = await applyGoal(repo, config);

  assert.equal(plan.ok, true);
  assert.equal(plan.complete, null);
  assert.equal(plan.status, "planned-partial");
  assert.equal(result.ok, true);
  assert.equal(result.complete, false);
  assert.equal(result.status, "partial");
  assert.equal(await exists(path.join(repo, "node-compile-cache")), false);
  const hygiene = record(result.hygienePostcondition, "hygiene postcondition");
  assert.equal(hygiene.status, "residual-unprotected");
  assert.equal(hygiene.residualCount, 2);
});

test("guardian_goal strict hygiene completion remains actionable when only unprotected residuals exist", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await createNestedRepository(repo, "research-clone");
  await fs.mkdir(path.join(repo, "guardian-suspicious"));
  await fs.writeFile(path.join(repo, "guardian-suspicious", "notes.txt"), "notes\n");
  const config = hygieneGoalConfig("no-unprotected-findings");

  const plan = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config }), "goal plan");
  const result = await applyGoal(repo, config);

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned-partial");
  assert.equal(typeof plan.confirmToken, "string");
  assert.equal(result.ok, true);
  assert.equal(result.complete, false);
  assert.equal(result.status, "partial");
});

test("guardian_goal retains the exact bounded hygiene child confirmation needed for apply", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, "node-compile-cache"));
  await fs.writeFile(path.join(repo, "node-compile-cache", "cache.bin"), "cache\n");
  const config = hygieneGoalConfig("no-unprotected-findings");

  const rawChild = record(await guardianHygiene({
    repoRoot: repo,
    cwd: repo,
    config,
    mode: "plan",
    allowCategories: ["known-cleanable"],
    allowDirtyNestedGit: false,
  }), "raw hygiene plan");
  const plan = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config }), "goal plan");
  const child = stepResult(plan, "guardian_hygiene");
  const result = record(await guardianGoal({
    repoRoot: repo,
    cwd: repo,
    mode: "apply",
    confirm: true,
    confirmToken: nonEmptyString(plan.confirmToken, "goal plan confirmToken"),
    config,
  }), "goal apply");

  assert.equal(child.confirmToken, rawChild.confirmToken);
  assert.match(nonEmptyString(child.digest, "hygiene child digest"), /^[0-9a-f]{64}$/);
  assert.equal(child.targetsTotal, 1);
  assert.equal(child.targetsOmittedCount, 0);
  assert.equal(record(child.preflight, "hygiene preflight").targetsTotal, 1);
  assert.equal(await exists(path.join(repo, "node-compile-cache")), false);
  assert.equal(result.ok, true);
});

test("guardian_goal strict hygiene completion excludes protected nested repositories", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await createNestedRepository(repo, "protected-nested");
  const config = hygieneGoalConfig("no-unprotected-findings", ["protected-nested"]);

  const result = await applyGoal(repo, config);

  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.status, "complete");
  const hygiene = record(result.hygienePostcondition, "hygiene postcondition");
  assert.equal(hygiene.status, "satisfied");
  assert.equal(hygiene.protectedExclusionCount, 1);
  assert.equal(await exists(path.join(repo, "protected-nested")), true);
});

test("guardian_goal never authorizes dirty nested repository deletion from caller options", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await createNestedRepository(repo, "research-clone", true);
  const config = hygieneGoalConfig("no-unprotected-findings");

  const plan = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config, allowDirtyNestedGit: true }), "goal plan");
  const result = await applyGoal(repo, config, { allowDirtyNestedGit: true });

  assert.equal(record(stepResult(plan, "guardian_hygiene").preflight, "hygiene preflight").allowDirtyNestedGit, false);
  assert.equal(result.status, "partial");
  assert.equal(await exists(path.join(repo, "research-clone")), true);
});

test("guardian_goal scan failure cannot claim desired-state completion", async (t) => {
  const repo = await createTempDir("guardian-goal-hygiene-no-repo-");
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  const result = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config: hygieneGoalConfig("no-unprotected-findings") }), "goal plan");

  assert.equal(result.ok, false);
  assert.equal(result.complete, null);
  assert.equal(result.status, "blocked");
  assert.equal(record(result.hygienePostcondition, "hygiene postcondition").status, "scan-failed");
});

test("guardian_goal readable output renders bounded sanitized hygiene postcondition evidence", () => {
  const output = formatGuardianGoalOutput({
    ok: true,
    complete: false,
    status: "partial",
    lane: "goal",
    goal: { cleanupHygiene: true },
    steps: [],
    blockers: [],
    hygienePostcondition: {
      mode: "no-unprotected-findings",
      phase: "apply",
      status: "residual-unprotected",
      residualCount: 9,
      residualByCategory: { "known-cleanable": 0, "nested-git": 8, suspicious: 1 },
      residualFindingCount: 9,
      residualFindingsShown: Array.from({ length: 8 }, (_, index) => ({ category: "nested-git", path: `nested-${index}`, reason: "manual review" })),
      residualFindingsOmittedCount: 1,
      residualFindingsTruncated: true,
      protectedExclusionCount: 2,
      reviewableCandidateCount: 3,
    },
  });

  assert.match(output, /hygiene mode=no-unprotected-findings phase=apply status=residual-unprotected complete=false/);
  assert.match(output, /hygiene residuals: 9 .*nested-git=8.*suspicious=1/);
  assert.match(output, /hygiene residual findings: 9 \| omitted: 1/);
  assert.match(output, /hygiene exclusions: 2 \| reviewable inventory: 3/);
  assert.doesNotMatch(output, /confirmToken|mode=apply confirm/);
});

test("guardian_goal readable plan output marks completion as pending", () => {
  const output = formatGuardianGoalOutput({
    ok: true,
    complete: null,
    status: "planned-partial",
    lane: "goal",
    goal: { cleanupHygiene: true },
    steps: [],
    blockers: [],
    hygienePostcondition: {
      mode: "no-unprotected-findings",
      phase: "plan",
      status: "residual-unprotected",
      residualCount: 1,
      residualByCategory: { "known-cleanable": 0, "nested-git": 1, suspicious: 0 },
      residualFindingCount: 1,
      residualFindingsShown: [],
      residualFindingsOmittedCount: 0,
      residualFindingsTruncated: false,
      protectedExclusionCount: 0,
      reviewableCandidateCount: 0,
    },
  });

  assert.match(output, /guardian_goal planned-partial/);
  assert.match(output, /hygiene mode=no-unprotected-findings phase=plan status=residual-unprotected complete=pending/);
});
