import {
  assert,
  createMergedBranch,
  createRepoWithOrigin,
  createSafetyRef,
  DEFAULT_CONFIG,
  fs,
  git,
  guardianFinishWorkflow,
  remoteBranchExists,
  test,
  workflowResult,
} from "./workflow-test-support.js";
import { getGuardianPaths, readState, updateState } from "../src/state.ts";
import { remoteBranchCleanupReservations, reserveRemoteBranchCleanupSafetyRef, retirePendingRemoteBranchCleanupSafetyRefReservation } from "../src/state-remote-branch-reservation.ts";
import { getDirectRefCommitOrNull } from "../src/git.ts";

type ReservationInput = {
  readonly repo: string;
  readonly branch: string;
  readonly head: string;
  readonly safetyRef: string;
};

async function recordRemoteBranchCleanupReservation(input: ReservationInput): Promise<void> {
  await updateState(input.repo, DEFAULT_CONFIG, (state) => ({
    ...state,
    remote_branch_cleanup_reservations: [{
      remote: "origin",
      remote_branch: input.branch,
      head: input.head,
      safety_ref: input.safetyRef,
      reserved_at: "2026-07-31T10:10:10.000Z",
    }],
  }));
}

test("remote cleanup promotes a persisted pending proof after a crash before activation", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-remote-pending-retry";
  const head = await createMergedBranch(repo, branch, "workflow-remote-pending-retry.txt");
  const safetyRef = "refs/opencode-guardian/remote-branch-cleanup/origin/guardian/workflow-remote-pending-retry/20260810T000000";
  await recordRemoteBranchCleanupReservation({ repo, branch, head, safetyRef });
  await updateState(repo, DEFAULT_CONFIG, (state) => ({
    ...state,
    remote_branch_cleanup_reservations: [{
      remote: "origin",
      remote_branch: branch,
      head,
      safety_ref: safetyRef,
      reserved_at: "2026-08-10T00:00:00.000Z",
      phase: "pending-proof",
    }],
  }));
  await createSafetyRef(repo, { sessionId: "remote-branch-cleanup", branch: `origin/${branch}`, commit: head, ref: safetyRef });

  const retry = await reserveRemoteBranchCleanupSafetyRef({ repoRoot: repo, config: DEFAULT_CONFIG, remote: "origin", remoteBranch: branch, head, safetyRef });

  assert.equal(retry.disposition, "created");
  assert.equal((await remoteBranchCleanupReservations(repo, DEFAULT_CONFIG))[0]?.phase, "active");
});

test("pending remote cleanup reservation remains recorded when a divergent replacement appears", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-remote-pending-divergence";
  const head = await createMergedBranch(repo, branch, "workflow-remote-pending-divergence.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["branch", "-d", branch]);
  await git(repo, ["fetch", "origin"]);
  const safetyRef = "refs/opencode-guardian/remote-branch-cleanup/origin/guardian/workflow-remote-pending-divergence/20260810T010101";
  await updateState(repo, DEFAULT_CONFIG, (state) => ({
    ...state,
    remote_branch_cleanup_reservations: [{ remote: "origin", remote_branch: branch, head, safety_ref: safetyRef, reserved_at: "2026-08-10T01:01:01.000Z", phase: "pending-proof" }],
  }));
  const replacement = (await git(repo, ["commit-tree", `${head}^{tree}`, "-m", "divergent replacement"])).stdout;
  await git(repo, ["push", "origin", `+${replacement}:refs/heads/${branch}`]);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", timestamp: "20260810T010101" }));

  assert.equal(plan.reservationRetirementCandidates?.length ?? 0, 0);
  assert.equal(plan.blockers.some((blocker) => blocker.remoteBranch === branch), true);
  assert.equal((await remoteBranchCleanupReservations(repo, DEFAULT_CONFIG))[0]?.phase, "pending-proof");
  assert.equal(await remoteBranchExists(repo, branch), true);
});

test("remote cleanup refuses to append pending state beside an active matching reservation without its ref", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const head = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  const branch = "guardian/workflow-active-ref-missing";
  const safetyRef = "refs/opencode-guardian/remote-branch-cleanup/origin/guardian/workflow-active-ref-missing/20260810T030303";
  await recordRemoteBranchCleanupReservation({ repo, branch, head, safetyRef });

  await assert.rejects(reserveRemoteBranchCleanupSafetyRef({ repoRoot: repo, config: DEFAULT_CONFIG, remote: "origin", remoteBranch: branch, head, safetyRef }), /could not be persisted/);

  assert.equal((await remoteBranchCleanupReservations(repo, DEFAULT_CONFIG)).length, 1);
  await assert.rejects(git(repo, ["rev-parse", "--verify", safetyRef]));
});

test("pending reservation retirement blocks when safety-ref evidence appears before completion", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const head = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  const observedHead = (await git(repo, ["commit-tree", `${head}^{tree}`, "-p", head, "-m", "advanced"])).stdout;
  const branch = "guardian/workflow-pending-retirement-race";
  const safetyRef = "refs/opencode-guardian/remote-branch-cleanup/origin/guardian/workflow-pending-retirement-race/20260810T040404";
  await updateState(repo, DEFAULT_CONFIG, (state) => ({ ...state, remote_branch_cleanup_reservations: [{ remote: "origin", remote_branch: branch, head, safety_ref: safetyRef, reserved_at: "2026-08-10T04:04:04.000Z", phase: "pending-proof" }] }));
  await createSafetyRef(repo, { sessionId: "remote-branch-cleanup", branch: `origin/${branch}`, commit: head, ref: safetyRef });

  await assert.rejects(retirePendingRemoteBranchCleanupSafetyRefReservation({ repoRoot: repo, config: DEFAULT_CONFIG, remote: "origin", remoteBranch: branch, head, observedHead, safetyRef }), /gained safety-ref evidence/);

  assert.equal((await remoteBranchCleanupReservations(repo, DEFAULT_CONFIG))[0]?.phase, "pending-proof");
});

test("remote cleanup apply rejects reservation phase drift", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const head = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  const branch = "guardian/workflow-phase-drift";
  const safetyRef = "refs/opencode-guardian/remote-branch-cleanup/origin/guardian/workflow-phase-drift/20260810T050505";
  await recordRemoteBranchCleanupReservation({ repo, branch, head, safetyRef });
  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", timestamp: "20260810T050505" }));
  await updateState(repo, DEFAULT_CONFIG, (state) => ({ ...state, remote_branch_cleanup_reservations: [{ remote: "origin", remote_branch: branch, head, safety_ref: safetyRef, reserved_at: "2026-08-10T05:05:05.000Z", phase: "pending-proof" }] }));

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken, timestamp: "20260810T050505" }));

  assert.match(String(apply.reason), /confirm token mismatch/);
});

test("guardian_finish_workflow reuses a recorded direct safety ref after remote deletion fails", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-remote-reservation-retry";
  const head = await createMergedBranch(repo, branch, "workflow-remote-reservation-retry.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["branch", "-d", branch]);
  await git(repo, ["fetch", "origin"]);
  const timestamp = "20260731T101010";
  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", timestamp }));
  const safetyRef = String(plan.candidates[0]?.safetyRef);
  await createSafetyRef(repo, { sessionId: "remote-branch-cleanup", branch: `origin/${branch}`, commit: head, ref: safetyRef });
  await recordRemoteBranchCleanupReservation({ repo, branch, head, safetyRef });

  // When
  const retryPlan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", timestamp }));
  const retried = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: retryPlan.confirmToken, timestamp }));

  // Then
  assert.equal(await remoteBranchExists(repo, branch), false);
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(retried.results[0]?.safetyRef, safetyRef);
  assert.equal(retried.results[0]?.head, head);
});

test("remote cleanup persists no ref when reservation recording fails", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const head = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  const branch = "guardian/workflow-remote-persistence-failure";
  const firstSafetyRef = "refs/opencode-guardian/remote-branch-cleanup/origin/guardian/workflow-remote-persistence-failure/first";
  const failedSafetyRef = "refs/opencode-guardian/remote-branch-cleanup/origin/guardian/workflow-remote-persistence-failure/failed";
  await recordRemoteBranchCleanupReservation({ repo, branch, head, safetyRef: firstSafetyRef });
  const input = { repoRoot: repo, config: DEFAULT_CONFIG, remote: "origin", remoteBranch: branch, head, safetyRef: failedSafetyRef };

  await assert.rejects(reserveRemoteBranchCleanupSafetyRef(input), /could not be persisted/);
  await assert.rejects(reserveRemoteBranchCleanupSafetyRef(input), /could not be persisted/);

  await assert.rejects(git(repo, ["rev-parse", failedSafetyRef]));
});

test("remote cleanup proof rejects an annotated tag instead of peeling it to the reserved commit", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const head = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  const ref = "refs/opencode-guardian/remote-branch-cleanup/origin/guardian/tag-proof/20260801T010101";
  await git(repo, ["tag", "-a", "remote-cleanup-proof-tag", "-m", "tag proof", head]);
  await git(repo, ["update-ref", ref, "refs/tags/remote-cleanup-proof-tag"]);

  assert.equal(await getDirectRefCommitOrNull(repo, ref), null);
});

test("guardian_finish_workflow blocks an unrecorded same-OID remote cleanup safety ref", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-remote-unrecorded";
  const head = await createMergedBranch(repo, branch, "workflow-remote-unrecorded.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["branch", "-d", branch]);
  await git(repo, ["fetch", "origin"]);
  const timestamp = "20260731T111111";
  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", timestamp }));
  const safetyRef = String(plan.candidates[0]?.safetyRef);
  await createSafetyRef(repo, { sessionId: "remote-branch-cleanup", branch: `origin/${branch}`, commit: head, ref: safetyRef });

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken, timestamp }));

  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(apply.results[0]?.status, "blocked");
  assert.equal(await remoteBranchExists(repo, branch), true);
});

test("guardian_finish_workflow blocks a symbolic recorded remote cleanup safety ref", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-remote-symbolic";
  const head = await createMergedBranch(repo, branch, "workflow-remote-symbolic.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["branch", "-d", branch]);
  await git(repo, ["fetch", "origin"]);
  const timestamp = "20260731T121212";
  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", timestamp }));
  const safetyRef = String(plan.candidates[0]?.safetyRef);
  const targetRef = "refs/heads/workflow-remote-symbolic-target";
  await createSafetyRef(repo, { sessionId: "remote-branch-cleanup", branch: `origin/${branch}`, commit: head, ref: safetyRef });
  await recordRemoteBranchCleanupReservation({ repo, branch, head, safetyRef });
  await git(repo, ["update-ref", targetRef, head]);
  await git(repo, ["update-ref", "-d", safetyRef]);
  await git(repo, ["symbolic-ref", safetyRef, targetRef]);
  assert.equal((await git(repo, ["symbolic-ref", "--no-recurse", safetyRef])).stdout, targetRef);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken, timestamp }));

  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(await remoteBranchExists(repo, branch), true);
});

test("guardian_finish_workflow blocks a different-OID recorded remote cleanup safety ref", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-remote-different-oid";
  const head = await createMergedBranch(repo, branch, "workflow-remote-different-oid.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["branch", "-D", branch]);
  await git(repo, ["fetch", "origin"]);
  const timestamp = "20260731T131313";
  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", timestamp }));
  const safetyRef = String(plan.candidates[0]?.safetyRef);
  const other = (await git(repo, ["commit-tree", `${head}^{tree}`, "-p", head, "-m", "different remote cleanup safety ref target"])).stdout;
  await createSafetyRef(repo, { sessionId: "remote-branch-cleanup", branch: `origin/${branch}`, commit: other, ref: safetyRef });
  await recordRemoteBranchCleanupReservation({ repo, branch, head, safetyRef });

  const retryPlan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", timestamp }));
  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: retryPlan.confirmToken, timestamp }));

  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(apply.results[0]?.status, "blocked");
  assert.equal(await remoteBranchExists(repo, branch), true);
});

test("guardian_finish_workflow blocks a reservation when its remote branch advanced", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-remote-advanced";
  const head = await createMergedBranch(repo, branch, "workflow-remote-advanced.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["branch", "-D", branch]);
  await git(repo, ["fetch", "origin"]);
  const timestamp = "20260731T141414";
  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", timestamp }));
  const safetyRef = String(plan.candidates[0]?.safetyRef);
  await createSafetyRef(repo, { sessionId: "remote-branch-cleanup", branch: `origin/${branch}`, commit: head, ref: safetyRef });
  await recordRemoteBranchCleanupReservation({ repo, branch, head, safetyRef });
  await git(repo, ["branch", branch, head]);
  await git(repo, ["checkout", branch]);
  await fs.writeFile(`${repo}/workflow-remote-advanced-later.txt`, "later\n", "utf8");
  await git(repo, ["add", "workflow-remote-advanced-later.txt"]);
  await git(repo, ["commit", "-m", "advance remote cleanup branch"]);
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["checkout", "main"]);
  await git(repo, ["branch", "-D", branch]);

  const retryPlan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", timestamp }));

  const retire = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: retryPlan.confirmToken, timestamp }));

  assert.equal(retryPlan.ok, true, JSON.stringify(retryPlan));
  assert.equal(retryPlan.status, "planned-partial");
  assert.equal((retryPlan.reservationRetirementCandidates ?? [])[0]?.observedHead !== head, true);
  assert.equal(retire.status, "partial");
  assert.equal((retire.reservationRetirementResults ?? [])[0]?.status, "retired");
  assert.equal(retire.freshPlanRequired, true);
  assert.equal(await remoteBranchExists(repo, branch), true);
});

test("guardian_finish_workflow reconciles an approved absent remote branch retry", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-remote-absent";
  const head = await createMergedBranch(repo, branch, "workflow-remote-absent.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["branch", "-d", branch]);
  await git(repo, ["fetch", "origin"]);
  const timestamp = "20260731T151515";
  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", timestamp }));
  const safetyRef = String(plan.candidates[0]?.safetyRef);
  await createSafetyRef(repo, { sessionId: "remote-branch-cleanup", branch: `origin/${branch}`, commit: head, ref: safetyRef });
  await recordRemoteBranchCleanupReservation({ repo, branch, head, safetyRef });
  await git(repo, ["push", "origin", `:refs/heads/${branch}`]);
  await git(repo, ["fetch", "--prune", "origin"]);

  const retryPlan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", timestamp }));
  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: retryPlan.confirmToken, timestamp }));
  const state = await readState(await getGuardianPaths(repo), { repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.equal(apply.results[0]?.status, "reconciled");
  assert.equal(apply.results[0]?.remoteBranchDeleted, false);
  assert.equal(apply.results[0]?.remoteBranchReconciled, true);
  assert.equal(await remoteBranchExists(repo, branch), false);
  assert.deepEqual(state.remote_branch_cleanup_reservations, []);
});
