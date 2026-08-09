import fs from "node:fs/promises";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { createSafetyRef, getDirectRefCommitOrNull } from "../../src/git.ts";
import { getGuardianPaths, readState, updateState } from "../../src/state.ts";
import { isRecordLike } from "../../src/types.ts";
import { createRepoWithOrigin, git } from "../helpers.ts";

type AdvancedReservationInput = {
  readonly branch: string;
  readonly fileName: string;
  readonly repo: string;
  readonly safetyRef: string;
};

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

function requireArray(value: unknown, name: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array of objects`);
  return value.map((entry) => {
    if (isRecordLike(entry)) return entry;
    throw new TypeError(`${name} must be an array of objects`);
  });
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value === "number") return value;
  throw new TypeError(`${name} must be a number`);
}

async function createAdvancedReservation(input: AdvancedReservationInput): Promise<{ readonly head: string; readonly safetyRef: string }> {
  await git(input.repo, ["checkout", "-b", input.branch]);
  await fs.writeFile(`${input.repo}/${input.fileName}`, `${input.branch}\n`, "utf8");
  await git(input.repo, ["add", input.fileName]);
  await git(input.repo, ["commit", "-m", `add ${input.fileName}`]);
  const head = (await git(input.repo, ["rev-parse", "HEAD"])).stdout;
  await git(input.repo, ["checkout", "main"]);
  await git(input.repo, ["merge", "--no-ff", input.branch, "-m", `merge ${input.branch}`]);
  await git(input.repo, ["push", "origin", "main"]);
  await git(input.repo, ["push", "origin", input.branch]);
  await createSafetyRef(input.repo, { sessionId: "remote-branch-cleanup", branch: `origin/${input.branch}`, commit: head, ref: input.safetyRef });
  await updateState(input.repo, DEFAULT_CONFIG, (state) => ({
    ...state,
    remote_branch_cleanup_reservations: [...(Array.isArray(state.remote_branch_cleanup_reservations)
      ? requireArray(state.remote_branch_cleanup_reservations, "state.remote_branch_cleanup_reservations")
      : []), {
      remote: "origin",
      remote_branch: input.branch,
      head,
      safety_ref: input.safetyRef,
      reserved_at: "2026-08-09T00:00:00.000Z",
    }],
  }));
  await git(input.repo, ["checkout", input.branch]);
  await fs.writeFile(`${input.repo}/${input.fileName}.advanced`, "advanced\n", "utf8");
  await git(input.repo, ["add", `${input.fileName}.advanced`]);
  await git(input.repo, ["commit", "-m", `advance ${input.fileName}`]);
  await git(input.repo, ["push", "origin", input.branch]);
  await git(input.repo, ["checkout", "main"]);
  return { head, safetyRef: input.safetyRef };
}

async function remoteBranchExists(repo: string, branch: string): Promise<boolean> {
  return (await git(repo, ["ls-remote", "--heads", "origin", branch])).stdout.length > 0;
}

const fixture = await createRepoWithOrigin();
try {
  const first = await createAdvancedReservation({
    repo: fixture.repo,
    branch: "guardian/retirement-bound-one",
    fileName: "retirement-bound-one.txt",
    safetyRef: "refs/opencode-guardian/remote-branch-cleanup/origin/guardian/retirement-bound-one/20260809T000001",
  });
  const second = await createAdvancedReservation({
    repo: fixture.repo,
    branch: "guardian/retirement-bound-two",
    fileName: "retirement-bound-two.txt",
    safetyRef: "refs/opencode-guardian/remote-branch-cleanup/origin/guardian/retirement-bound-two/20260809T000002",
  });
  const { guardianFinishWorkflow } = await import("../../src/workflow.ts");
  const plan = await guardianFinishWorkflow({ repoRoot: fixture.repo, cwd: fixture.repo, mode: "plan", timestamp: "20260809T000000" });
  const preflight = requireRecord(plan.preflight, "plan.preflight");
  const apply = await guardianFinishWorkflow({ repoRoot: fixture.repo, cwd: fixture.repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken, timestamp: "20260809T000000" });
  const state = await readState(await getGuardianPaths(fixture.repo), { repoRoot: fixture.repo, config: DEFAULT_CONFIG });
  const reservations = [first, second];
  const branchesPreserved = await Promise.all(["guardian/retirement-bound-one", "guardian/retirement-bound-two"].map((branch) => remoteBranchExists(fixture.repo, branch)));
  const safetyRefsPreserved = await Promise.all(reservations.map(async (reservation) => (await getDirectRefCommitOrNull(fixture.repo, reservation.safetyRef)) === reservation.head));

  process.stdout.write([
    `total=${requireNumber(preflight.reservationRetirementCandidateCount, "plan.preflight.reservationRetirementCandidateCount")}`,
    `shown=${requireArray(plan.reservationRetirementCandidates, "plan.reservationRetirementCandidates").length}`,
    `omitted=${requireNumber(preflight.reservationRetirementCandidateOmittedCount, "plan.preflight.reservationRetirementCandidateOmittedCount")}`,
    `applyBatch=${requireArray(apply.reservationRetirementResults, "apply.reservationRetirementResults").length}`,
    `retired=${requireArray(apply.reservationRetirementResults, "apply.reservationRetirementResults").filter((entry) => entry.status === "retired").length}`,
    `remaining=${requireArray(state.remote_branch_cleanup_reservations, "state.remote_branch_cleanup_reservations").length}`,
    `branchesPreserved=${branchesPreserved.every(Boolean)}`,
    `safetyRefsPreserved=${safetyRefsPreserved.every(Boolean)}`,
  ].join("\n") + "\n");
} finally {
  await fs.rm(fixture.base, { recursive: true, force: true });
}
