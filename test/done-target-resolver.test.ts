import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { buildDoneWorkInventory } from "../src/done-work-inventory.ts";
import { resolveDoneTarget } from "../src/done-target-resolver.ts";
import { guardianStart } from "../src/start.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepoWithOrigin, git, rescueMutationSurface } from "./helpers.ts";
import { installFakeGh } from "./delete-fixtures.ts";

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(`${name} must be a non-empty string`);
}

type SessionFixtureOptions = {
  readonly t: TestContext;
  readonly sessionId: string;
  readonly taskName: string;
  readonly beforeStart?: (repo: string) => Promise<void>;
};

async function createSessionFixture(options: SessionFixtureOptions) {
  const { base, repo } = await createRepoWithOrigin();
  options.t.after(() => fs.rm(base, { recursive: true, force: true }));
  if (options.beforeStart) await options.beforeStart(repo);
  const started = requireRecord(await guardianStart({
    repoRoot: repo,
    cwd: repo,
    sessionId: options.sessionId,
    taskName: options.taskName,
    createWorktree: true,
    config: DEFAULT_CONFIG,
  }), "started");
  const session = requireRecord(started.session, "started.session");
  return {
    repo,
    worktree: requireString(session.worktree_path, "started.session.worktree_path"),
    branch: requireString(session.branch, "started.session.branch"),
  };
}

async function trackIgnoredStats(repo: string, commitMessage: string): Promise<void> {
  const trackedPath = ".claude/stats/commits.json";
  const trackedFile = path.join(repo, trackedPath);
  await fs.mkdir(path.dirname(trackedFile), { recursive: true });
  await fs.writeFile(trackedFile, "{\"commits\":[]}\n", "utf8");
  await git(repo, ["add", trackedPath]);
  await git(repo, ["commit", "-m", commitMessage]);
  await fs.writeFile(path.join(repo, ".gitignore"), ".claude/\n", "utf8");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore runtime state"]);
  await git(repo, ["push", "origin", "main"]);
}

test("guardian_done target resolver honors explicit session and branch from primary cwd", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_resolve_explicit", taskName: "resolve explicit", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(repo, "primary-dirty.txt"), "primary stays out of this decision\n", "utf8");
  await fs.writeFile(path.join(started.session.worktree_path, "session-dirty.txt"), "session\n", "utf8");
  const inventory = await buildDoneWorkInventory({ repoRoot: repo, cwd: repo, config: DEFAULT_CONFIG });

  const bySession = resolveDoneTarget({ input: { sessionId: "ses_resolve_explicit" }, inventory });
  const byBranch = resolveDoneTarget({ input: { branch: started.session.branch }, inventory });

  assert.equal(bySession.kind, "session-finish");
  assert.equal(bySession.sessionId, "ses_resolve_explicit");
  assert.equal(byBranch.kind, "session-finish");
  assert.equal(byBranch.sessionId, "ses_resolve_explicit");
});

test("guardian_done target resolver blocks missing explicit sessionId from primary cwd", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_resolve_real", taskName: "resolve real", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(started.session.worktree_path, "session-dirty.txt"), "session\n", "utf8");
  const inventory = await buildDoneWorkInventory({ repoRoot: repo, cwd: repo, config: DEFAULT_CONFIG });

  const missing = resolveDoneTarget({ input: { sessionId: "ses_missing" }, inventory });

  assert.equal(missing.kind, "blocked");
  assert.equal(missing.lane, "session-not-found");
  assert.equal(missing.sessionId, "ses_missing");
  assert.ok(missing.suggestedCommands?.includes(`guardian_done branch=${started.session.branch}`));
});

test("guardian_done target resolver auto-selects one dirty target and blocks ambiguous dirt", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const session = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_resolve_dirty", taskName: "resolve dirty", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(session.session.worktree_path, "session-dirty.txt"), "session\n", "utf8");
  const onlySessionDirty = await buildDoneWorkInventory({ repoRoot: repo, cwd: repo, config: DEFAULT_CONFIG });

  const selectedSession = resolveDoneTarget({ input: {}, inventory: onlySessionDirty });
  assert.equal(selectedSession.kind, "session-finish");
  assert.equal(selectedSession.sessionId, "ses_resolve_dirty");

  await fs.writeFile(path.join(repo, "primary-dirty.txt"), "primary\n", "utf8");
  const ambiguousInventory = await buildDoneWorkInventory({ repoRoot: repo, cwd: repo, config: DEFAULT_CONFIG });
  const ambiguous = resolveDoneTarget({ input: {}, inventory: ambiguousInventory });

  assert.equal(ambiguous.kind, "needs-selection");
  assert.equal(ambiguous.status, "needs-selection");
  assert.match(ambiguous.reason, /multiple dirty implementation targets/);
  assert.deepEqual(ambiguous.candidates.map((candidate) => candidate.targetKind).sort(), ["primary", "session"]);
  assert.ok(ambiguous.suggestedCommands.includes("guardian_done primary=true commitMessage=..."));
  assert.ok(ambiguous.suggestedCommands.includes(`guardian_done branch=${session.session.branch} commitMessage=...`));
});

test("guardian_done target resolver keeps clean primary cleanup and done-all behavior", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_resolve_clean", taskName: "resolve clean", createWorktree: true, config: DEFAULT_CONFIG });
  const withCleanSession = await buildDoneWorkInventory({ repoRoot: repo, cwd: repo, config: DEFAULT_CONFIG });
  const doneAll = resolveDoneTarget({ input: {}, inventory: withCleanSession });
  assert.equal(doneAll.kind, "done-all");

  const { base: cleanBase, repo: cleanRepo } = await createRepoWithOrigin();
  t.after(() => fs.rm(cleanBase, { recursive: true, force: true }));
  const cleanInventory = await buildDoneWorkInventory({ repoRoot: cleanRepo, cwd: cleanRepo, config: DEFAULT_CONFIG });
  const cleanupOnly = resolveDoneTarget({ input: {}, inventory: cleanInventory });
  assert.equal(cleanupOnly.kind, "cleanup-only");
});

test("guardian_done blocks allowIgnoredFiles added after a clean session land plan", async (t) => {
  const sessionId = "land-clean-changed-ignored-consent"; const { repo, worktree, branch } = await createSessionFixture({ t, sessionId, taskName: "changed ignored consent" });
  await fs.writeFile(path.join(worktree, "feature.txt"), "feature\n", "utf8"); const fakeGh = await installFakeGh(t, { repo, branch, dynamicHead: true }); const remoteMainBefore = (await git(repo, ["rev-parse", "origin/main"])).stdout;
  const plan = requireRecord(await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "plan", commitMessage: "feat: add clean session file", config: DEFAULT_CONFIG }), "plan");
  const result = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken"), allowIgnoredFiles: true, commitMessage: "feat: add clean session file", config: DEFAULT_CONFIG });
  assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.status, "blocked"); assert.match(requireString(result.reason, "result.reason"), /plan changed/);
  assert.equal(await fs.access(worktree).then(() => true, () => false), true); await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]); assert.equal((await git(repo, ["rev-parse", "origin/main"])).stdout, remoteMainBefore); assert.equal(await fs.access(fakeGh.logPath).then(() => true, () => false), false);
});

test("rescueMutationSurface observes linked worktree index-only mutation", async (t) => {
  // Given
  const sessionId = "rescue-mutation-linked-index";
  const { repo, worktree } = await createSessionFixture({ t, sessionId, taskName: sessionId });
  const primaryBefore = await rescueMutationSurface(repo);
  const linkedBefore = await rescueMutationSurface(repo, worktree);
  const blob = (await git(worktree, ["rev-parse", "HEAD:README.md"])).stdout;

  // When
  await git(worktree, ["update-index", "--add", "--cacheinfo", `100644,${blob},linked-index-only.txt`]);
  const primaryAfter = await rescueMutationSurface(repo);
  const linkedAfter = await rescueMutationSurface(repo, worktree);

  // Then
  assert.deepEqual(primaryAfter, primaryBefore);
  const { index: linkedBeforeIndex, status: linkedBeforeStatus, ...linkedBeforeRest } = linkedBefore;
  const { index: linkedAfterIndex, status: linkedAfterStatus, ...linkedAfterRest } = linkedAfter;
  assert.notDeepEqual(linkedAfterIndex, linkedBeforeIndex);
  assert.notEqual(linkedAfterStatus, linkedBeforeStatus);
  assert.deepEqual(linkedAfterRest, linkedBeforeRest);
});

test("guardian_done stale ordinary-untracked token leaves the complete mutation surface unchanged", async (t) => {
  // Given
  const sessionId = "land-clean-stale-ordinary-untracked";
  const { repo, worktree, branch } = await createSessionFixture({ t, sessionId, taskName: sessionId });
  const ordinaryPath = path.join(worktree, "ordinary.txt");
  await fs.writeFile(ordinaryPath, "planned\n", "utf8");
  const fakeGh = await installFakeGh(t, { repo, branch, dynamicHead: true });
  const request = { repoRoot: repo, cwd: worktree, sessionId, commitMessage: "feat: land ordinary file", config: DEFAULT_CONFIG };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");
  await fs.writeFile(ordinaryPath, "drifted\n", "utf8");
  const before = await rescueMutationSurface(repo, worktree);

  // When
  const stale = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });

  // Then
  assert.equal(stale.ok, false, JSON.stringify(stale));
  assert.equal(stale.status, "blocked");
  assert.match(requireString(stale.reason, "stale.reason"), /plan changed/);
  assert.deepEqual(await rescueMutationSurface(repo, worktree), before);
  assert.equal(await fs.access(fakeGh.logPath).then(() => true, () => false), false);

  const freshPlan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "freshPlan");
  const fresh = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(freshPlan.confirmToken, "freshPlan.confirmToken") });
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
  assert.equal((await git(repo, ["show", "origin/main:ordinary.txt"])).stdout, "drifted");
});

test("guardian_done lands an indexed removal when ignored-file consent matches its plan", async (t) => {
  // Given
  const sessionId = "land-clean-matching-ignored-consent";
  const trackedPath = ".claude/stats/commits.json";
  const { repo, worktree, branch } = await createSessionFixture({
    t,
    sessionId,
    taskName: "matching ignored consent",
    beforeStart: (repoRoot) => trackIgnoredStats(repoRoot, "track matching ignored fixture"),
  });
  await git(worktree, ["rm", "--cached", "--", trackedPath]);
  await installFakeGh(t, { repo, branch, dynamicHead: true });
  const request = {
    repoRoot: repo,
    cwd: worktree,
    sessionId,
    allowIgnoredFiles: true,
    commitMessage: "fix: remove ignored stats from index",
    config: DEFAULT_CONFIG,
  };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");

  // When
  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });

  // Then
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "landed-and-cleaned");
  const commit = requireString(result.commit, "result.commit");
  await git(repo, ["fetch", "origin", "main"]);
  await git(repo, ["merge-base", "--is-ancestor", commit, "origin/main"]);
  await assert.rejects(git(repo, ["cat-file", "-e", `${commit}:${trackedPath}`]));
  assert.equal(result.worktreeRemoved, true);
  assert.equal(result.branchDeleted, true);
  await assert.rejects(fs.access(worktree));
  await assert.rejects(git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]));
});

for (const change of ["added", "modified"] as const) {
  test(`guardian_done blocks ${change} ignored cleanup inventory drift after plan`, async (t) => {
      // Given
      const sessionId = `land-clean-ignored-${change}`;
      const { repo, worktree, branch } = await createSessionFixture({
        t,
        sessionId,
        taskName: `ignored ${change}`,
        beforeStart: async (repoRoot) => {
          await fs.writeFile(path.join(repoRoot, ".gitignore"), ".claude/\n", "utf8");
          await git(repoRoot, ["add", ".gitignore"]);
          await git(repoRoot, ["commit", "-m", "ignore runtime state"]);
          await git(repoRoot, ["push", "origin", "main"]);
        },
      });
      await fs.writeFile(path.join(worktree, "feature.txt"), "feature\n", "utf8");
      await git(worktree, ["add", "feature.txt"]);
      await git(worktree, ["commit", "-m", "add ignored inventory fixture"]);
      await fs.mkdir(path.join(worktree, ".claude"), { recursive: true });
      const ignoredFile = path.join(worktree, ".claude", "session.log");
      await fs.writeFile(ignoredFile, "planned\n", "utf8");
      const fakeGh = await installFakeGh(t, { repo, branch, dynamicHead: true });
      const request = { repoRoot: repo, cwd: worktree, sessionId, allowIgnoredFiles: true, config: DEFAULT_CONFIG };
      const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");

      // When
      await fs.writeFile(change === "added" ? path.join(worktree, ".claude", "added.log") : ignoredFile, "changed\n", "utf8");
      const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });

      // Then
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.status, "blocked");
      assert.match(requireString(result.reason, "result.reason"), /plan changed/);
      await fs.access(worktree);
      await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
      assert.equal(await fs.access(fakeGh.logPath).then(() => true, () => false), false);
  });
}

test("guardian_done atomically blocks a ref changed after matching reservation validation", async (t) => {
  const sessionId = "reservation-ref-race";
  const { repo, worktree, branch } = await createSessionFixture({ t, sessionId, taskName: sessionId });
  await fs.writeFile(path.join(worktree, "feature.txt"), "feature\n", "utf8");
  await installFakeGh(t, { repo, branch, dynamicHead: true });
  const request = { repoRoot: repo, cwd: worktree, sessionId, commitMessage: "feat: reserve safety ref", timestamp: "2026-07-29T04:45:00.000Z", config: DEFAULT_CONFIG };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");
  const first = await guardianDone(
    { ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") },
    { commitTransactionHooks: { afterSafetyRefCreated: async () => { throw new Error("preserve reservation"); } } },
  );
  assert.equal(first.ok, false, JSON.stringify(first));
  const retryPlan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "retryPlan");
  const expectedHead = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  const otherHead = (await git(repo, ["commit-tree", `${expectedHead}^{tree}`, "-p", expectedHead, "-m", "racing reservation target"])).stdout;

  const result = await guardianDone(
    { ...request, mode: "apply", confirm: true, confirmToken: requireString(retryPlan.confirmToken, "retryPlan.confirmToken") },
    { commitTransactionHooks: { beforeBranchPublication: async () => { await git(repo, ["update-ref", requireString(retryPlan.safetyRef, "retryPlan.safetyRef"), otherHead]); } } },
  );

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.equal((await git(repo, ["rev-parse", requireString(retryPlan.safetyRef, "retryPlan.safetyRef")])).stdout, otherHead);
  assert.equal((await git(worktree, ["rev-parse", "HEAD"])).stdout, expectedHead);
});
