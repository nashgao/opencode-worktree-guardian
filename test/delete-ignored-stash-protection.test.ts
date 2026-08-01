import {
  assert,
  branchExists,
  createGuardianWorktree,
  createRepoWithOrigin,
  DEFAULT_CONFIG,
  deleteWorktree,
  fs,
  git,
  guardianStart,
  guardianStatus,
  path,
  test,
  worktreePaths,
} from "./delete-fixtures.js";
import { guardianHygiene } from "../src/hygiene.ts";
import { getGuardianPaths, readState, writeStateAtomic } from "../src/state.ts";
import { createRepo } from "./helpers.ts";

async function pathExists(candidate: string) { return fs.access(candidate).then(() => true, () => false); }

async function createDirtyNestedRepository(repo: string, relative: string) {
  const nested = path.join(repo, relative);
  await fs.mkdir(nested, { recursive: true });
  await git(nested, ["init", "-b", "main"]);
  await git(nested, ["config", "user.email", "guardian@example.test"]);
  await git(nested, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(nested, "README.md"), "nested\n");
  await git(nested, ["add", "README.md"]);
  await git(nested, ["commit", "-m", "nested initial"]);
  await fs.writeFile(path.join(nested, "dirty.txt"), "dirty\n"); return nested;
}

test("ignored target worktree files are reported and blocked before safety refs", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_delete_ignored");
  await fs.writeFile(path.join(start.session.worktree_path, ".gitignore"), "ignored-output/\n");
  await git(start.session.worktree_path, ["add", ".gitignore"]);
  await git(start.session.worktree_path, ["commit", "-m", "ignore generated output"]);
  const ignoredDir = path.join(start.session.worktree_path, "ignored-output");
  await fs.mkdir(ignoredDir, { recursive: true });
  await fs.writeFile(path.join(ignoredDir, "artifact.log"), "generated\n");

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_delete_ignored", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /ignored files/);
  assert.equal(result.preflight.dirtyFileCount, 0);
  assert.equal(result.preflight.ignoredFileCount, 1);
  assert.deepEqual(result.preflight.ignoredFiles, ["ignored-output/artifact.log"]);
  assert.equal(result.report.ignoredFileCount, 1);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG })).safetyRefs.length, 0);
});

test("allowIgnoredFiles permits explicit deletion of ignored-only target files", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_delete_allow_ignored", "delete ignored", "guardian/delete-ignored");
  await fs.writeFile(path.join(start.session.worktree_path, ".gitignore"), ".claude/\ndata/\n");
  await git(start.session.worktree_path, ["add", ".gitignore"]);
  await git(start.session.worktree_path, ["commit", "-m", "ignore local artifacts"]);
  await fs.mkdir(path.join(start.session.worktree_path, ".claude"), { recursive: true });
  await fs.mkdir(path.join(start.session.worktree_path, "data"), { recursive: true });
  await fs.writeFile(path.join(start.session.worktree_path, ".claude", "settings.json"), "{}\n");
  await fs.writeFile(path.join(start.session.worktree_path, "data", "cache.db"), "cache\n");

  const blocked = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_delete_allow_ignored", config: DEFAULT_CONFIG });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /ignored files/);

  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_delete_allow_ignored", deleteBranch: false, allowIgnoredFiles: true, config: DEFAULT_CONFIG, timestamp: "20260601T150000" });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.preflight.allowIgnoredFiles, true);
  assert.deepEqual(plan.preflight.ignoredFiles, [".claude/settings.json", "data/cache.db"]);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId: "ses_delete_allow_ignored", deleteBranch: false, allowIgnoredFiles: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T150000" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "deleted");
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), false);
  assert.equal(await branchExists(repo, "guardian/delete-ignored"), true);
  assert.match(result.safetyRef, /^refs\/opencode-guardian\/ses_delete_allow_ignored\/guardian\/delete-ignored\//);
});

test("hygiene cleanup blocks a default approved parent containing a dirty nested Git finding", async () => {
  const repo = await createRepo();
  const parent = "librarian-dirty-parent";
  await fs.mkdir(path.join(repo, parent), { recursive: true });
  await fs.writeFile(path.join(repo, parent, "marker.txt"), "artifact\n");
  const nested = await createDirtyNestedRepository(repo, `${parent}/research-clone`);

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan" });

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.deepEqual((plan.targets as Array<Record<string, unknown>>).map((target) => target.path).sort(), []);
  assert.equal((plan.blockers as Array<Record<string, unknown>>).some((blocker) => blocker.fatal === true && blocker.path === parent && blocker.category === "nested-git" && /dirty nested Git/.test(String(blocker.reason))), true);
  assert.equal(await pathExists(path.join(repo, parent)), true);
  assert.equal(await pathExists(nested), true);
});

for (const drift of ["added", "modified", "symlink"] as const) {
  test(`direct deletion blocks ${drift} ignored drift after safety-ref creation`, async (t) => {
    const { base, repo } = await createRepoWithOrigin();
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const sessionId = `ses_delete_late_${drift}`;
    const start = await createGuardianWorktree(repo, sessionId, `late ${drift}`, `guardian/delete-late-${drift}`);
    const worktree = start.session.worktree_path;
    await fs.writeFile(path.join(worktree, ".gitignore"), ".claude/\n");
    await fs.writeFile(path.join(worktree, "target-a.txt"), "a\n");
    await fs.writeFile(path.join(worktree, "target-b.txt"), "b\n");
    await git(worktree, ["add", ".gitignore", "target-a.txt", "target-b.txt"]);
    await git(worktree, ["commit", "-m", "prepare ignored drift"]);
    await fs.mkdir(path.join(worktree, ".claude"), { recursive: true });
    const ignoredPath = path.join(worktree, ".claude", drift === "symlink" ? "current" : "state.log");
    if (drift === "symlink") await fs.symlink("../target-a.txt", ignoredPath);
    else await fs.writeFile(ignoredPath, "planned\n");
    const timestamp = `20260727T03${drift.length}00`;
    const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, deleteBranch: false, allowIgnoredFiles: true, timestamp, config: DEFAULT_CONFIG });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId, deleteBranch: false, allowIgnoredFiles: true, confirmToken: plan.confirmToken, timestamp, config: DEFAULT_CONFIG }, {
      afterSafetyRefCreated: async () => {
        if (drift === "added") await fs.writeFile(path.join(worktree, ".claude", "late.log"), "late\n");
        else if (drift === "modified") await fs.writeFile(ignoredPath, "changed\n");
        else {
          await fs.rm(ignoredPath);
          await fs.symlink("../target-b.txt", ignoredPath);
        }
      },
    });

    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(String(result.reason), /ignored-file consent changed/);
    assert.equal((await worktreePaths(repo)).includes(worktree), true);
    await git(repo, ["rev-parse", "--verify", String(plan.preflight.safetyRef)]);
    const guardianPaths = await getGuardianPaths(repo);
    const blockedState = await readState(guardianPaths, { repoRoot: repo, config: DEFAULT_CONFIG });
    const blockedSession = blockedState.sessions[sessionId];
    assert.ok(blockedSession);
    await writeStateAtomic(guardianPaths, {
      ...blockedState,
      sessions: {
        ...blockedState.sessions,
        [sessionId]: {
          ...blockedSession,
          safety_refs: [...(blockedSession.safety_refs ?? []), String(plan.preflight.safetyRef)],
        },
      },
    });
    if (drift === "added") await fs.rm(path.join(worktree, ".claude", "late.log"));
    else if (drift === "modified") await fs.writeFile(ignoredPath, "planned\n");
    else {
      await fs.rm(ignoredPath);
      await fs.symlink("../target-a.txt", ignoredPath);
    }
    const retryPlan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, deleteBranch: false, allowIgnoredFiles: true, timestamp, config: DEFAULT_CONFIG });
    const retry = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId, deleteBranch: false, allowIgnoredFiles: true, confirmToken: retryPlan.confirmToken, timestamp, config: DEFAULT_CONFIG });

    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal(retry.safetyRef, plan.preflight.safetyRef);
    assert.equal((await worktreePaths(repo)).includes(worktree), false);
    const finalState = await readState(guardianPaths, { repoRoot: repo, config: DEFAULT_CONFIG });
    const safetyRefs = finalState.sessions[sessionId]?.safety_refs ?? [];
    assert.equal(safetyRefs.filter((ref) => ref === retry.safetyRef).length, 1);
  });
}

test("apply tolerates empty timestamp without creating a trailing-slash safety ref", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "ses_15a6a9af2ffef5mXFgNq3s3zPm";
  const start = await createGuardianWorktree(repo, sessionId, "delete empty timestamp", "guardian/session-ses-15a6");

  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, config: DEFAULT_CONFIG });
  assert.equal(plan.ok, true);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "deleted");
  assert.equal(result.worktreeRemoved, true);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), false);
  assert.doesNotMatch(result.safetyRef ?? "", /\/$/);
  await git(repo, ["check-ref-format", String(result.safetyRef)]);
});

test("apply rejects a nonempty timestamp when the plan omitted one", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "ses_delete_timestamp_drift";
  const start = await createGuardianWorktree(repo, sessionId, "delete timestamp drift", "guardian/timestamp-drift");
  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, config: DEFAULT_CONFIG });
  assert.equal(plan.ok, true);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId, confirmToken: plan.confirmToken, timestamp: "20260727T083030", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(String(result.reason), /confirm token/i);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
});

test("branch-only deletion rejects timestamp drift and safety-ref collisions", async (t) => {
  for (const scenario of ["timestamp", "collision"] as const) {
    await t.test(scenario, async () => {
      const { base, repo } = await createRepoWithOrigin();
      t.after(() => fs.rm(base, { recursive: true, force: true }));
      const branch = `feature/delete-${scenario}-guard`;
      await git(repo, ["branch", branch, "main"]);
      const head = (await git(repo, ["rev-parse", branch])).stdout;
      const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", branch, deleteBranch: true, timestamp: "20260727T080808", config: DEFAULT_CONFIG });
      const safetyRef = String(plan.preflight.safetyRef);
      if (scenario === "collision") await git(repo, ["update-ref", safetyRef, head]);
      const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", branch, deleteBranch: true, confirmToken: plan.confirmToken, timestamp: scenario === "timestamp" ? "20260727T090909" : "20260727T080808", config: DEFAULT_CONFIG });
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(await branchExists(repo, branch), true);
      if (scenario === "collision") assert.equal((await git(repo, ["rev-parse", safetyRef])).stdout, head);
    });
  }
});

test("stash inventory is advisory during deletion planning by default", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_delete_stash");
  await fs.writeFile(path.join(repo, "stashed.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "delete test stash"]);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_delete_stash", config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.equal(result.status, "planned");
  assert.equal(typeof result.confirmToken, "string");
  assert.equal(result.preflight.stashCount, 1);
  assert.equal(Array.isArray(result.preflight.stashes) ? result.preflight.stashes.length : 0, 1);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG })).safetyRefs.length, 0);
});

test("strict stash inventory policy blocks deletion before safety refs", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_delete_stash_strict");
  await fs.writeFile(path.join(repo, "stashed-strict.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "strict delete test stash"]);
  const config = { ...DEFAULT_CONFIG, requireEmptyStashInventory: true };

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_delete_stash_strict", config });

  assert.equal(result.ok, false);
  assert.match(result.reason, /stash inventory/);
  assert.equal(result.preflight.stashCount, 1);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config })).safetyRefs.length, 0);
});

test("protected branches and primary/current worktrees are blocked", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const protectedStart = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_delete_protected", taskName: "delete protected", branch: "develop", createWorktree: true, config: DEFAULT_CONFIG });
  const currentStart = await createGuardianWorktree(repo, "ses_delete_current");

  assert.equal(protectedStart.ok, false);
  assert.match(String(protectedStart.reason), /protected/);

  const protectedResult = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", branch: "develop", config: DEFAULT_CONFIG });
  assert.equal(protectedResult.ok, false);
  assert.match(protectedResult.reason, /protected/);

  const primaryResult = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", targetPath: repo, config: DEFAULT_CONFIG });
  assert.equal(primaryResult.ok, false);
  assert.match(primaryResult.reason, /primary/);

  const primaryDeleteBranchResult = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", targetPath: repo, deleteBranch: true, config: DEFAULT_CONFIG });
  assert.equal(primaryDeleteBranchResult.ok, false);
  assert.match(primaryDeleteBranchResult.reason, /primary/);

  const currentResult = await deleteWorktree({ repoRoot: repo, cwd: currentStart.session.worktree_path, mode: "plan", sessionId: "ses_delete_current", config: DEFAULT_CONFIG });
  assert.equal(currentResult.ok, false);
  assert.match(currentResult.reason, /current/);
});
