import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianGoal } from "../src/goal.ts";
import { guardianStart } from "../src/start.ts";
import type { GuardianConfig } from "../src/types.ts";
import { isRecordLike } from "../src/types.ts";
import { installFakeGh } from "./delete-fixtures.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

const STRICT_GOAL_CONFIG: GuardianConfig = {
  ...DEFAULT_CONFIG,
  goal: { ...DEFAULT_CONFIG.goal, hygieneCompletion: "no-unprotected-residue" },
};

function record(value: unknown, name: string): Record<string, unknown> {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

function text(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(`${name} must be a non-empty string`);
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecordLike) : [];
}

async function startFixture(t: TestContext, sessionId: string) {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({
    repoRoot: repo,
    cwd: repo,
    sessionId,
    taskName: "goal residue gate",
    createWorktree: true,
    config: STRICT_GOAL_CONFIG,
  });
  const session = record(started.session, "started.session");
  return {
    repo,
    sessionId,
    branch: text(session.branch, "session.branch"),
    worktree: text(session.worktree_path, "session.worktree_path"),
  };
}

async function exists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true, () => false);
}

test("guardian_goal scans the recorded session worktree before planning done", async (t) => {
  const fixture = await startFixture(t, "ses_goal_session_scan");
  await fs.mkdir(path.join(fixture.worktree, "node-compile-cache"), { recursive: true });
  await fs.writeFile(path.join(fixture.worktree, "node-compile-cache", "cache.bin"), "cache\n");
  await fs.mkdir(path.join(fixture.worktree, "screenshots"), { recursive: true });
  await fs.writeFile(path.join(fixture.worktree, "screenshots", "debug.png"), "debug\n");

  const plan = record(await guardianGoal({
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    sessionId: fixture.sessionId,
    mode: "plan",
    commitMessage: "feat: session residue gate",
    config: STRICT_GOAL_CONFIG,
  }), "goal plan");
  const hygiene = record(plan.hygienePostcondition, "hygiene postcondition");

  assert.equal(plan.cwd, fixture.worktree);
  assert.equal(plan.status, "planned-partial", JSON.stringify(plan));
  assert.equal(hygiene.status, "residual-unprotected");
  assert.equal(hygiene.reviewableCandidateCount, 1);
  assert.equal(hygiene.residualByCategory && record(hygiene.residualByCategory, "residual categories")["known-cleanable"], 0);
  const hygieneStep = records(plan.steps).find((step) => step.tool === "guardian_hygiene");
  const hygieneResult = record(hygieneStep?.result, "guardian_hygiene result");
  assert.equal(record(hygieneResult.summary, "guardian_hygiene summary").findingCount, 1);
});

test("guardian_goal removes known junk then blocks done while reviewable residue remains", async (t) => {
  const fixture = await startFixture(t, "ses_goal_precommit_gate");
  const cacheRoot = path.join(fixture.worktree, "node-compile-cache");
  const emptyScratchRoot = path.join(fixture.worktree, "scratch", "temporary", "empty");
  const reviewable = path.join(fixture.worktree, "screenshots", "debug.png");
  const intentional = path.join(fixture.worktree, "src", "new.ts");
  await fs.mkdir(cacheRoot, { recursive: true });
  await fs.writeFile(path.join(cacheRoot, "cache.bin"), "cache\n");
  await fs.mkdir(emptyScratchRoot, { recursive: true });
  await fs.mkdir(path.dirname(reviewable), { recursive: true });
  await fs.writeFile(reviewable, "debug\n");
  await fs.mkdir(path.dirname(intentional), { recursive: true });
  await fs.writeFile(intentional, "export const intended = true;\n");
  const remoteBefore = (await git(fixture.repo, ["rev-parse", "origin/main"])).stdout;

  const request = {
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    sessionId: fixture.sessionId,
    commitMessage: "feat: block residue before done",
    intentionalPaths: ["src/new.ts"],
    config: STRICT_GOAL_CONFIG,
  };
  const plan = record(await guardianGoal({ ...request, mode: "plan" }), "goal plan");
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const applied = record(await guardianGoal({
    ...request,
    mode: "apply",
    confirm: true,
    confirmToken: text(plan.confirmToken, "plan.confirmToken"),
  }), "goal apply");
  const doneStep = records(applied.steps).find((step) => step.tool === "guardian_done");

  assert.equal(await exists(cacheRoot), false);
  assert.equal(await exists(path.join(fixture.worktree, "scratch")), false);
  assert.equal(await exists(reviewable), true);
  assert.equal(await exists(intentional), true);
  assert.equal(doneStep?.status, "blocked");
  assert.match(String(doneStep?.reason), /unprotected residue/);
  assert.equal(applied.ok, false);
  assert.equal(applied.complete, false);
  assert.equal((await git(fixture.repo, ["rev-parse", "origin/main"])).stdout, remoteBefore);
});

test("guardian_goal blocks an invalid explicit session instead of scanning primary", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const artifact = path.join(repo, "primary-only.txt");
  await fs.writeFile(artifact, "do not touch\n");
  const before = (await git(repo, ["rev-parse", "origin/main"])).stdout;

  const plan = record(await guardianGoal({
    repoRoot: repo,
    cwd: repo,
    sessionId: "ses_missing_goal_target",
    mode: "plan",
    commitMessage: "feat: invalid target",
    config: STRICT_GOAL_CONFIG,
  }), "goal plan");

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.match(String(plan.reason), /session worktree binding/);
  assert.equal(await exists(artifact), true);
  assert.equal((await git(repo, ["rev-parse", "origin/main"])).stdout, before);
});

test("guardian_goal commits a new file only when intentionalPaths acknowledges it", async (t) => {
  const fixture = await startFixture(t, "ses_goal_intentional_path");
  const feature = "src/new-feature.ts";
  await fs.mkdir(path.join(fixture.worktree, "src"), { recursive: true });
  await fs.writeFile(path.join(fixture.worktree, feature), "export const feature = true;\n");
  await installFakeGh(t, { repo: fixture.repo, branch: fixture.branch, dynamicHead: true });
  const request = {
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    sessionId: fixture.sessionId,
    commitMessage: "feat: intentional new file",
    intentionalPaths: [feature],
    config: STRICT_GOAL_CONFIG,
  };

  const plan = record(await guardianGoal({ ...request, mode: "plan" }), "goal plan");
  assert.equal(plan.status, "planned");
  assert.deepEqual(plan.intentionalPaths, [feature]);
  const applied = record(await guardianGoal({
    ...request,
    mode: "apply",
    confirm: true,
    confirmToken: text(plan.confirmToken, "plan.confirmToken"),
  }), "goal apply");

  assert.equal(applied.complete, true, JSON.stringify(applied));
  const committed = (await git(fixture.repo, ["show", "origin/main:" + feature])).stdout;
  assert.match(committed, /feature = true/);
});

test("guardian_goal reports a staged artifact as tracked-added residue", async (t) => {
  const fixture = await startFixture(t, "ses_goal_staged_artifact");
  const artifact = "screenshots/staged-debug.png";
  await fs.mkdir(path.join(fixture.worktree, "screenshots"), { recursive: true });
  await fs.writeFile(path.join(fixture.worktree, artifact), "staged debug\n");
  await git(fixture.worktree, ["add", "--", artifact]);
  const remoteBefore = (await git(fixture.repo, ["rev-parse", "origin/main"])).stdout;

  const plan = record(await guardianGoal({
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    sessionId: fixture.sessionId,
    mode: "plan",
    commitMessage: "feat: staged artifact gate",
    config: STRICT_GOAL_CONFIG,
  }), "goal plan");
  const hygiene = record(plan.hygienePostcondition, "hygiene postcondition");
  const shown = records(hygiene.reviewableCandidatesShown);

  assert.equal(plan.status, "planned-partial", JSON.stringify(plan));
  assert.equal(hygiene.reviewableCandidateCount, 1);
  assert.equal(shown[0]?.path, artifact);
  assert.equal(shown[0]?.status, "tracked-added");
  const applied = record(await guardianGoal({
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    sessionId: fixture.sessionId,
    mode: "apply",
    confirm: true,
    confirmToken: text(plan.confirmToken, "plan.confirmToken"),
    commitMessage: "feat: staged artifact gate",
    config: STRICT_GOAL_CONFIG,
  }), "goal apply");
  const doneStep = records(applied.steps).find((step) => step.tool === "guardian_done");
  assert.equal(applied.complete, false);
  assert.equal(doneStep?.status, "blocked");
  assert.equal((await git(fixture.repo, ["rev-parse", "origin/main"])).stdout, remoteBefore);
});

test("guardian_goal reports a session-committed artifact as tracked-added residue", async (t) => {
  const fixture = await startFixture(t, "ses_goal_committed_artifact");
  const artifact = "screenshots/committed-debug.png";
  await fs.mkdir(path.join(fixture.worktree, "screenshots"), { recursive: true });
  await fs.writeFile(path.join(fixture.worktree, artifact), "committed debug\n");
  await git(fixture.worktree, ["add", "--", artifact]);
  await git(fixture.worktree, ["commit", "-m", "test: commit temporary artifact"]);
  const remoteBefore = (await git(fixture.repo, ["rev-parse", "origin/main"])).stdout;

  const plan = record(await guardianGoal({
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    sessionId: fixture.sessionId,
    mode: "plan",
    commitMessage: "feat: committed artifact gate",
    config: STRICT_GOAL_CONFIG,
  }), "goal plan");
  const hygiene = record(plan.hygienePostcondition, "hygiene postcondition");
  const shown = records(hygiene.reviewableCandidatesShown);

  assert.equal(plan.status, "planned-partial", JSON.stringify(plan));
  assert.equal(hygiene.reviewableCandidateCount, 1);
  assert.equal(shown[0]?.path, artifact);
  assert.equal(shown[0]?.status, "tracked-added");
  assert.equal((await git(fixture.repo, ["rev-parse", "origin/main"])).stdout, remoteBefore);
});
