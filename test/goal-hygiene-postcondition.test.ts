import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { runGitNullSeparated } from "../src/git.ts";
import { guardianGoal } from "../src/goal.ts";
import { compareCodeUnits } from "../src/goal-hygiene-postcondition.ts";
import { formatGuardianGoalOutput } from "../src/plugin/readable-output-goal.ts";
import type { GuardianConfig } from "../src/types.ts";
import { createRepoWithOrigin } from "./helpers.ts";

function strictHygieneGoalConfig(): GuardianConfig {
  return {
    ...DEFAULT_CONFIG,
    goal: {
      ...DEFAULT_CONFIG.goal,
      commitDirty: false,
      landToBase: false,
      pushBase: false,
      cleanupWorktrees: false,
      cleanupBranches: false,
      cleanupHygiene: true,
      hygieneCompletion: "no-unprotected-findings",
    },
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return Object.fromEntries(Object.entries(value));
  throw new TypeError(`${name} must be an object`);
}

function stringValue(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(`${name} must be a non-empty string`);
}

function largestArrayLength(value: unknown): number {
  if (Array.isArray(value)) return Math.max(value.length, ...value.map(largestArrayLength));
  if (value !== null && typeof value === "object") return Math.max(0, ...Object.values(value).map(largestArrayLength));
  return 0;
}

function hygieneStepResult(result: Record<string, unknown>): Record<string, unknown> {
  const steps = Array.isArray(result.steps) ? result.steps.map((entry) => record(entry, "goal step")) : [];
  return record(steps.find((step) => step.tool === "guardian_hygiene")?.result, "guardian_hygiene step result");
}

test("guardian_goal blocks and withholds confirmation when its forecast scan fails after hygiene planning", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, "node-compile-cache"));
  await fs.writeFile(path.join(repo, "node-compile-cache", "cache.bin"), "cache\n");
  let untrackedScans = 0;
  const runGitNullSeparatedAfterForecast = async (repoPath: string, args: readonly string[]): Promise<string[]> => {
    if (args.join("\0") === ["ls-files", "--others", "--exclude-standard", "-z"].join("\0")) {
      untrackedScans += 1;
      if (untrackedScans === 2) throw new Error("forecast scanner unavailable");
    }
    return runGitNullSeparated(repoPath, args);
  };

  const result = record(await guardianGoal({
    repoRoot: repo,
    cwd: repo,
    mode: "plan",
    config: strictHygieneGoalConfig(),
    runGitNullSeparated: runGitNullSeparatedAfterForecast,
  }), "goal plan");

  assert.equal(untrackedScans, 2);
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.complete, null);
  assert.equal(result.confirmToken, undefined);
  assert.equal(record(result.hygienePostcondition, "hygiene postcondition").status, "scan-failed");
  const blockers = Array.isArray(result.blockers) ? result.blockers.map((entry) => record(entry, "blocker")) : [];
  assert.equal(blockers.some((blocker) => blocker.tool === "guardian_goal" && /postcondition scan failed/.test(String(blocker.reason))), true);
});

test("guardian_goal bounds residual metadata and token-binds omitted residual identities", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  for (const index of Array.from({ length: 701 }, (_, value) => value)) {
    const residue = path.join(repo, `guardian-residual-${String(index).padStart(3, "0")}`);
    await fs.mkdir(residue);
    await fs.writeFile(path.join(residue, "artifact.txt"), "residue\n");
  }
  const config = strictHygieneGoalConfig();

  const first = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config }), "first plan");
  const firstPostcondition = record(first.hygienePostcondition, "first hygiene postcondition");
  const firstHygiene = hygieneStepResult(first);
  await fs.rename(path.join(repo, "guardian-residual-700"), path.join(repo, "guardian-residual-changed"));
  const second = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config }), "second plan");
  const secondPostcondition = record(second.hygienePostcondition, "second hygiene postcondition");

  assert.equal(first.status, "planned-partial");
  assert.equal(firstPostcondition.residualCount, 701);
  assert.equal(record(firstPostcondition.residualByCategory, "residual categories").suspicious, 701);
  assert.equal(Array.isArray(firstPostcondition.residualFindings), false);
  assert.equal(Array.isArray(firstPostcondition.residualFindingsShown), true);
  assert.equal(Array.isArray(firstPostcondition.residualFindingsShown) ? firstPostcondition.residualFindingsShown.length : 0, 8);
  assert.equal(firstPostcondition.residualFindingsOmittedCount, 693);
  assert.equal(firstPostcondition.residualFindingsTruncated, true);
  assert.match(stringValue(firstPostcondition.residualDigest, "residual digest"), /^[0-9a-f]{64}$/);
  assert.equal(largestArrayLength(firstHygiene) <= 8, true);
  assert.equal(JSON.stringify(first).length <= 20_000, true);
  assert.equal(firstHygiene.blockersTotal, 701);
  assert.equal(firstHygiene.blockersOmittedCount, 693);
  assert.equal(record(firstHygiene.preflight, "hygiene preflight").blockersTotal, 701);
  assert.match(stringValue(firstHygiene.digest, "hygiene result digest"), /^[0-9a-f]{64}$/);
  assert.notEqual(first.confirmToken, second.confirmToken);
  assert.notEqual(firstHygiene.digest, hygieneStepResult(second).digest);
  assert.notEqual(firstPostcondition.residualDigest, secondPostcondition.residualDigest);
});

test("guardian_goal residual digest uses code-unit ordering regardless of discovery order", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const config = strictHygieneGoalConfig();
  const paths = ["guardian-residual-z", "guardian-residual-ä"];
  for (const relative of paths) {
    await fs.mkdir(path.join(repo, relative));
    await fs.writeFile(path.join(repo, relative, "artifact.txt"), "residue\n");
  }
  const first = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config }), "first plan");
  await fs.rename(path.join(repo, paths[0]), path.join(repo, "guardian-residual-temp"));
  await fs.rename(path.join(repo, paths[1]), path.join(repo, paths[0]));
  await fs.rename(path.join(repo, "guardian-residual-temp"), path.join(repo, paths[1]));
  const second = record(await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config }), "second plan");

  assert.equal(compareCodeUnits("ä", "z") > 0, true);
  assert.equal(record(first.hygienePostcondition, "first postcondition").residualDigest, record(second.hygienePostcondition, "second postcondition").residualDigest);
});

test("guardian_goal readable output sanitizes hostile residual paths and reasons", () => {
  const hostileTerminalText = [
    "\u001b[31mCSI\u001b[0m",
    "\u001b]8;;https://example.invalid\u001b\\link\u001b]8;;\u001b\\",
    "\u001b]52;c;clipboard\u0007",
    "\u009b31mC1-CSI\u009b0m",
    "\u009d8;;https://example.invalid\u009cC1-OSC\u009d8;;\u009c",
    "\u0000\u0001\u0008\u000b\u000c\u000e\u001f\u007f\u0080",
    "\u200e\u200f\u061c\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069",
  ].join(" ");
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
      residualCount: 1,
      residualByCategory: { "known-cleanable": 0, "nested-git": 1, suspicious: 0 },
      residualFindingCount: 1,
      residualFindingsShown: [{
        category: "nested-git",
        path: `nested\nconfirmToken=secret mode=apply rm -rf unsafe ${hostileTerminalText}`,
        reason: `reason\nconfirmDelete=true git clean ${hostileTerminalText}`,
      }],
      residualFindingsOmittedCount: 0,
      residualFindingsTruncated: false,
      protectedExclusionCount: 0,
      reviewableCandidateCount: 0,
    },
  });

  assert.match(output, /confirmation=<redacted>/);
  assert.match(output, /\\u200E.*\\u202E.*\\u2069/);
  assert.doesNotMatch(output, /secret|mode=apply|confirmDelete=true|rm -rf|git clean|example\.invalid|clipboard/);
  assert.doesNotMatch(output.replaceAll("\n", ""), /[\u0000-\u001f\u007f-\u009f\u001b\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/);
});
