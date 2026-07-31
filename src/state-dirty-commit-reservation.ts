import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createSafetyRef, getRefCommitOrNull, readEffectiveGitConfig, runGit, runGitNullSeparated } from "./git.ts";
import { getGuardianPaths, readState, updateState } from "./state.ts";
import type { GuardianConfig, DirtyCommitSafetyRefReservation } from "./types.ts";

export type DirtyCommitSafetyRefReservationInput = {
  readonly repoRoot: string;
  readonly sessionId: string;
  readonly config: GuardianConfig;
  readonly timestamp: unknown;
  readonly confirmToken: unknown;
  readonly branch: string;
  readonly expectedHead: string;
  readonly safetyRef: string;
};

type SafetyRefEvent = { readonly safetyRef: string; readonly expectedHead: string };

export async function dirtyCommitPolicyBlocker(cwd: string, dirtyFiles: readonly string[]): Promise<string | null> {
  const signing = await readEffectiveGitConfig(cwd, "commit.gpgSign", { booleanValue: true });
  if (signing === "true") return "Guardian plumbing commits cannot bypass configured commit signing policy";
  const configuredHooks = await readEffectiveGitConfig(cwd, "core.hooksPath", { pathValue: true });
  const hooksPath = configuredHooks
    ? path.resolve(cwd, configuredHooks)
    : (await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"])).stdout;
  for (const hook of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) {
    const executable = await fs.access(path.join(hooksPath, hook), constants.X_OK).then(() => true, () => false);
    if (executable) return `Guardian plumbing commits cannot bypass executable commit hook ${hook}`;
  }
  if (dirtyFiles.length === 0) return null;
  const attributes = await runGitNullSeparated(cwd, ["check-attr", "-z", "filter", "--", ...dirtyFiles]);
  for (let index = 0; index + 2 < attributes.length; index += 3) {
    const value = attributes[index + 2];
    if (value !== "unspecified" && value !== "unset") return `Guardian planning refuses configured clean filter ${value}`;
  }
  return null;
}

export class SafetyRefReservationPersistenceError extends Error {
  readonly safetyRef: string;

  constructor(safetyRef: string, cause: unknown) {
    super("dirty-commit safety-ref reservation could not be persisted", { cause });
    this.name = "SafetyRefReservationPersistenceError";
    this.safetyRef = safetyRef;
  }
}

function reservation(input: DirtyCommitSafetyRefReservationInput): DirtyCommitSafetyRefReservation {
  if (typeof input.confirmToken !== "string" || input.confirmToken.length === 0) throw new Error("dirty-commit safety-ref reservation requires the approved confirm token");
  return { session_id: input.sessionId, branch: input.branch, expected_head: input.expectedHead, safety_ref: input.safetyRef, confirm_token: input.confirmToken, reserved_at: new Date().toISOString() };
}

function matches(actual: DirtyCommitSafetyRefReservation | undefined, expected: DirtyCommitSafetyRefReservation): boolean {
  return actual?.session_id === expected.session_id
    && actual.branch === expected.branch
    && actual.expected_head === expected.expected_head
    && actual.safety_ref === expected.safety_ref
    && actual.confirm_token === expected.confirm_token;
}

export async function hasMatchingDirtyCommitSafetyRefReservation(repoRoot: string, config: GuardianConfig, reservation: DirtyCommitSafetyRefReservation): Promise<boolean> {
  const state = await readState(await getGuardianPaths(repoRoot), { repoRoot, config });
  const session = state.sessions[reservation.session_id];
  return session?.status === "active" && session.branch === reservation.branch && matches(session.dirty_commit_safety_ref_reservation, reservation);
}

export async function recordDirtyCommitSafetyRefReservation(repoRoot: string, config: GuardianConfig, reservation: DirtyCommitSafetyRefReservation): Promise<void> {
  await updateState(repoRoot, config, (state) => {
    const session = state.sessions[reservation.session_id];
    if (!session || session.status !== "active" || session.branch !== reservation.branch) throw new Error("active Guardian session does not own the planned safety ref");
    if (session.dirty_commit_safety_ref_reservation && !matches(session.dirty_commit_safety_ref_reservation, reservation)) throw new Error("active Guardian session already has a different dirty-commit safety-ref reservation");
    state.sessions[reservation.session_id] = { ...session, safety_refs: [...new Set([...(session.safety_refs ?? []), reservation.safety_ref])], dirty_commit_safety_ref_reservation: reservation };
    return state;
  }, { event: { type: "dirty_commit_safety_ref_reserved", session_id: reservation.session_id, safety_ref: reservation.safety_ref } });
}

export async function reserveDirtyCommitSafetyRef(input: DirtyCommitSafetyRefReservationInput, hooks: { readonly afterValidated?: (event: SafetyRefEvent) => Promise<void>; readonly afterCreated?: (event: SafetyRefEvent) => Promise<void> } | undefined): Promise<{ readonly disposition: "created" | "reused"; readonly reservation: DirtyCommitSafetyRefReservation }> {
  const planned = reservation(input);
  const existing = await getRefCommitOrNull(input.repoRoot, input.safetyRef);
  if (existing !== null) {
    if (existing !== input.expectedHead) throw new Error("planned safety ref does not resolve to the approved head");
    if (!(await hasMatchingDirtyCommitSafetyRefReservation(input.repoRoot, input.config, planned))) throw new Error("planned safety ref is not an active session reservation");
    return { disposition: "reused", reservation: planned };
  }
  const event = { safetyRef: input.safetyRef, expectedHead: input.expectedHead };
  await hooks?.afterValidated?.(event);
  await createSafetyRef(input.repoRoot, { sessionId: input.sessionId, branch: input.branch, commit: input.expectedHead, timestamp: input.timestamp, ref: input.safetyRef });
  try {
    await recordDirtyCommitSafetyRefReservation(input.repoRoot, input.config, planned);
  } catch (error) {
    throw new SafetyRefReservationPersistenceError(input.safetyRef, error);
  }
  await hooks?.afterCreated?.(event);
  return { disposition: "created", reservation: planned };
}

export async function completeDirtyCommitSafetyRefReservation(repoRoot: string, config: GuardianConfig, reservation: DirtyCommitSafetyRefReservation, newHead: string): Promise<void> {
  await updateState(repoRoot, config, (state) => {
    const session = state.sessions[reservation.session_id];
    if (!session || session.status !== "active" || session.branch !== reservation.branch || !matches(session.dirty_commit_safety_ref_reservation, reservation)) throw new Error("dirty-commit safety-ref reservation changed before completion");
    const { dirty_commit_safety_ref_reservation: _reservation, ...completedSession } = session;
    state.sessions[reservation.session_id] = { ...completedSession, head_commit: newHead };
    return state;
  }, { event: { type: "dirty_commit_safety_ref_completed", session_id: reservation.session_id, safety_ref: reservation.safety_ref, head: newHead } });
}
