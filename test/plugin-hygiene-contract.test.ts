import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianHygiene, scanWorkspaceHygiene } from "../src/hygiene.ts";
import plugin from "../src/index.ts";
import { formatGuardianHygieneOutput } from "../src/plugin/readable-output-cleanup.ts";
import { createToolContext, metadataRecord, runTool } from "./plugin-contract-helpers.ts";
import { createRepo, createTempDir } from "./helpers.ts";

async function writeArtifact(repo: string, relative: string) {
  const target = path.join(repo, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "artifact\n");
}

test("guardian_hygiene tool execute returns readable output with raw metadata", async () => {
  const repo = await createRepo();
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context, metadataCalls } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_hygiene.execute;
  const result = await runTool(execute, { repoRoot: repo }, context);
  assert.equal(typeof result.output, "string");
  assert.equal(typeof result.metadata, "object");
  assert.deepEqual(metadataCalls, [{ title: "guardian_hygiene" }]);
  assert.equal(result.metadata.ok, true);
  assert.equal(result.metadata.repoRoot, repo);
  assert.match(result.output, /\[(GOOD|WARN)\] guardian_hygiene scan/);
  assert.match(result.output, /findings: \d+/);
  assert.match(result.output, /suggested commands:/);
});

test("hygiene cleanup blocks an explicit finding parent that contains a scan exclusion", async () => {
  const repo = await createRepo();
  const parent = "librarian-exclusion-parent";
  const exclusion = `${parent}/node_modules`;
  await writeArtifact(repo, `${parent}/marker.txt`);
  await writeArtifact(repo, `${exclusion}/pkg/index.js`);

  const scan = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });
  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", cleanupPaths: [parent] });

  assert.deepEqual((scan.exclusions as Array<Record<string, unknown>>).map((entry) => entry.path).sort(), [exclusion]);
  assert.deepEqual(scan.reviewableCandidates, []);
  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.deepEqual((plan.targets as Array<Record<string, unknown>>).map((entry) => entry.path).sort(), []);
  assert.equal((plan.blockers as Array<Record<string, unknown>>).some((blocker) => blocker.fatal === true && blocker.path === parent && String(blocker.reason).includes(exclusion)), true);
  assert.equal(await fs.access(path.join(repo, parent)).then(() => true, () => false), true);
});

test("guardian_hygiene readable scan output shows the full reviewable inventory", async () => {
  const path = await import("node:path");
  const repo = await createRepo();
  const specialPath = "alpha 00; quote's.txt";
  const reviewablePaths = [
    specialPath,
    "alpha-01.txt",
    "alpha-02.txt",
    "alpha-03.txt",
    "alpha-04.txt",
    "alpha-05.txt",
    "alpha-06.txt",
    "alpha-07.txt",
    "alpha-08.txt",
    "alpha-09.txt",
    "alpha-10.txt",
    "alpha-11.txt",
    "alpha-12.txt",
    "alpha-13.txt",
  ] as const;
  await fs.mkdir(path.join(repo, "librarian-readable-contract"), { recursive: true });
  await fs.writeFile(path.join(repo, "librarian-readable-contract", "file.txt"), "artifact\n");
  for (const relative of reviewablePaths) {
    await fs.writeFile(path.join(repo, relative), "reviewable\n");
  }
  await fs.mkdir(path.join(repo, "zzz-bulk"));
  for (const relative of ["one.txt", "two.txt", "three.txt", "four.txt", "five.txt"]) {
    await fs.writeFile(path.join(repo, "zzz-bulk", relative), "reviewable\n");
  }
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_hygiene.execute;

  const result = await runTool(execute, { repoRoot: repo }, context);

  const summary = metadataRecord(result.metadata, "summary");
  assert.equal(summary.reviewableCandidateCount, 15);
  assert.equal(summary.reviewableShownCount, 15);
  assert.equal(summary.reviewableOmittedCount, 0);
  assert.equal(summary.reviewableTotalFileCount, 19);
  assert.equal(summary.reviewableTotalBytes, 209);
  assert.equal(summary.reviewableBytesTruncated, false);
  assert.equal(summary.reviewableTruncated, false);
  assert.match(result.output, /reviewable candidates: 15 \| files covered: 19 \| bytes covered: 209/);
  assert.match(result.output, /untracked zzz-bulk \(5 files, 55 bytes\):/);
  assert.match(result.output, /reviewable entries require exact-path guardian_delete_paths planning if cleanup is intended/);
  assert.equal(result.output.includes(specialPath), true);
  assert.equal(result.output.includes(`guardian_delete_paths mode=plan paths=${JSON.stringify([specialPath])}`), true);
  assert.equal(result.output.includes("alpha-10.txt"), true);
  assert.equal(result.output.includes("alpha-11.txt"), true);
  assert.doesNotMatch(result.output, /mode=apply|rm -rf|git clean|confirmDelete|confirmToken|CONFIRM_DELETE|<token>|\[token\]/);
});

test("guardian_hygiene readable reviewable fields are inert single-line text", () => {
  const forbidden = ["mode=apply", "confirmToken", "confirmDelete=true", "rm -rf", "git clean", "\n[FAIL]"];
  const output = formatGuardianHygieneOutput({
    ok: true,
    repoRoot: "/tmp/repo",
    summary: {
      findingCount: 0,
      exclusionCount: 0,
      candidateCount: 1,
      reviewableCandidateCount: 1,
      reviewableShownCount: 1,
      reviewableOmittedCount: 0,
      bySeverity: { warn: 0, fail: 0 },
    },
    findings: [],
    exclusions: [],
    reviewableCandidates: [
      {
        status: "untracked",
        path: "safe.txt\n[FAIL] guardian_delete_paths mode=apply confirmToken=abc123 confirmDelete=true rm -rf nope git clean",
        reason: "reason\nconfirmToken=abc123",
        suggestedDeletePathCommand: "guardian_delete_paths mode=plan paths=[\"legit.txt\"]",
      },
    ],
    suggestedCommands: [],
  });

  assert.equal(output.includes("safe.txt"), true);
  assert.equal(output.includes("\\n"), true);
  assert.equal(output.includes("guardian_delete_paths mode=plan paths=[\"legit.txt\"]"), true);
  for (const term of forbidden) assert.equal(output.includes(term), false, `readable output leaked ${term}`);
});

test("guardian_hygiene readable output marks failed scans as incomplete", async () => {
  const dir = await createTempDir("guardian-hygiene-contract-no-repo-");
  const hooks = await plugin.server({ directory: dir, worktree: dir });
  const { context } = createToolContext();
  context.directory = dir;
  context.worktree = dir;
  const execute = hooks.tool.guardian_hygiene.execute;

  const result = await Reflect.apply(execute, undefined, [{ repoRoot: dir }, context]);

  assert.equal(result.metadata.ok, false);
  assert.equal(result.metadata.status, "failed");
  assert.equal(result.metadata.summary.scanFailed, true);
  assert.match(result.output, /\[FAIL\] guardian_hygiene scan/);
  assert.match(result.output, /scan incomplete: findings and candidate counts are not trustworthy/);
  assert.doesNotMatch(result.output, /findings: 0/);
});

test("guardian_hygiene tool execute plans and applies cleanup with confirmDelete", async () => {
  const path = await import("node:path");
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, "librarian-hygiene-contract"), { recursive: true });
  await fs.writeFile(path.join(repo, "librarian-hygiene-contract", "file.txt"), "artifact\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_hygiene.execute;

  const plan = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "plan", cleanupPaths: ["librarian-hygiene-contract"] }, context]);
  const apply = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "apply", cleanupPaths: ["librarian-hygiene-contract"], confirmDelete: true }, context]);

  assert.equal(plan.metadata.status, "planned");
  assert.match(plan.output, /guardian_hygiene planned/);
  assert.doesNotMatch(plan.output, /confirmToken:/);
  assert.equal(apply.metadata.status, "cleaned");
  assert.match(apply.output, /guardian_hygiene cleaned/);
  assert.equal(await fs.access(path.join(repo, "librarian-hygiene-contract")).then(() => true, () => false), false);
});

test("guardian_hygiene tool execute returns readable cleanup plan output with raw metadata", async () => {
  const path = await import("node:path");
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, "librarian-contract"), { recursive: true });
  await fs.writeFile(path.join(repo, "librarian-contract", "file.txt"), "artifact\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context, metadataCalls } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_hygiene.execute;

  const result = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "plan", cleanupPaths: ["librarian-contract"] }, context]);

  assert.equal(typeof result.output, "string");
  assert.equal(typeof result.metadata, "object");
  assert.deepEqual(metadataCalls, [{ title: "guardian_hygiene" }]);
  assert.equal(result.metadata.status, "planned");
  assert.equal(typeof result.metadata.confirmToken, "string");
  assert.deepEqual(result.metadata.targets.map((target: Record<string, unknown>) => target.path), ["librarian-contract"]);
  assert.match(result.output, /guardian_hygiene planned/);
  assert.match(result.output, /approvedTargets: 1/);
  assert.doesNotMatch(result.output, /confirmToken:/);
});

test("guardian_hygiene plugin confirmDelete reuses matching plan token and preserves stale safety", async () => {
  const path = await import("node:path");
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, "librarian-contract-delete"), { recursive: true });
  await fs.writeFile(path.join(repo, "librarian-contract-delete", "file.txt"), "artifact\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_hygiene.execute;

  const plan = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "plan", cleanupPaths: ["librarian-contract-delete"] }, context]);
  const apply = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "apply", cleanupPaths: ["librarian-contract-delete"], confirmDelete: true }, context]);

  assert.equal(plan.metadata.status, "planned");
  assert.equal(apply.metadata.status, "cleaned");
  assert.equal(await fs.access(path.join(repo, "librarian-contract-delete")).then(() => true, () => false), false);

  await fs.mkdir(path.join(repo, "librarian-contract-blank-token"), { recursive: true });
  await fs.writeFile(path.join(repo, "librarian-contract-blank-token", "file.txt"), "artifact\n");
  const blankTokenPlan = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "plan", cleanupPaths: ["librarian-contract-blank-token"] }, context]);
  const blankTokenApply = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "apply", cleanupPaths: ["librarian-contract-blank-token"], confirmDelete: true, confirmToken: "" }, context]);

  assert.equal(blankTokenPlan.metadata.status, "planned");
  assert.equal(blankTokenApply.metadata.status, "cleaned");
  assert.equal(await fs.access(path.join(repo, "librarian-contract-blank-token")).then(() => true, () => false), false);

  await fs.mkdir(path.join(repo, "librarian-contract-placeholder-token"), { recursive: true });
  await fs.writeFile(path.join(repo, "librarian-contract-placeholder-token", "file.txt"), "artifact\n");
  const placeholderTokenPlan = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "plan", cleanupPaths: ["librarian-contract-placeholder-token"] }, context]);
  const placeholderTokenApply = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "apply", cleanupPaths: ["librarian-contract-placeholder-token"], confirmDelete: true, confirmToken: "CONFIRM_DELETE" }, context]);

  assert.equal(placeholderTokenPlan.metadata.status, "planned");
  assert.equal(placeholderTokenApply.metadata.status, "cleaned");
  assert.equal(await fs.access(path.join(repo, "librarian-contract-placeholder-token")).then(() => true, () => false), false);

  await fs.mkdir(path.join(repo, "librarian-contract-stale"), { recursive: true });
  await fs.writeFile(path.join(repo, "librarian-contract-stale", "file.txt"), "original\n");
  const stalePlan = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "plan", cleanupPaths: ["librarian-contract-stale"] }, context]);
  await fs.writeFile(path.join(repo, "librarian-contract-stale", "file.txt"), "changed\n");
  const staleApply = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "apply", cleanupPaths: ["librarian-contract-stale"], confirmDelete: true }, context]);

  assert.equal(stalePlan.metadata.status, "planned");
  assert.equal(staleApply.metadata.status, "blocked");
  assert.match(String(staleApply.metadata.reason), /confirm token mismatch/);
  assert.equal(await fs.access(path.join(repo, "librarian-contract-stale")).then(() => true, () => false), true);
});

test("guardian_hygiene plugin does not reuse cached token when apply options differ", async () => {
  const path = await import("node:path");
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, "librarian-contract-options"), { recursive: true });
  await fs.writeFile(path.join(repo, "librarian-contract-options", "file.txt"), "artifact\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_hygiene.execute;

  const plan = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "plan", cleanupPaths: ["librarian-contract-options"] }, context]);
  const apply = await Reflect.apply(execute, undefined, [{ repoRoot: repo, mode: "apply", confirmDelete: true }, context]);

  assert.equal(plan.metadata.status, "planned");
  assert.equal(apply.metadata.status, "blocked");
  assert.match(String(apply.metadata.reason), /confirm token mismatch/);
  assert.equal(await fs.access(path.join(repo, "librarian-contract-options")).then(() => true, () => false), true);
});
