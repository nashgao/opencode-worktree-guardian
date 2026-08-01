import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { getGuardianPaths, readState } from "../src/state.ts";
import { guardianStart } from "../src/start.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepoWithOrigin, git, rescueMutationSurface } from "./helpers.ts";
import { installFakeGh } from "./delete-fixtures.ts";

type LooseRecord = Record<string, unknown>;
function asDone(result: LooseRecord) {
  return result as LooseRecord & { status?: unknown; recoveryRef?: unknown; recoveryCommit?: unknown; rescuedFileCount?: unknown };
}

async function assertRescueUnchanged(repo: string, before: Awaited<ReturnType<typeof rescueMutationSurface>>): Promise<void> {
  assert.deepEqual(await rescueMutationSurface(repo), before);
}

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
};

async function createSessionFixture(options: SessionFixtureOptions) {
  const { base, repo } = await createRepoWithOrigin();
  options.t.after(() => fs.rm(base, { recursive: true, force: true }));
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

test("guardian_done rescue default and plan are evidence-only", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "README.md"), "DIRTY tracked change\n");
  await fs.writeFile(path.join(repo, "scratch-note.md"), "untracked junk\n");
  const before = await rescueMutationSurface(repo);

  // When
  const implicitPlan = asDone(await guardianDone({ repoRoot: repo, cwd: repo, rescue: true, timestamp: "20260609T060606" }));
  const explicitPlan = asDone(await guardianDone({ repoRoot: repo, cwd: repo, rescue: true, mode: "plan", timestamp: "20260609T060606" }));

  // Then
  assert.equal(implicitPlan.status, "rescue-planned");
  assert.equal(explicitPlan.status, "rescue-planned");
  assert.equal(typeof explicitPlan.confirmToken, "string");
  await assertRescueUnchanged(repo, before);
});

test("guardian_done rescue requires confirmation after an exact token", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "README.md"), "DIRTY tracked change\n");
  await fs.writeFile(path.join(repo, "scratch-note.md"), "untracked junk\n");
  const plan = requireRecord(await guardianDone({ repoRoot: repo, cwd: repo, rescue: true, mode: "plan", timestamp: "20260609T060606" }), "plan");
  const before = await rescueMutationSurface(repo);

  // When
  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, rescue: true, mode: "apply", confirmToken: requireString(plan.confirmToken, "plan.confirmToken"), timestamp: "20260609T060606" }));

  // Then
  assert.equal(result.status, "blocked");
  assert.match(requireString(result.reason, "result.reason"), /confirm=true/);
  await assertRescueUnchanged(repo, before);
});

test("guardian_done rescue confirmed apply captures and cleans only planned paths", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const timestamp = "20260727T082020";
  await fs.writeFile(path.join(repo, "README.md"), "DIRTY tracked change\n");
  await fs.writeFile(path.join(repo, "scratch-note.md"), "untracked junk\n");
  const plan = requireRecord(await guardianDone({ repoRoot: repo, cwd: repo, rescue: true, mode: "plan", timestamp }), "plan");

  // When
  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, rescue: true, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken"), timestamp }));

  // Then
  assert.equal(result.status, "rescued");
  assert.match(requireString(result.recoveryRef, "result.recoveryRef"), /^refs\/opencode-guardian\/rescue\//);
  assert.equal((await git(repo, ["status", "--porcelain"])).stdout, "");
  assert.equal(await fs.readFile(path.join(repo, "README.md"), "utf8"), "initial\n");
  assert.equal(await fs.access(path.join(repo, "scratch-note.md")).then(() => false, () => true), true);
  await git(repo, ["read-tree", "-u", "--reset", requireString(result.recoveryCommit, "result.recoveryCommit")]);
  assert.equal(await fs.readFile(path.join(repo, "README.md"), "utf8"), "DIRTY tracked change\n");
  assert.equal(await fs.readFile(path.join(repo, "scratch-note.md"), "utf8"), "untracked junk\n");
});

test("guardian_done rescue preserves dirty work when its create-only recovery ref collides", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const timestamp = "20260727T082020";
  await fs.writeFile(path.join(repo, "README.md"), "DIRTY tracked change\n");
  const plan = requireRecord(await guardianDone({ repoRoot: repo, cwd: repo, rescue: true, mode: "plan", timestamp }), "plan");
  const rescueRef = requireString(plan.rescueRef, "plan.rescueRef");
  const originalTarget = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  await git(repo, ["update-ref", rescueRef, originalTarget]);

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, rescue: true, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken"), timestamp }));

  assert.equal(result.status, "blocked");
  assert.equal((await git(repo, ["rev-parse", rescueRef])).stdout, originalTarget);
  assert.equal(await fs.readFile(path.join(repo, "README.md"), "utf8"), "DIRTY tracked change\n");
});

test("guardian_done rescue is a no-op on a clean worktree", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const r = asDone(await guardianDone({ repoRoot: repo, cwd: repo, rescue: true }));
  assert.equal(r.status, "rescue-noop");
  assert.equal(r.rescuedFileCount, 0);
});

test("guardian_done rescue blocks drift in content, status, path, symlink target, HEAD, and timestamp", async (t) => {
  const mutations: readonly { readonly name: string; readonly mutate: (repo: string) => Promise<void>; readonly setup?: (repo: string) => Promise<void>; readonly timestamp?: string }[] = [
    { name: "content", mutate: async (repo) => fs.writeFile(path.join(repo, "README.md"), "changed twice\n") },
    { name: "status", mutate: async (repo) => { await git(repo, ["add", "README.md"]); } },
    { name: "path", mutate: async (repo) => fs.writeFile(path.join(repo, "late.txt"), "late\n") },
    {
      name: "symlink target",
      setup: async (repo) => {
        await fs.symlink("README.md", path.join(repo, "link.txt"));
        await git(repo, ["add", "link.txt"]);
        await git(repo, ["commit", "-m", "add tracked link"]);
        await fs.unlink(path.join(repo, "link.txt"));
        await fs.symlink("other.txt", path.join(repo, "link.txt"));
      },
      mutate: async (repo) => {
        await fs.unlink(path.join(repo, "link.txt"));
        await fs.symlink("another.txt", path.join(repo, "link.txt"));
      },
    },
    { name: "HEAD", mutate: async (repo) => { await git(repo, ["add", "README.md"]); await git(repo, ["commit", "-m", "advance head"]); await fs.writeFile(path.join(repo, "post-head.txt"), "still dirty\n"); } },
    { name: "timestamp", timestamp: "20260727T090000", mutate: async () => {} },
  ];
  for (const mutation of mutations) await t.test(mutation.name, async (t) => {
    // Given
    const { base, repo } = await createRepoWithOrigin();
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    await mutation.setup?.(repo);
    if (mutation.name !== "symlink target") await fs.writeFile(path.join(repo, "README.md"), "DIRTY tracked change\n");
    const plan = requireRecord(await guardianDone({ repoRoot: repo, cwd: repo, rescue: true, mode: "plan", timestamp: mutation.timestamp }), "plan");

    // When
    await mutation.mutate(repo);
    const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, rescue: true, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken"), timestamp: mutation.name === "timestamp" ? "20260727T090001" : mutation.timestamp }));

    // Then
    assert.equal(result.status, "blocked");
    assert.match(requireString(result.reason, "result.reason"), /confirm token mismatch/);
  });
});

test("guardian_done rescue plans and recovers tracked paths that match ignore rules", async (t) => {
  const cases: readonly { readonly name: string; readonly mutate: (repo: string) => Promise<void>; readonly expectedPath: string }[] = [
    { name: "modified", mutate: async (repo) => fs.writeFile(path.join(repo, "tracked.ignored"), "modified\n"), expectedPath: "tracked.ignored" },
    { name: "deleted", mutate: async (repo) => fs.rm(path.join(repo, "tracked.ignored")), expectedPath: "tracked.ignored" },
    { name: "renamed", mutate: async (repo) => { await git(repo, ["mv", "tracked.ignored", "renamed.ignored"]); }, expectedPath: "renamed.ignored" },
  ];
  for (const item of cases) await t.test(item.name, async (t) => {
    const { base, repo } = await createRepoWithOrigin();
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    await fs.writeFile(path.join(repo, "tracked.ignored"), "initial tracked content\n");
    await git(repo, ["add", "tracked.ignored"]);
    await git(repo, ["commit", "-m", "add tracked ignored fixture"]);
    await fs.writeFile(path.join(repo, ".gitignore"), "*.ignored\n");
    await git(repo, ["add", ".gitignore"]);
    await git(repo, ["commit", "-m", "ignore tracked fixture"]);

    await item.mutate(repo);
    const plan = requireRecord(await guardianDone({ repoRoot: repo, cwd: repo, rescue: true, mode: "plan", timestamp: "20260730T090000" }), "plan");
    assert.equal(plan.status, "rescue-planned");
    assert.doesNotMatch(JSON.stringify(plan.entries), /"status":"!!"/);
    const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, rescue: true, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken"), timestamp: "20260730T090000" }));

    assert.equal(result.status, "rescued");
    const recoveryCommit = requireString(result.recoveryCommit, "result.recoveryCommit");
    if (item.name === "deleted") assert.match((await git(repo, ["diff", "--name-status", `${recoveryCommit}^`, recoveryCommit])).stdout, /D\ttracked\.ignored/);
    else assert.equal((await git(repo, ["show", `${recoveryCommit}:${item.expectedPath}`])).stdout, item.name === "modified" ? "modified" : "initial tracked content");
    assert.equal((await git(repo, ["status", "--porcelain"])).stdout, "");
  });
});

test("guardian_done rescue blocks ignored residue before creating recovery evidence", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, ".gitignore"), "ignored.txt\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore rescue residue"]);
  await fs.writeFile(path.join(repo, "README.md"), "DIRTY tracked change\n");
  await fs.writeFile(path.join(repo, "ignored.txt"), "ignored residue\n");
  const before = await rescueMutationSurface(repo);

  // When
  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, rescue: true, mode: "plan" }));

  // Then
  assert.equal(result.status, "blocked");
  assert.match(requireString(result.reason, "result.reason"), /ignored files/);
  await assertRescueUnchanged(repo, before);
});

test("guardian_done blocks admin bypass added after a session land-and-clean plan", async (t) => {
  const sessionId = "land-clean-changed-admin-consent"; const { repo, worktree, branch } = await createSessionFixture({ t, sessionId, taskName: "changed admin consent" });
  await fs.writeFile(path.join(worktree, "feature.txt"), "feature\n", "utf8"); await git(worktree, ["add", "feature.txt"]); await git(worktree, ["commit", "-m", "add admin consent fixture"]);
  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim(); const fakeGh = await installFakeGh(t, { repo, branch, head }); const request = { repoRoot: repo, cwd: worktree, sessionId, config: DEFAULT_CONFIG };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan"); const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken"), allowAdminBypass: true });
  assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.status, "blocked"); assert.match(requireString(result.reason, "result.reason"), /plan changed/); await fs.access(worktree);
  await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]); assert.equal((await git(repo, ["ls-remote", "--heads", "origin", branch])).stdout, ""); assert.equal(await fs.access(fakeGh.logPath).then(() => true, () => false), false);
});

test("guardian_done all blocks admin bypass added after its plan", async (t) => {
  // Given
  const { repo, worktree, branch } = await createSessionFixture({ t, sessionId: "done-all-changed-admin-consent", taskName: "done all changed admin consent" });
  await fs.writeFile(path.join(worktree, "feature.txt"), "feature\n", "utf8");
  await git(worktree, ["add", "feature.txt"]);
  await git(worktree, ["commit", "-m", "add done all admin consent fixture"]);
  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
  const fakeGh = await installFakeGh(t, { repo, branch, head });
  const plan = requireRecord(await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan", config: DEFAULT_CONFIG }), "plan");

  // When
  const result = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken"), allowAdminBypass: true, config: DEFAULT_CONFIG });

  // Then
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.match(requireString(result.reason, "result.reason"), /confirm token mismatch/);
  await fs.access(worktree);
  await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  assert.equal(await fs.access(fakeGh.logPath).then(() => true, () => false), false);
});

test("guardian_done persists a matching reservation before a post-ref failure and permits its fresh retry", async (t) => {
  const sessionId = "reservation-retry";
  const { repo, worktree, branch } = await createSessionFixture({ t, sessionId, taskName: sessionId });
  await fs.writeFile(path.join(worktree, "feature.txt"), "feature\n", "utf8");
  await installFakeGh(t, { repo, branch, dynamicHead: true });
  const request = { repoRoot: repo, cwd: worktree, sessionId, commitMessage: "feat: reserve safety ref", timestamp: "2026-07-29T04:00:00.000Z", config: DEFAULT_CONFIG };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");
  const oldHead = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  const first = await guardianDone(
    { ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") },
    { commitTransactionHooks: { afterSafetyRefCreated: async () => { throw new Error("stop after reservation"); } } },
  );
  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(first.ok, false, JSON.stringify(first));
  assert.equal(first.status, "blocked");
  const reservedSession = requireRecord(state.sessions[sessionId], "session");
  assert.equal(reservedSession.dirty_commit_safety_ref_reservation instanceof Object, true);
  const reservedSafetyRef = requireString(requireRecord(reservedSession.dirty_commit_safety_ref_reservation, "reservation").safety_ref, "reservation.safety_ref");

  const retryPlan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "retryPlan");
  const retry = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(retryPlan.confirmToken, "retryPlan.confirmToken") });
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.commitSafetyRefDisposition, "reused");
  const newHead = requireString(retry.commit, "retry.commit");
  const completed = requireRecord((await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG })).sessions[sessionId], "completed session");
  assert.equal(completed.dirty_commit_safety_ref_reservation, undefined);
  assert.equal(completed.head_commit, newHead);
  const safetyRefs = completed.safety_refs;
  if (!Array.isArray(safetyRefs)) throw new TypeError("completed session safety_refs must be an array");
  assert.equal(safetyRefs.filter((ref) => ref === reservedSafetyRef).length, 1);
  assert.equal(new Set(safetyRefs).size, safetyRefs.length);
  assert.equal((await git(repo, ["rev-parse", reservedSafetyRef])).stdout, oldHead);
});
