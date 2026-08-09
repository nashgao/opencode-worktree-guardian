import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { runCleanupSweep, finalPostflightCommitsFromCleanupSweep } from "../src/done-cleanup-sweep.ts";
import { postFinishMaintenance } from "../src/done-land-clean-maintenance.ts";
import { guardianDone } from "../src/done.ts";
import { createSafetyRef } from "../src/git.ts";
import { getGuardianPaths, readState, updateState } from "../src/state.ts";
import { isRecordLike } from "../src/types.ts";
import { guardianFinishWorkflow } from "../src/workflow.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";
import { createMergedBranch, remoteBranchExists } from "./workflow-test-support.ts";

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecordLike) : [];
}

async function createAdvancedReservation(repo: string, name: string, phase: "active" | "pending-proof" = "pending-proof") {
  const branch = `guardian/${name}`;
  const head = await createMergedBranch(repo, branch, `${name}.txt`);
  const safetyRef = `refs/opencode-guardian/remote-branch-cleanup/origin/${branch}/20260810T030303`;
  await git(repo, ["push", "origin", branch]);
  if (phase === "active") {
    await createSafetyRef(repo, { sessionId: "remote-branch-cleanup", branch: `origin/${branch}`, commit: head, ref: safetyRef });
  }
  await updateState(repo, DEFAULT_CONFIG, (state) => ({
    ...state,
    remote_branch_cleanup_reservations: [{
      remote: "origin",
      remote_branch: branch,
      head,
      safety_ref: safetyRef,
      phase,
      reserved_at: "2026-08-10T03:03:03.000Z",
    }],
  }));
  await git(repo, ["checkout", branch]);
  await fs.writeFile(path.join(repo, `${name}-advanced.txt`), "advanced\n");
  await git(repo, ["add", `${name}-advanced.txt`]);
  await git(repo, ["commit", "-m", `advance ${name} reservation`]);
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["checkout", "main"]);
  return { branch, head, safetyRef };
}

test("guardian_finish_workflow retires an advanced pending-proof reservation without deleting its remote branch", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const reservation = await createAdvancedReservation(repo, "workflow-pending-proof-retirement");

  const plan = await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" });
  const apply = await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken });
  const state = await readState(await getGuardianPaths(repo), { repoRoot: repo, config: DEFAULT_CONFIG });
  const finalPostflight = isRecordLike(apply.finalPostflight) ? apply.finalPostflight : {};

  assert.equal(plan.status, "planned-partial", JSON.stringify(plan));
  assert.equal(records(plan.reservationRetirementCandidates)[0]?.reservationPhase, "pending-proof");
  assert.equal(apply.status, "partial", JSON.stringify(apply));
  assert.equal(apply.freshPlanRequired, true);
  assert.equal(records(apply.reservationRetirementResults)[0]?.status, "retired");
  assert.equal(records(apply.reservationRetirementResults)[0]?.reservationPhase, "pending-proof");
  assert.equal(finalPostflight.status, "skipped");
  assert.equal("baseSync" in apply, false);
  assert.equal("results" in apply, false);
  assert.equal(await remoteBranchExists(repo, reservation.branch), true);
  await assert.rejects(git(repo, ["rev-parse", "--verify", reservation.safetyRef]));
  assert.deepEqual(state.remote_branch_cleanup_reservations, []);
});

test("runCleanupSweep reports retirement-only work without adding final-postflight commit requirements", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const reservation = await createAdvancedReservation(repo, "cleanup-sweep-pending-proof-retirement");

  const sweep = await runCleanupSweep(repo, DEFAULT_CONFIG);

  assert.equal(sweep.ok, false, JSON.stringify(sweep));
  assert.equal(sweep.status, "partial");
  assert.equal(sweep.candidateCount, 0);
  assert.equal(sweep.retirementCandidateCount, 1);
  assert.equal(sweep.retiredCount, 1);
  assert.equal(sweep.freshPlanRequired, true);
  assert.deepEqual(finalPostflightCommitsFromCleanupSweep(sweep), []);
  assert.equal(await remoteBranchExists(repo, reservation.branch), true);
  await assert.rejects(git(repo, ["rev-parse", "--verify", reservation.safetyRef]));
});

test("postFinishMaintenance stops after retirement-only cleanup and omits sync and final postflight", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await createAdvancedReservation(repo, "maintenance-pending-proof-retirement");

  const maintenance = await postFinishMaintenance({ input: {}, repoRoot: repo, sessionId: "ses_maintenance_retirement", config: DEFAULT_CONFIG }, []);

  assert.deepEqual(Object.keys(maintenance).sort(), ["cleanupSweep", "freshPlanRequired"]);
  assert.equal(maintenance.freshPlanRequired, true);
  assert.equal((maintenance.cleanupSweep as Record<string, unknown>).retiredCount, 1);
});

test("guardian_done primary publish stops after retiring an advanced active reservation", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const reservation = await createAdvancedReservation(repo, "primary-publish-active-retirement", "active");
  await fs.writeFile(path.join(repo, "primary-publish-retirement.txt"), "publish\n");

  const plan = await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: publish before reservation retirement" });
  const apply = await guardianDone({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken, commitMessage: "feat: publish before reservation retirement" });

  assert.equal(plan.lane, "primary-main-publish");
  assert.equal(apply.status, "partial", JSON.stringify(apply));
  assert.equal(apply.freshPlanRequired, true);
  assert.equal((apply.cleanupSweep as Record<string, unknown>).retiredCount, 1);
  assert.equal("finalPostflight" in apply, false);
  assert.equal(await remoteBranchExists(repo, reservation.branch), true);
  assert.equal((await git(repo, ["rev-parse", "--verify", reservation.safetyRef])).stdout, reservation.head);
});
