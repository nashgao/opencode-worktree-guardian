import { createSafetyRef, getDirectRefCommitOrNull, getSymbolicRefTarget, tryGit } from "./git.ts";
import { getGuardianPaths, readState, updateState } from "./state.ts";
import type { GuardianConfig, RecordLike, RemoteBranchCleanupSafetyRefReservation } from "./types.ts";

const MAX_REMOTE_BRANCH_CLEANUP_RESERVATIONS = 25;
const REMOTE_BRANCH_CLEANUP_SAFETY_REF_PREFIX = "refs/opencode-guardian/remote-branch-cleanup/";

export type RemoteBranchCleanupSafetyRefReservationInput = {
  readonly repoRoot: string;
  readonly config: GuardianConfig | RecordLike;
  readonly remote: string;
  readonly remoteBranch: string;
  readonly head: string;
  readonly safetyRef: string;
  readonly phase?: "pending-proof" | "active";
};

export class RemoteBranchCleanupSafetyRefReservationPersistenceError extends Error {
  readonly safetyRef: string;

  constructor(safetyRef: string, cause: unknown) {
    super("remote-branch cleanup safety-ref reservation could not be persisted", { cause });
    this.name = "RemoteBranchCleanupSafetyRefReservationPersistenceError";
    this.safetyRef = safetyRef;
  }
}

function reservation(input: RemoteBranchCleanupSafetyRefReservationInput): RemoteBranchCleanupSafetyRefReservation {
  if (!input.safetyRef.startsWith(REMOTE_BRANCH_CLEANUP_SAFETY_REF_PREFIX)) throw new Error("remote branch cleanup safety ref is outside the Guardian namespace");
  return {
    remote: input.remote,
    remote_branch: input.remoteBranch,
    head: input.head,
    safety_ref: input.safetyRef,
    reserved_at: new Date().toISOString(),
    phase: input.phase ?? "active",
  };
}

function isReservation(value: unknown): value is RemoteBranchCleanupSafetyRefReservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return "remote" in value && typeof value.remote === "string"
    && "remote_branch" in value && typeof value.remote_branch === "string"
    && "head" in value && typeof value.head === "string"
    && "safety_ref" in value && typeof value.safety_ref === "string"
    && "reserved_at" in value && typeof value.reserved_at === "string"
    && (!("phase" in value) || value.phase === "pending-proof" || value.phase === "active");
}

function reservations(value: unknown): readonly RemoteBranchCleanupSafetyRefReservation[] {
  const current = Array.isArray(value) ? value.filter(isReservation) : [];
  if (current.length > MAX_REMOTE_BRANCH_CLEANUP_RESERVATIONS) throw new Error("remote branch cleanup safety-ref reservations exceed their bounded limit");
  return current.map((entry) => entry.phase === undefined ? { ...entry, phase: "active" } : entry);
}

function matches(actual: RemoteBranchCleanupSafetyRefReservation, expected: RemoteBranchCleanupSafetyRefReservation): boolean {
  return actual.remote === expected.remote
    && actual.remote_branch === expected.remote_branch
    && actual.head === expected.head
    && actual.safety_ref === expected.safety_ref
    && (actual.phase ?? "active") === (expected.phase ?? "active");
}

function sameRemoteBranch(actual: RemoteBranchCleanupSafetyRefReservation, expected: RemoteBranchCleanupSafetyRefReservation): boolean {
  return actual.remote === expected.remote && actual.remote_branch === expected.remote_branch;
}

export async function remoteBranchCleanupReservations(repoRoot: string, config: GuardianConfig | RecordLike): Promise<readonly RemoteBranchCleanupSafetyRefReservation[]> {
  const state = await readState(await getGuardianPaths(repoRoot), { repoRoot, config });
  return reservations(state.remote_branch_cleanup_reservations);
}

async function hasMatchingRemoteBranchCleanupReservation(input: RemoteBranchCleanupSafetyRefReservationInput, expected: RemoteBranchCleanupSafetyRefReservation): Promise<boolean> {
  return (await remoteBranchCleanupReservations(input.repoRoot, input.config)).some((current) => matches(current, expected));
}

async function recordRemoteBranchCleanupReservation(input: RemoteBranchCleanupSafetyRefReservationInput, expected: RemoteBranchCleanupSafetyRefReservation): Promise<void> {
  await updateState(input.repoRoot, input.config, (state) => {
    const current = reservations(state.remote_branch_cleanup_reservations);
    const existing = current.find((entry) => sameRemoteBranch(entry, expected));
    if (existing) {
      if (existing.head !== expected.head || existing.safety_ref !== expected.safety_ref) throw new Error("remote branch already has a different safety-ref reservation");
      if (existing.phase !== expected.phase) throw new Error("remote branch reservation phase must advance through proof promotion");
      return state;
    }
    if (current.length >= MAX_REMOTE_BRANCH_CLEANUP_RESERVATIONS) throw new Error("remote branch cleanup safety-ref reservations reached their bounded limit");
    return { ...state, remote_branch_cleanup_reservations: [...current, expected] };
  }, { event: { type: "remote_branch_cleanup_safety_ref_reserved", remote: expected.remote, remote_branch: expected.remote_branch, head: expected.head, safety_ref: expected.safety_ref } });
}

export async function reserveRemoteBranchCleanupSafetyRef(input: RemoteBranchCleanupSafetyRefReservationInput): Promise<{ readonly disposition: "created" | "reused"; readonly reservation: RemoteBranchCleanupSafetyRefReservation }> {
  const active = reservation({ ...input, phase: "active" });
  const pending = reservation({ ...input, phase: "pending-proof" });
  const exists = await tryGit(input.repoRoot, ["show-ref", "--verify", "--quiet", input.safetyRef]);
  if (!exists.ok && (exists.error.gitExitCode !== 1 || exists.error.gitSignal)) throw exists.error;
  if (exists.ok) {
    if (await getSymbolicRefTarget(input.repoRoot, input.safetyRef) !== null) throw new Error("planned safety ref is symbolic");
    const existing = await getDirectRefCommitOrNull(input.repoRoot, input.safetyRef);
    if (existing !== input.head) throw new Error("planned safety ref does not directly resolve to the approved remote branch commit");
    if (await hasMatchingRemoteBranchCleanupReservation({ ...input, phase: "active" }, active)) return { disposition: "reused", reservation: active };
    if (!(await hasMatchingRemoteBranchCleanupReservation({ ...input, phase: "pending-proof" }, pending))) throw new Error("planned safety ref is not a recorded remote branch cleanup reservation");
    await promoteRemoteBranchCleanupSafetyRefReservation(input, pending, active);
    return { disposition: "created", reservation: active };
  }
  try {
    await recordRemoteBranchCleanupReservation({ ...input, phase: "pending-proof" }, pending);
  } catch (error) {
    throw new RemoteBranchCleanupSafetyRefReservationPersistenceError(input.safetyRef, error);
  }
  await createSafetyRef(input.repoRoot, { sessionId: "remote-branch-cleanup", branch: `${input.remote}/${input.remoteBranch}`, commit: input.head, ref: input.safetyRef });
  await promoteRemoteBranchCleanupSafetyRefReservation(input, pending, active);
  return { disposition: "created", reservation: active };
}

async function promoteRemoteBranchCleanupSafetyRefReservation(input: RemoteBranchCleanupSafetyRefReservationInput, pending: RemoteBranchCleanupSafetyRefReservation, active: RemoteBranchCleanupSafetyRefReservation): Promise<void> {
  await updateState(input.repoRoot, input.config, (state) => {
    const current = reservations(state.remote_branch_cleanup_reservations);
    if (!current.some((entry) => matches(entry, pending))) throw new Error("remote branch cleanup pending reservation changed before proof promotion");
    return { ...state, remote_branch_cleanup_reservations: current.map((entry) => matches(entry, pending) ? active : entry) };
  }, { event: { type: "remote_branch_cleanup_safety_ref_activated", remote: active.remote, remote_branch: active.remote_branch, head: active.head, safety_ref: active.safety_ref } });
}

export async function hasValidRemoteBranchCleanupSafetyRef(input: RemoteBranchCleanupSafetyRefReservationInput): Promise<boolean> {
  try {
    reservation(input);
    return (await getSymbolicRefTarget(input.repoRoot, input.safetyRef)) === null
      && (await getDirectRefCommitOrNull(input.repoRoot, input.safetyRef)) === input.head;
  } catch {
    return false;
  }
}

export async function hasNoRemoteBranchCleanupSafetyRef(input: RemoteBranchCleanupSafetyRefReservationInput): Promise<boolean> {
  const exists = await tryGit(input.repoRoot, ["show-ref", "--verify", "--quiet", input.safetyRef]);
  if (exists.ok) return false;
  if (exists.error.gitExitCode === 1 && !exists.error.gitSignal) return true;
  throw exists.error;
}

export async function completeRemoteBranchCleanupSafetyRefReservation(input: RemoteBranchCleanupSafetyRefReservationInput): Promise<void> {
  const expected = reservation({ ...input, phase: "active" });
  await updateState(input.repoRoot, input.config, (state) => {
    const current = reservations(state.remote_branch_cleanup_reservations);
    if (!current.some((entry) => matches(entry, expected))) throw new Error("remote branch cleanup safety-ref reservation changed before completion");
    return { ...state, remote_branch_cleanup_reservations: current.filter((entry) => !matches(entry, expected)) };
  }, { event: { type: "remote_branch_cleanup_safety_ref_completed", remote: expected.remote, remote_branch: expected.remote_branch, head: expected.head, safety_ref: expected.safety_ref } });
}

export type RemoteBranchCleanupReservationRetirementInput = RemoteBranchCleanupSafetyRefReservationInput & {
  readonly observedHead: string;
};

export async function retireRemoteBranchCleanupSafetyRefReservation(input: RemoteBranchCleanupReservationRetirementInput): Promise<void> {
  const expected = reservation({ ...input, phase: "active" });
  if (input.observedHead === input.head) throw new Error("remote branch cleanup reservation is not advanced");
  if (!(await hasValidRemoteBranchCleanupSafetyRef(input))) throw new Error("planned safety ref is not valid Guardian remote cleanup evidence");
  await updateState(input.repoRoot, input.config, (state) => {
    const current = reservations(state.remote_branch_cleanup_reservations);
    if (!current.some((entry) => matches(entry, expected))) throw new Error("remote branch cleanup safety-ref reservation changed before retirement");
    return { ...state, remote_branch_cleanup_reservations: current.filter((entry) => !matches(entry, expected)) };
  }, { event: { type: "remote_branch_cleanup_safety_ref_retired", remote: expected.remote, remote_branch: expected.remote_branch, head: expected.head, safety_ref: expected.safety_ref, observed_head: input.observedHead } });
}

export async function retirePendingRemoteBranchCleanupSafetyRefReservation(input: RemoteBranchCleanupReservationRetirementInput): Promise<void> {
  const expected = reservation({ ...input, phase: "pending-proof" });
  if (input.observedHead === input.head) throw new Error("remote branch cleanup reservation is not advanced");
  if (!(await hasNoRemoteBranchCleanupSafetyRef(input))) throw new Error("remote branch cleanup pending reservation gained safety-ref evidence before retirement");
  await updateState(input.repoRoot, input.config, (state) => {
    const current = reservations(state.remote_branch_cleanup_reservations);
    if (!current.some((entry) => matches(entry, expected))) throw new Error("remote branch cleanup pending reservation changed before retirement");
    return { ...state, remote_branch_cleanup_reservations: current.filter((entry) => !matches(entry, expected)) };
  }, { event: { type: "remote_branch_cleanup_pending_reservation_retired", remote: expected.remote, remote_branch: expected.remote_branch, head: expected.head, safety_ref: expected.safety_ref, observed_head: input.observedHead } });
}
