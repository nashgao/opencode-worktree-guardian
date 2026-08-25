import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianGoal } from "../src/goal.ts";
import { guardianHygiene, scanWorkspaceHygiene } from "../src/hygiene.ts";
import { guardianStatus } from "../src/recover.ts";
import { guardianStart } from "../src/start.ts";
import { formatGuardianHygieneOutput } from "../src/plugin/readable-output-cleanup.ts";
import { formatGuardianGoalOutput } from "../src/plugin/readable-output-goal.ts";
import type { GuardianConfig, RecordLike } from "../src/types.ts";
import { isRecordLike } from "../src/types.ts";
import { computeGuardianVerdict } from "../src/verdict.ts";
import { createRepo, createRepoWithOrigin, git } from "./helpers.ts";

function protectedConfig(protectedPath: string): GuardianConfig {
  return {
    ...DEFAULT_CONFIG,
    protectedPaths: [...DEFAULT_CONFIG.protectedPaths, protectedPath],
    goal: { ...DEFAULT_CONFIG.goal, hygieneCompletion: "no-unprotected-residue" },
  };
}

function record(value: unknown, name: string): RecordLike {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

async function writeProtectedFixture(repo: string): Promise<void> {
  await fs.mkdir(path.join(repo, ".agent-state", "nested"), { recursive: true });
  await fs.writeFile(path.join(repo, ".agent-state", "alpha.txt"), "alpha\n");
  await fs.writeFile(path.join(repo, ".agent-state", "nested", "beta.txt"), "beta\n");
}

test("guardian_hygiene reports measured protected content when a path is configured protected", async (t) => {
  // Given
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, ".gitignore"), ".agent-state/\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore protected fixture"]);
  await writeProtectedFixture(repo);

  // When
  const scan = await scanWorkspaceHygiene({ repoRoot: repo, config: protectedConfig(".agent-state") });

  // Then
  const summary = record(scan.summary, "hygiene summary");
  const inventory = scan.exclusions.map((entry) => record(entry, "protected inventory entry"));
  const protectedEntry = inventory.find((entry) => entry.path === ".agent-state");
  assert.ok(protectedEntry);
  assert.equal(summary.protectedInventoryCount, 1);
  assert.equal(summary.protectedInventoryRootsTruncated, false);
  assert.equal(summary.protectedInventoryFileCount, 2);
  assert.equal(summary.protectedInventoryDirectoryCount, 2);
  assert.equal(summary.protectedInventoryTotalBytes, 11);
  assert.equal(summary.protectedInventoryBytesTruncated, false);
  assert.equal(protectedEntry.assessment, "not-assessed");
  assert.equal(protectedEntry.cleanupAuthorized, false);
  assert.equal(protectedEntry.fileCount, 2);
  assert.equal(protectedEntry.directoryCount, 2);
  assert.equal(protectedEntry.bytes, 11);
  assert.equal(protectedEntry.bytesTruncated, false);
  assert.deepEqual(scan.findings, []);
  assert.deepEqual(scan.reviewableCandidates, []);
});

test("guardian_hygiene never promotes protected inventory into cleanup targets", async (t) => {
  // Given
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await writeProtectedFixture(repo);
  const config = protectedConfig(".agent-state");

  // When
  const plan = await guardianHygiene({ repoRoot: repo, config, mode: "plan", cleanupPaths: [".agent-state"] });

  // Then
  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.deepEqual(plan.targets, []);
  assert.equal(plan.confirmToken, undefined);
  assert.equal(Array.isArray(plan.blockers) && plan.blockers.some((value) => record(value, "blocker").fatal === true), true);
});

test("guardian_status warns when protected content has not been retention-assessed", async (t) => {
  // Given
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, ".gitignore"), ".agent-state/\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore protected fixture"]);
  await writeProtectedFixture(repo);

  // When
  const status = await guardianStatus({ repoRoot: repo, config: protectedConfig(".agent-state") });
  const verdict = computeGuardianVerdict(status);

  // Then
  assert.equal(verdict.tone, "warn");
  assert.match(verdict.headline, /protected content has not been retention-assessed/);
  assert.equal(verdict.nextAction, "guardian_hygiene to inspect protected inventory");
});

test("guardian_goal reports protected inventory metrics and exact roots without treating them as deletion targets", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await writeProtectedFixture(repo);

  // When
  const plan = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config: protectedConfig(".agent-state") }), "goal plan");

  // Then
  const postcondition = record(plan.hygienePostcondition, "hygiene postcondition");
  const protectedInventory = record(postcondition.protectedInventory, "protected inventory");
  assert.equal(postcondition.status, "satisfied");
  assert.equal(postcondition.protectedExclusionCount, 1);
  assert.equal(protectedInventory.rootCount, 1);
  assert.equal(protectedInventory.rootsTruncated, false);
  assert.deepEqual(protectedInventory.rootsShown, [".agent-state"]);
  assert.equal(protectedInventory.rootsOmittedCount, 0);
  assert.equal(protectedInventory.fileCount, 2);
  assert.equal(protectedInventory.directoryCount, 2);
  assert.equal(protectedInventory.totalBytes, 11);
  assert.equal(protectedInventory.bytesTruncated, false);
  assert.equal(protectedInventory.assessment, "not-assessed");
  assert.equal(protectedInventory.cleanupAuthorized, false);
  assert.equal(postcondition.reviewableCandidateCount, 0);
});

test("guardian_hygiene counts only the outer protected root when a registered worktree is nested inside it", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_protected_inventory_overlap", taskName: "protected inventory overlap", createWorktree: true, config: DEFAULT_CONFIG });

  // When
  const scan = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });

  // Then
  const protectedPaths = scan.exclusions.map((entry) => entry.path);
  assert.equal(protectedPaths.includes(".worktrees"), true);
  assert.equal(protectedPaths.some((entry) => entry.startsWith(".worktrees/")), false);
  assert.equal(scan.summary.protectedInventoryCount, 1);
});

test("guardian_hygiene readable output shows every protected root in the standard repository-sized inventory", () => {
  // Given
  const exclusions = Array.from({ length: 9 }, (_, index) => ({ path: `protected-${index}`, reason: "configured protected path", assessment: "not-assessed", cleanupAuthorized: false, fileCount: 1, directoryCount: 0, bytes: 1, bytesTruncated: false }));

  // When
  const output = formatGuardianHygieneOutput({ ok: true, repoRoot: "/repo", summary: { findingCount: 0, exclusionCount: 9, protectedInventoryCount: 9, protectedInventoryRootsTruncated: false, protectedInventoryFileCount: 9, protectedInventoryDirectoryCount: 0, protectedInventoryTotalBytes: 9, protectedInventoryBytesTruncated: false, candidateCount: 9, reviewableCandidateCount: 0, bySeverity: { warn: 0, fail: 0 } }, findings: [], exclusions, reviewableCandidates: [], suggestedCommands: [] });

  // Then
  assert.equal(output.includes("protected-8"), true);
  assert.equal(output.includes("omitted: 1"), false);
});

test("guardian_goal readable output shows every protected root in the standard repository-sized inventory", () => {
  const rootsShown = Array.from({ length: 9 }, (_, index) => `protected-${index}`);
  const output = formatGuardianGoalOutput({ ok: true, status: "planned", complete: null, goal: {}, steps: [], blockers: [], hygienePostcondition: { mode: "no-unprotected-residue", phase: "plan", status: "satisfied", residualCount: 0, residualByCategory: {}, protectedExclusionCount: 9, reviewableCandidateCount: 0, reviewableInventoryComplete: true, protectedInventory: { rootCount: 9, rootsTruncated: false, rootsShown, rootsOmittedCount: 0, fileCount: 9, directoryCount: 0, totalBytes: 9, bytesTruncated: false } } });

  assert.equal(output.includes("protected-8"), true);
  assert.equal(output.includes("omitted: 1"), false);
});
