import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";
import { getGuardianPaths, readState, writeStateAtomic } from "../src/state.ts";
import { runGuardianTool } from "../src/tools.ts";
import { git } from "./helpers.ts";
import type { RemovedGoalFixture } from "./goal-removed-session-fixtures.ts";
import { closureSnapshot, commitWithTree, primarySnapshot, rejectRemovalPush, removedGoalFixture, requireRecord, requireString } from "./goal-removed-session-fixtures.ts";

async function goal(fixture: RemovedGoalFixture, input: Record<string, unknown>) {
  return requireRecord(await runGuardianTool("guardian_goal", { ...fixture.request, ...input }), "goal result");
}

async function planClosure(fixture: RemovedGoalFixture) {
  const plan = await goal(fixture, { mode: "plan" });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.status, "planned");
  assert.deepEqual(requireRecord(plan.scope, "plan scope"), { kind: "session", sessionId: fixture.sessionId });
  requireString(plan.confirmToken, "plan token");
  return plan;
}

async function applyClosure(fixture: RemovedGoalFixture, plan: Record<string, unknown>, input: Record<string, unknown> = {}) {
  return goal(fixture, { mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan token"), ...input });
}

function assertBlocked(result: Record<string, unknown>) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.notEqual(result.complete, true, JSON.stringify(result));
}

async function ownerSession(fixture: RemovedGoalFixture) {
  const state = await readState(await getGuardianPaths(fixture.repo), { repoRoot: fixture.repo, config: fixture.config });
  return requireRecord(state.sessions[fixture.sessionId], "owner session");
}

async function assertUnrelatedPreserved(fixture: RemovedGoalFixture) {
  assert.deepEqual(await primarySnapshot(fixture.repo), fixture.primaryBefore);
  const state = await readState(await getGuardianPaths(fixture.repo), { repoRoot: fixture.repo, config: fixture.config });
  assert.deepEqual(state.sessions[fixture.otherId], fixture.otherBefore);
  assert.equal((await git(fixture.repo, ["rev-parse", `refs/heads/${fixture.otherBranch}`])).stdout, fixture.landedBaseHead);
  assert.equal((await git(fixture.remote, ["rev-parse", `refs/heads/${fixture.otherBranch}`])).stdout, fixture.landedBaseHead);
}

function assertReceipt(fixture: RemovedGoalFixture, receipt: Record<string, unknown>, phase: "prepared" | "complete") {
  assert.equal(receipt.version, 1);
  assert.equal(receipt.phase, phase);
  assert.equal(receipt.session_id, fixture.sessionId);
  assert.equal(receipt.branch, fixture.branch);
  assert.equal(receipt.worktree_path, fixture.worktree);
  assert.equal(receipt.remote, "origin");
  assert.equal(receipt.started_head_commit, fixture.baseline);
  assert.equal(receipt.expected_remote_head, fixture.head);
  assert.equal(receipt.landed_base_head, fixture.landedBaseHead);
  requireString(receipt.goal_fingerprint, "receipt Goal fingerprint");
  requireString(receipt.prepared_at, "receipt preparation time");
  if (phase === "complete") requireString(receipt.completed_at, "receipt completion time");
  else assert.equal(receipt.completed_at, undefined);
}

async function assertCompleted(fixture: RemovedGoalFixture, result: Record<string, unknown>) {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.complete, true, JSON.stringify(result));
  assert.deepEqual(requireRecord(result.scope, "completion scope"), { kind: "session", sessionId: fixture.sessionId });
  const session = await ownerSession(fixture);
  const receipt = requireRecord(session.external_goal_completion, "completion receipt");
  assert.equal(session.started_head_commit, fixture.baseline);
  assert.equal(session.status, "deleted");
  assertReceipt(fixture, receipt, "complete");
  const safetyRef = requireString(receipt.safety_ref, "receipt safety ref");
  assert.equal((await git(fixture.repo, ["rev-parse", safetyRef])).stdout, fixture.head);
  assert.ok(Array.isArray(session.safety_refs) && session.safety_refs.includes(safetyRef));
  assert.equal((await git(fixture.repo, ["ls-remote", "--heads", "origin", fixture.branch])).stdout, "");
  await assertUnrelatedPreserved(fixture);
  return { session, receipt, safetyRef };
}

async function completedFixture(t: TestContext) {
  const fixture = await removedGoalFixture(t);
  const plan = await planClosure(fixture);
  const applied = await applyClosure(fixture, plan);
  const completion = await assertCompleted(fixture, applied);
  return { fixture, ...completion };
}

async function rejectedClosure(fixture: RemovedGoalFixture) {
  const hook = await rejectRemovalPush(fixture);
  const plan = await planClosure(fixture);
  const result = await applyClosure(fixture, plan);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.notEqual(result.complete, true, JSON.stringify(result));
  assert.equal(await fs.readFile(hook.marker, "utf8"), `refs/heads/${fixture.branch}\n`);
  const session = await ownerSession(fixture);
  const receipt = requireRecord(session.external_goal_completion, "prepared receipt");
  assert.equal(session.status, "active");
  assert.equal(session.started_head_commit, fixture.baseline);
  assertReceipt(fixture, receipt, "prepared");
  const safetyRef = requireString(receipt.safety_ref, "prepared safety ref");
  assert.equal((await git(fixture.repo, ["rev-parse", safetyRef])).stdout, fixture.head);
  assert.equal((await git(fixture.remote, ["rev-parse", `refs/heads/${fixture.branch}`])).stdout, fixture.head);
  const stateAtPush = requireRecord(JSON.parse(await fs.readFile(`${hook.marker}.state.json`, "utf8")), "durable state at deletion attempt");
  const sessionAtPush = requireRecord(requireRecord(stateAtPush.sessions, "sessions at deletion attempt")[fixture.sessionId], "session at deletion attempt");
  assert.deepEqual(sessionAtPush.external_goal_completion, receipt);
  assert.equal(sessionAtPush.started_head_commit, fixture.baseline);
  assert.equal(sessionAtPush.status, "active");
  assert.ok((await fs.readFile(`${hook.marker}.refs`, "utf8")).split("\n").includes(`${safetyRef} ${fixture.head}`));
  await assertUnrelatedPreserved(fixture);
  return { ...hook, receipt, safetyRef };
}

test("a delivered externally removed session completes without publishing primary work or pruning another session", async (t) => {
  const fixture = await removedGoalFixture(t);
  const plan = requireRecord(await runGuardianTool("guardian_goal", { ...fixture.request, mode: "plan" }), "plan");
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.status, "planned");
  assert.deepEqual(await primarySnapshot(fixture.repo), fixture.primaryBefore);
  const applied = requireRecord(await runGuardianTool("guardian_goal", { ...fixture.request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan token") }), "apply");
  assert.equal(applied.complete, true, JSON.stringify(applied));
  assert.deepEqual(requireRecord(applied.scope, "scope"), { kind: "session", sessionId: fixture.sessionId });
  const readback = requireRecord(await runGuardianTool("guardian_goal", { ...fixture.request, mode: "plan" }), "readback");
  assert.equal(readback.complete, true, JSON.stringify(readback));
  assert.deepEqual(requireRecord(readback.scope, "scope"), { kind: "session", sessionId: fixture.sessionId });
  assert.deepEqual(await primarySnapshot(fixture.repo), fixture.primaryBefore);
  assert.equal((await git(fixture.repo, ["ls-remote", "--heads", "origin", fixture.branch])).stdout, "");
  assert.match((await git(fixture.repo, ["ls-remote", "--heads", "origin", fixture.otherBranch])).stdout, new RegExp(`refs/heads/${fixture.otherBranch}$`));
  const state = await readState(await getGuardianPaths(fixture.repo), { repoRoot: fixture.repo, config: fixture.config });
  assert.equal(state.sessions[fixture.sessionId]?.started_head_commit, fixture.baseline);
  assert.equal(state.sessions[fixture.sessionId]?.status, "deleted");
  assert.deepEqual(state.sessions[fixture.otherId], fixture.otherBefore);
});

test("removed-session closure refuses unknown sessions and missing, unknown, or mismatched delivery proofs without mutation", async (t) => {
  const fixture = await removedGoalFixture(t);
  const before = await closureSnapshot(fixture);
  const cases = [
    { action: undefined },
    { action: "unrecognized-closure-action" },
    { sessionId: "" },
    { sessionId: "not-a-recorded-session" },
    { sessionId: fixture.otherId },
    { expectedRemoteHead: "" },
    { expectedRemoteHead: "f".repeat(40) },
    { expectedRemoteHead: fixture.baseline },
    { landedBaseHead: "" },
    { landedBaseHead: "e".repeat(40) },
    { landedBaseHead: fixture.baseline },
  ];
  for (const input of cases) {
    assertBlocked(await goal(fixture, { mode: "plan", ...input }));
    assert.deepEqual(await closureSnapshot(fixture), before);
  }
});

test("a squash landing needs explicit nonancestor deletion approval and then completes only the owned session", async (t) => {
  const fixture = await removedGoalFixture(t, true);
  const before = await closureSnapshot(fixture);
  assertBlocked(await goal(fixture, { mode: "plan", allowNonAncestorRemoteDeletion: false }));
  assert.deepEqual(await closureSnapshot(fixture), before);
  const plan = await planClosure(fixture);
  assert.deepEqual(await closureSnapshot(fixture), before);
  await assertCompleted(fixture, await applyClosure(fixture, plan));
  await assertCompleted(fixture, await goal(fixture, { mode: "plan" }));
});

test("nonancestor opt-in cannot replace exact landed-tree proof or authoritative-base ancestry", async (t) => {
  const fixture = await removedGoalFixture(t, true);
  const before = await closureSnapshot(fixture);
  assertBlocked(await goal(fixture, { mode: "plan", landedBaseHead: fixture.baseline }));
  assert.deepEqual(await closureSnapshot(fixture), before);
  assertBlocked(await goal(fixture, { mode: "plan", landedBaseHead: fixture.head }));
  assert.deepEqual(await closureSnapshot(fixture), before);
});

test("a matching landed tree cannot prove ownership when the recorded baseline is not an ancestor of the published head", async (t) => {
  const fixture = await removedGoalFixture(t);
  const paths = await getGuardianPaths(fixture.repo);
  const state = await readState(paths, { repoRoot: fixture.repo, config: fixture.config });
  const session = state.sessions[fixture.sessionId];
  assert.ok(session);
  state.sessions[fixture.sessionId] = { ...session, started_head_commit: await commitWithTree(fixture.repo, fixture.head, fixture.head, "unrelated recorded baseline") };
  await writeStateAtomic(paths, state);
  const before = await closureSnapshot(fixture);
  assertBlocked(await goal(fixture, { mode: "plan" }));
  assert.deepEqual(await closureSnapshot(fixture), before);
});

test("a historical exact landed-tree proof remains valid when authoritative base has advanced to a different tree", async (t) => {
  const fixture = await removedGoalFixture(t);
  const advanced = await commitWithTree(fixture.repo, fixture.landedBaseHead, fixture.baseline, "advance authoritative base after delivery");
  await git(fixture.repo, ["push", "origin", `${advanced}:refs/heads/main`]);
  const before = await closureSnapshot(fixture);
  const plan = await planClosure(fixture);
  assert.deepEqual(await closureSnapshot(fixture), before);
  await assertCompleted(fixture, await applyClosure(fixture, plan));
  await assertCompleted(fixture, await goal(fixture, { mode: "plan" }));
  assert.equal((await git(fixture.remote, ["rev-parse", "refs/heads/main"])).stdout, advanced);
});

test("removed-session closure requires explicit confirmation and a matching nonempty plan token", async (t) => {
  const fixture = await removedGoalFixture(t);
  const plan = await planClosure(fixture);
  const before = await closureSnapshot(fixture);
  for (const input of [{ confirm: false }, { confirmToken: "" }, { confirmToken: "another-plan-token" }]) {
    assertBlocked(await applyClosure(fixture, plan, input));
    assert.deepEqual(await closureSnapshot(fixture), before);
  }
});

test("a plan token cannot approve a different valid landed proof or different Goal deletion options", async (t) => {
  const fixture = await removedGoalFixture(t);
  const advanced = await commitWithTree(fixture.repo, fixture.landedBaseHead, fixture.head, "equivalent later landed proof");
  await git(fixture.repo, ["push", "origin", `${advanced}:refs/heads/main`]);
  const plan = await planClosure(fixture);
  const before = await closureSnapshot(fixture);
  const cases = [
    { landedBaseHead: advanced },
    { allowNonAncestorRemoteDeletion: true },
    { config: { ...fixture.config, goal: { ...fixture.config.goal, cleanupHygiene: !fixture.config.goal.cleanupHygiene } } },
  ];
  for (const input of cases) {
    assertBlocked(await applyClosure(fixture, plan, input));
    assert.deepEqual(await closureSnapshot(fixture), before);
  }
});

for (const target of ["source", "base"] as const) {
  test(`a changed authoritative ${target} head invalidates a removed-session approval without touching any other ref or session`, async (t) => {
    const fixture = await removedGoalFixture(t);
    const plan = await planClosure(fixture);
    const branch = target === "source" ? fixture.branch : "main";
    const advanced = await commitWithTree(fixture.repo, fixture.head, fixture.head, `advance ${target} after planning`);
    await git(fixture.repo, ["push", "origin", `${advanced}:refs/heads/${branch}`]);
    const before = await closureSnapshot(fixture);
    assertBlocked(await applyClosure(fixture, plan));
    assert.deepEqual(await closureSnapshot(fixture), before);
    assert.equal((await git(fixture.remote, ["rev-parse", `refs/heads/${branch}`])).stdout, advanced);
  });
}

for (const target of ["branch", "path"] as const) {
  test(`a recreated local ${target} invalidates a removed-session approval and is preserved`, async (t) => {
    const fixture = await removedGoalFixture(t);
    const plan = await planClosure(fixture);
    if (target === "branch") {
      await git(fixture.repo, ["branch", fixture.branch, fixture.baseline]);
    } else {
      await fs.mkdir(fixture.worktree, { recursive: true });
      await fs.writeFile(path.join(fixture.worktree, "new-owner.txt"), "new path owner\n");
    }
    const before = await closureSnapshot(fixture);
    assertBlocked(await applyClosure(fixture, plan));
    assert.deepEqual(await closureSnapshot(fixture), before);
    if (target === "branch") assert.equal((await git(fixture.repo, ["rev-parse", `refs/heads/${fixture.branch}`])).stdout, fixture.baseline);
    else assert.equal(await fs.readFile(path.join(fixture.worktree, "new-owner.txt"), "utf8"), "new path owner\n");
  });
}

test("a changed recorded session baseline invalidates an otherwise valid closure token", async (t) => {
  const fixture = await removedGoalFixture(t);
  const plan = await planClosure(fixture);
  const paths = await getGuardianPaths(fixture.repo);
  const state = await readState(paths, { repoRoot: fixture.repo, config: fixture.config });
  const session = state.sessions[fixture.sessionId];
  assert.ok(session);
  state.sessions[fixture.sessionId] = { ...session, started_head_commit: fixture.head };
  await writeStateAtomic(paths, state);
  const before = await closureSnapshot(fixture);
  assertBlocked(await applyClosure(fixture, plan));
  assert.deepEqual(await closureSnapshot(fixture), before);
});

test("a real rejected deletion keeps its prepared proof through stale GC and start repair, then retries only the owned closure", async (t) => {
  const fixture = await removedGoalFixture(t);
  const gcPlan = requireRecord(await runGuardianTool("guardian_gc", { repoRoot: fixture.repo, cwd: fixture.repo, config: fixture.config, mode: "plan" }), "stale GC plan");
  assert.equal(gcPlan.ok, true, JSON.stringify(gcPlan));
  assert.ok(Array.isArray(gcPlan.candidates) && gcPlan.candidates.some((candidate) => requireRecord(candidate, "GC candidate").session_id === fixture.sessionId));
  const pending = await rejectedClosure(fixture);
  const before = await closureSnapshot(fixture);
  const staleGc = requireRecord(await runGuardianTool("guardian_gc", { repoRoot: fixture.repo, cwd: fixture.repo, config: fixture.config, mode: "apply", confirmDelete: true, confirmToken: requireString(gcPlan.confirmToken, "GC token") }), "stale GC apply");
  assertBlocked(staleGc);
  assert.deepEqual(await closureSnapshot(fixture), before);
  const freshGc = requireRecord(await runGuardianTool("guardian_gc", { repoRoot: fixture.repo, cwd: fixture.repo, config: fixture.config, mode: "plan" }), "fresh GC plan");
  assert.equal(freshGc.ok, true, JSON.stringify(freshGc));
  assert.ok(Array.isArray(freshGc.candidates));
  assert.equal(freshGc.candidates.some((candidate) => requireRecord(candidate, "GC candidate").session_id === fixture.sessionId), false);
  assert.deepEqual(await closureSnapshot(fixture), before);
  const repaired = requireRecord(await runGuardianTool("guardian_start", { repoRoot: fixture.repo, cwd: fixture.repo, config: fixture.config, sessionId: fixture.sessionId, createWorktree: true, branch: "guardian/do-not-repair-prepared", taskName: "do not replace prepared proof" }), "start repair");
  assertBlocked(repaired);
  assert.deepEqual(await closureSnapshot(fixture), before);
  assert.deepEqual((await ownerSession(fixture)).external_goal_completion, pending.receipt);
  await fs.rm(pending.hook);
  const retryPlan = await planClosure(fixture);
  assert.deepEqual((await ownerSession(fixture)).external_goal_completion, pending.receipt);
  const completed = await assertCompleted(fixture, await applyClosure(fixture, retryPlan));
  assert.equal(completed.safetyRef, pending.safetyRef);
  assert.equal(completed.receipt.prepared_at, pending.receipt.prepared_at);
  assert.equal(completed.receipt.goal_fingerprint, pending.receipt.goal_fingerprint);
  await assertCompleted(fixture, await goal(fixture, { mode: "plan" }));
});

test("a prepared closure does not authorize a changed proof or changed nonancestor option on retry", async (t) => {
  const fixture = await removedGoalFixture(t);
  const pending = await rejectedClosure(fixture);
  await fs.rm(pending.hook);
  const before = await closureSnapshot(fixture);
  for (const input of [{ expectedRemoteHead: fixture.baseline }, { landedBaseHead: fixture.baseline }, { allowNonAncestorRemoteDeletion: true }]) {
    assertBlocked(await goal(fixture, { mode: "plan", ...input }));
    assert.deepEqual(await closureSnapshot(fixture), before);
  }
});

test("a changed prepared safety ref cannot be overwritten to make a retry succeed", async (t) => {
  const fixture = await removedGoalFixture(t);
  const pending = await rejectedClosure(fixture);
  await fs.rm(pending.hook);
  await git(fixture.repo, ["update-ref", pending.safetyRef, fixture.baseline, fixture.head]);
  const before = await closureSnapshot(fixture);
  assertBlocked(await goal(fixture, { mode: "plan" }));
  assert.deepEqual(await closureSnapshot(fixture), before);
  assert.equal((await git(fixture.repo, ["rev-parse", pending.safetyRef])).stdout, fixture.baseline);
});

test("an absent published branch is not completion evidence without an owned prepared receipt", async (t) => {
  const fixture = await removedGoalFixture(t);
  await git(fixture.remote, ["update-ref", "-d", `refs/heads/${fixture.branch}`, fixture.head]);
  const before = await closureSnapshot(fixture);
  assertBlocked(await goal(fixture, { mode: "plan" }));
  assert.deepEqual(await closureSnapshot(fixture), before);
});

test("an intact prepared receipt can reconcile the same owned closure after the published branch disappears", async (t) => {
  const fixture = await removedGoalFixture(t);
  const pending = await rejectedClosure(fixture);
  await fs.rm(pending.hook);
  await git(fixture.remote, ["update-ref", "-d", `refs/heads/${fixture.branch}`, fixture.head]);
  const before = await closureSnapshot(fixture);
  const retryPlan = await planClosure(fixture);
  assert.deepEqual(await closureSnapshot(fixture), before);
  const completed = await assertCompleted(fixture, await applyClosure(fixture, retryPlan));
  assert.equal(completed.safetyRef, pending.safetyRef);
  assert.equal(completed.receipt.prepared_at, pending.receipt.prepared_at);
  await assertCompleted(fixture, await goal(fixture, { mode: "plan" }));
  const state = await readState(await getGuardianPaths(fixture.repo), { repoRoot: fixture.repo, config: fixture.config });
  const reservations = Array.isArray(state.remote_branch_cleanup_reservations) ? state.remote_branch_cleanup_reservations : [];
  assert.equal(reservations.some((entry) => requireRecord(entry, "cleanup reservation").remote_branch === fixture.branch), false);
});

for (const target of ["local branch", "local path", "remote branch"] as const) {
  test(`completion readback rejects a recreated ${target} without removing its new owner`, async (t) => {
    const { fixture } = await completedFixture(t);
    if (target === "local branch") {
      await git(fixture.repo, ["branch", fixture.branch, fixture.baseline]);
    } else if (target === "local path") {
      await fs.mkdir(fixture.worktree, { recursive: true });
      await fs.writeFile(path.join(fixture.worktree, "new-owner.txt"), "new path owner\n");
    } else {
      await git(fixture.remote, ["update-ref", `refs/heads/${fixture.branch}`, fixture.baseline]);
      await git(fixture.repo, ["config", "--replace-all", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"]);
    }
    const before = await closureSnapshot(fixture);
    assertBlocked(await goal(fixture, { mode: "plan" }));
    assert.deepEqual(await closureSnapshot(fixture), before);
    if (target === "local path") assert.equal(await fs.readFile(path.join(fixture.worktree, "new-owner.txt"), "utf8"), "new path owner\n");
  });
}

for (const change of ["lost receipt", "changed receipt", "lost safety ref", "changed safety ref"] as const) {
  test(`completion readback fails closed after ${change}`, async (t) => {
    const { fixture, safetyRef } = await completedFixture(t);
    if (change === "lost receipt" || change === "changed receipt") {
      const paths = await getGuardianPaths(fixture.repo);
      const state = await readState(paths, { repoRoot: fixture.repo, config: fixture.config });
      const session = state.sessions[fixture.sessionId];
      assert.ok(session);
      if (change === "lost receipt") Reflect.deleteProperty(session, "external_goal_completion");
      else requireRecord(session.external_goal_completion, "receipt").session_id = fixture.otherId;
      await writeStateAtomic(paths, state);
    } else if (change === "lost safety ref") {
      await git(fixture.repo, ["update-ref", "-d", safetyRef, fixture.head]);
    } else {
      await git(fixture.repo, ["update-ref", safetyRef, fixture.baseline, fixture.head]);
    }
    const before = await closureSnapshot(fixture);
    assertBlocked(await goal(fixture, { mode: "plan" }));
    assert.deepEqual(await closureSnapshot(fixture), before);
  });
}

test("completed receipt readback cannot be reused for another session, proof, or Goal option", async (t) => {
  const { fixture } = await completedFixture(t);
  const before = await closureSnapshot(fixture);
  for (const input of [{ sessionId: fixture.otherId }, { expectedRemoteHead: fixture.baseline }, { landedBaseHead: fixture.baseline }, { allowNonAncestorRemoteDeletion: true }]) {
    assertBlocked(await goal(fixture, { mode: "plan", ...input }));
    assert.deepEqual(await closureSnapshot(fixture), before);
  }
});

test("completed receipt readback rechecks the fresh authoritative base rather than trusting cached completion", async (t) => {
  const { fixture } = await completedFixture(t);
  await git(fixture.remote, ["update-ref", "refs/heads/main", fixture.baseline, fixture.landedBaseHead]);
  await git(fixture.repo, ["config", "--replace-all", "remote.origin.fetch", `+refs/heads/${fixture.otherBranch}:refs/remotes/origin/${fixture.otherBranch}`]);
  const before = await closureSnapshot(fixture);
  assertBlocked(await goal(fixture, { mode: "plan" }));
  assert.deepEqual(await closureSnapshot(fixture), before);
});

test("removed-session closure uses its inline recorded delivery authority throughout", async (t) => {
  const fixture = await removedGoalFixture(t, false, "delivery");
  const plan = await planClosure(fixture);
  const result = await applyClosure(fixture, plan);
  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal((await goal(fixture, { mode: "plan" })).complete, true);
  assert.equal((await git(fixture.remote, ["for-each-ref", "--format=%(refname)", `refs/heads/${fixture.branch}`])).stdout, "");
  const receipt = requireRecord((await ownerSession(fixture)).external_goal_completion, "receipt");
  assert.equal(receipt.remote, "delivery");
  await assertUnrelatedPreserved(fixture);
});

test("removed-session closure refuses to delete its explicitly retained remote branch", async (t) => {
  const fixture = await removedGoalFixture(t);
  const before = await closureSnapshot(fixture);
  assertBlocked(await goal(fixture, { mode: "plan", allowedRemoteBranches: [fixture.branch] }));
  assert.deepEqual(await closureSnapshot(fixture), before);
});
