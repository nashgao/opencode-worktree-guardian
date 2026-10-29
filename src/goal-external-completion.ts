import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, normalizeConfig } from "./config.ts";
import { configForResolvedBase, resolveBaseRef } from "./done-base-ref.ts";
import { deleteRemoteBranchWithConfig } from "./delete-remote-branch.ts";
import { buildSafetyRef, deleteAbsentRemoteBranchAtExpectedAbsence, fetchMissingRemoteCommits, fetchRemotePrune, getDirectRefCommitOrNull, getRefCommit, getRefCommitOrNull, getRepoRoot, isAncestor, listWorktrees, observeRemoteBranchHeads, runGit, validateGitRef } from "./git.ts";
import { createGoalConfirmToken } from "./goal-confirm-token.ts";
import { getGuardianPaths, readState, updateState, withStateTransaction } from "./state.ts";
import { completeRemoteBranchCleanupSafetyRefReservation, remoteBranchCleanupReservations, reserveRemoteBranchCleanupSafetyRef } from "./state-remote-branch-reservation.ts";
import { errorCode, isRecordLike } from "./types.ts";
import type { GuardianSession, GuardianStateRecord, GuardianToolInput, GuardianToolResult, RecordLike } from "./types.ts";
import type { NormalizedGuardianConfig } from "./normalized-config.ts";
import { isReservedCleanupBranch } from "./workflow-candidates.ts";
import { normalizeAllowedRemoteBranches } from "./final-postflight.ts";

export const REMOVED_SESSION_GOAL_ACTION = "complete-removed-session";
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REQUIRED_GOAL_FLAGS = ["commitDirty", "landToBase", "pushBase", "cleanupWorktrees", "cleanupBranches", "cleanupHygiene"] as const;
const RECEIPT_STRINGS = ["session_id", "branch", "worktree_path", "remote", "base_ref", "expected_remote_head", "landed_base_head", "started_head_commit", "observed_base_head", "goal_fingerprint", "safety_ref", "prepared_at"] as const;

type Receipt = {
  readonly version: 1;
  readonly phase: "prepared" | "complete";
  readonly session_id: string;
  readonly branch: string;
  readonly worktree_path: string;
  readonly remote: string;
  readonly base_ref: string;
  readonly expected_remote_head: string;
  readonly landed_base_head: string;
  readonly started_head_commit: string;
  readonly observed_base_head: string;
  readonly goal_fingerprint: string;
  readonly allow_nonancestor_remote_deletion: boolean;
  readonly safety_ref: string;
  readonly prepared_at: string;
  readonly completed_at?: string;
};

type Context = {
  readonly repoRoot: string;
  readonly config: NormalizedGuardianConfig;
  readonly sessionId: string;
  readonly session: GuardianSession;
  readonly branch: string;
  readonly worktreePath: string;
  readonly head: string;
  readonly landedBase: string;
  readonly baseline: string;
  readonly remote: string;
  readonly baseRef: string;
  readonly baseBranch: string;
  readonly baseHead: string;
  readonly observedHead: string | null;
  readonly safetyRef: string;
  readonly goalFingerprint: string;
  readonly allowNonAncestorRemoteDeletion: boolean;
  readonly receipt: Receipt | null;
  readonly remotePlan: RecordLike | null;
};

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function objectId(value: unknown, name: string): string {
  const result = requiredString(value, name);
  if (!OBJECT_ID.test(result)) throw new Error(`${name} must be an exact full commit OID`);
  return result;
}

function parseReceipt(value: unknown): Receipt | null {
  if (value === undefined) return null;
  if (!isRecordLike(value) || value.version !== 1 || value.phase !== "prepared" && value.phase !== "complete") throw new Error("external Goal receipt is invalid or unsupported");
  for (const key of RECEIPT_STRINGS) requiredString(value[key], `receipt.${key}`);
  for (const key of ["expected_remote_head", "landed_base_head", "started_head_commit", "observed_base_head"] as const) objectId(value[key], `receipt.${key}`);
  if (typeof value.allow_nonancestor_remote_deletion !== "boolean") throw new Error("receipt deletion options are invalid");
  if (value.phase === "complete") requiredString(value.completed_at, "receipt.completed_at");
  return value as Receipt;
}

async function requireAbsentTargets(context: Pick<Context, "repoRoot" | "branch" | "worktreePath">): Promise<void> {
  try {
    await fs.lstat(context.worktreePath);
    throw new Error("recorded worktree path exists or was recreated");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (await getRefCommitOrNull(context.repoRoot, `refs/heads/${context.branch}`) !== null) throw new Error("recorded local branch exists or was recreated");
  const registered = await listWorktrees(context.repoRoot);
  if (registered.some((entry) => path.resolve(entry.path) === context.worktreePath)) throw new Error("recorded worktree remains registered in Git");
}

async function requireSafetyRef(context: Pick<Context, "repoRoot" | "safetyRef" | "head">): Promise<void> {
  if (await getDirectRefCommitOrNull(context.repoRoot, context.safetyRef) !== context.head) throw new Error("owned completion safety ref is missing or changed");
}

function requireUncontestedSession(state: GuardianStateRecord, sessionId: string, branch: string, worktreePath: string): void {
  for (const [id, other] of Object.entries(state.sessions)) {
    if (id !== sessionId && other.status === "active" && (other.branch === branch || other.worktree_path === worktreePath)) throw new Error("another active session owns the recorded branch or path");
  }
}

function requireCurrentSession(state: GuardianStateRecord, context: Context, expectedSession: string): GuardianSession {
  const current = state.sessions[context.sessionId];
  if (!current || JSON.stringify(current) !== expectedSession) throw new Error("selected session changed before scoped completion");
  requireUncontestedSession(state, context.sessionId, context.branch, context.worktreePath);
  return current;
}

function receiptMatches(receipt: Receipt, context: Omit<Context, "receipt" | "remotePlan" | "observedHead">): boolean {
  return receipt.session_id === context.sessionId && receipt.branch === context.branch
    && receipt.worktree_path === context.worktreePath && receipt.remote === context.remote && receipt.base_ref === context.baseRef
    && receipt.expected_remote_head === context.head && receipt.landed_base_head === context.landedBase
    && receipt.started_head_commit === context.baseline && receipt.safety_ref === context.safetyRef
    && receipt.goal_fingerprint === context.goalFingerprint && receipt.allow_nonancestor_remote_deletion === context.allowNonAncestorRemoteDeletion;
}

async function contextFor(input: GuardianToolInput): Promise<Context> {
  const requestedRoot = typeof input.repoRoot === "string" ? input.repoRoot : typeof input.cwd === "string" ? input.cwd : process.cwd();
  const repoRoot = await getRepoRoot(requestedRoot);
  if (input.config != null && !isRecordLike(input.config)) throw new Error("config must be an object");
  const storedConfig = (await loadConfig(repoRoot)).config;
  const config = isRecordLike(input.config) ? normalizeConfig(input.config) : storedConfig;
  if (REQUIRED_GOAL_FLAGS.some((key) => config.goal[key] !== true) || config.goal.hygieneCompletion !== "no-unprotected-residue" || config.goal.quarantineSessionResidue) throw new Error("removed-session completion requires the full strict session Goal preset without repository-wide quarantine");
  if (input.all === true || input.primary === true || input.intentionalPaths !== undefined) throw new Error("removed-session completion accepts only one explicit recorded session");
  const sessionId = requiredString(input.sessionId, "sessionId");
  const head = objectId(input.expectedRemoteHead, "expectedRemoteHead");
  const landedBase = objectId(input.landedBaseHead, "landedBaseHead");
  const state = await readState(await getGuardianPaths(repoRoot), { repoRoot, config });
  const session = state.sessions[sessionId];
  if (!session) throw new Error("unknown recorded session");
  if (session.session_id !== undefined && session.session_id !== sessionId || session.sessionId !== undefined && session.sessionId !== sessionId) throw new Error("recorded session identity mismatch");
  const branch = requiredString(session.branch, "recorded branch");
  if (normalizeAllowedRemoteBranches(input.allowedRemoteBranches).includes(branch)) throw new Error("recorded source branch is explicitly retained; scoped cleanup cannot delete it");
  if (session.base_ref !== `${config.remote}/${config.baseBranch}`) throw new Error("Goal authority does not match the session's recorded base");
  if (branch === storedConfig.baseBranch || storedConfig.protectedBranches.includes(branch)) throw new Error("recorded source branch is protected by repository policy");
  const worktreePath = requiredString(session.worktree_path, "recorded worktree path");
  if (!path.isAbsolute(worktreePath) || path.resolve(worktreePath) !== worktreePath || path.resolve(repoRoot) === worktreePath) throw new Error("recorded target must be an exact non-primary worktree path");
  for (const [key, actual] of [["branch", branch], ["remoteBranch", branch], ["worktreePath", worktreePath], ["targetPath", worktreePath]] as const) {
    if (input[key] !== undefined && input[key] !== actual) throw new Error(`${key} does not match the recorded session`);
  }
  requireUncontestedSession(state, sessionId, branch, worktreePath);
  validateGitRef(branch);
  const baseline = objectId(session.started_head_commit, "recorded immutable baseline");
  const receipt = parseReceipt(session.external_goal_completion);
  if (receipt?.phase === "complete" ? session.status !== "deleted" : session.status !== "active") throw new Error("recorded session status does not match its completion phase");
  const resolvedBase = await resolveBaseRef(repoRoot, config);
  const effective = configForResolvedBase(config, resolvedBase);
  const remote = requiredString(effective.remote, "effective remote");
  const baseBranch = requiredString(effective.baseBranch, "effective base branch");
  if (input.remote !== undefined && input.remote !== remote) throw new Error("remote does not match the effective authority");
  if (branch === effective.baseBranch || effective.protectedBranches.includes(branch) || isReservedCleanupBranch(branch)) throw new Error("protected or reserved session branch cannot be completed");
  await requireAbsentTargets({ repoRoot, branch, worktreePath });
  await fetchRemotePrune(repoRoot, remote);
  const heads = await observeRemoteBranchHeads(repoRoot, remote, [baseBranch, branch]);
  const baseHead = requiredString(heads.get(baseBranch), "fresh authoritative base head");
  const observedHead = heads.get(branch) ?? null;
  if (observedHead !== null && observedHead !== head) throw new Error("published remote head changed from expectedRemoteHead");
  if (observedHead === null && !receipt) throw new Error("absent published branch requires an existing owned completion receipt");
  await fetchMissingRemoteCommits(repoRoot, remote, [baseHead, head, landedBase]);
  if (await getRefCommit(repoRoot, head) !== head || await getRefCommit(repoRoot, landedBase) !== landedBase || !await isAncestor(repoRoot, baseline, head)) throw new Error("published head does not preserve the recorded original baseline");
  const headTree = (await runGit(repoRoot, ["rev-parse", `${head}^{tree}`])).stdout;
  const baseTree = (await runGit(repoRoot, ["rev-parse", `${landedBase}^{tree}`])).stdout;
  if (headTree !== baseTree || !await isAncestor(repoRoot, landedBase, baseHead)) throw new Error("published tree is not delivered on the fresh authoritative base history");
  const goalFingerprint = crypto.createHash("sha256").update(JSON.stringify(config.goal)).digest("hex");
  const safetyRef = buildSafetyRef("remote-branch-cleanup", `${remote}/${branch}`, head);
  const allowNonAncestorRemoteDeletion = input.allowNonAncestorRemoteDeletion === true;
  const context = { repoRoot, config, sessionId, session, branch, worktreePath, head, landedBase, baseline, remote, baseRef: resolvedBase.authorityRef, baseBranch, baseHead, safetyRef, goalFingerprint, allowNonAncestorRemoteDeletion };
  if (receipt && (!receiptMatches(receipt, context) || !await isAncestor(repoRoot, receipt.observed_base_head, baseHead))) throw new Error("completion receipt identity, options, or base proof changed");
  if (receipt?.phase === "complete" || observedHead === null) {
    if (!receipt || observedHead !== null) throw new Error("absent published branch requires an existing owned completion receipt");
    await requireSafetyRef(context);
    await requireAbsentTargets(context);
    return { ...context, observedHead, receipt, remotePlan: null };
  }
  if (observedHead !== head) throw new Error("published remote head changed from expectedRemoteHead");
  if (receipt) {
    const existingRef = await getRefCommitOrNull(repoRoot, safetyRef);
    if (existingRef !== null) await requireSafetyRef(context);
  } else if (await getRefCommitOrNull(repoRoot, safetyRef) !== null) {
    const reservations = await remoteBranchCleanupReservations(repoRoot, config);
    if (!reservations.some((entry) => entry.remote === remote && entry.remote_branch === branch && entry.head === head && entry.safety_ref === safetyRef)) throw new Error("existing safety ref is not a recorded owned cleanup reservation");
    await requireSafetyRef(context);
  }
  const remotePlan = await deleteRemoteBranchWithConfig({ repoRoot, cwd: repoRoot, mode: "plan", remote, remoteBranch: branch, expectedRemoteHead: head, allowNonAncestorRemoteDeletion: input.allowNonAncestorRemoteDeletion === true }, config);
  if (remotePlan.ok !== true) throw new Error(typeof remotePlan.reason === "string" ? remotePlan.reason : "owned remote cleanup plan is blocked");
  if (!isRecordLike(remotePlan.preflight) || remotePlan.preflight.baseRefOid !== baseHead || remotePlan.preflight.safetyRef !== safetyRef) throw new Error("remote cleanup authority changed while planning");
  await requireAbsentTargets(context);
  return { ...context, observedHead, receipt, remotePlan };
}

function planFor(context: Context): RecordLike {
  const complete = context.receipt?.phase === "complete";
  const proof = {
    sessionId: context.sessionId, session: context.session, expectedRemoteHead: context.head,
    landedBaseHead: context.landedBase, baseRef: context.baseRef, observedBaseHead: context.baseHead,
    observedRemoteHead: context.observedHead, safetyRef: context.safetyRef,
    worktreeAbsent: true, localBranchAbsent: true,
  };
  const steps = [{ tool: "guardian_goal", ok: true, status: "verified", result: proof }, ...(context.remotePlan ? [{ tool: "guardian_delete_remote_branch", ok: true, status: "planned", result: context.remotePlan }] : [])];
  const plan = {
    ok: true, complete: complete ? true : null, status: complete ? "complete" : "planned", lane: "goal",
    repoRoot: context.repoRoot, cwd: context.worktreePath,
    scope: { kind: "session", sessionId: context.sessionId }, intentionalPaths: [],
    trackedBaseline: { commit: context.baseline, source: "session-start" }, goal: context.config.goal,
    steps, blockers: [], completionProof: context.receipt,
    hygienePostcondition: { mode: context.config.goal.hygieneCompletion, phase: "plan", status: "satisfied", residualCount: 0, targetAbsent: true },
    externalDisposition: "Filesystem and ignored-file disposition were performed by the external operator; this action verifies committed delivery and current owned postconditions, not historical uncommitted contents.",
  };
  return { ...plan, confirmToken: createGoalConfirmToken(plan), nextAction: complete ? "verified session-scoped readback" : "guardian_goal action=complete-removed-session mode=apply confirm=true" };
}

async function requireFinalRemoteProof(context: Context): Promise<void> {
  const heads = await observeRemoteBranchHeads(context.repoRoot, context.remote, [context.baseBranch, context.branch]);
  if (heads.get(context.baseBranch) !== context.baseHead || heads.has(context.branch)) throw new Error("authoritative refs changed before scoped completion");
  await requireSafetyRef(context);
}

async function requireCurrentScope(context: Context, expectedSession: string): Promise<void> {
  const paths = await getGuardianPaths(context.repoRoot);
  await withStateTransaction(paths, async () => {
    const state = await readState(paths, { repoRoot: context.repoRoot, config: context.config });
    requireCurrentSession(state, context, expectedSession);
    if (context.receipt?.phase === "complete") await requireFinalRemoteProof(context);
    await requireAbsentTargets(context);
  }, { timeoutMs: context.config.lockTimeoutMs });
}

async function finishOwnedReservation(context: Context): Promise<void> {
  const entries = await remoteBranchCleanupReservations(context.repoRoot, context.config);
  const existing = entries.find((entry) => entry.remote === context.remote && entry.remote_branch === context.branch);
  if (!existing) return;
  if (existing.head !== context.head || existing.safety_ref !== context.safetyRef) throw new Error("owned cleanup reservation changed before reconciliation");
  const reservation = { repoRoot: context.repoRoot, config: context.config, remote: context.remote, remoteBranch: context.branch, head: context.head, safetyRef: context.safetyRef };
  await reserveRemoteBranchCleanupSafetyRef(reservation);
  await completeRemoteBranchCleanupSafetyRefReservation(reservation);
}

async function writeReceipt(context: Context, expectedSession: string, receipt: Receipt): Promise<GuardianSession> {
  const next = await updateState(context.repoRoot, context.config, async (state) => {
    const current = requireCurrentSession(state, context, expectedSession);
    if (receipt.phase === "complete") await requireFinalRemoteProof(context);
    await requireAbsentTargets(context);
    const now = new Date().toISOString();
    const refs = current.safety_refs ?? [];
    state.sessions[context.sessionId] = {
      ...current, external_goal_completion: receipt,
      state_version: (current.state_version ?? 0) + 1, updated_at: now,
      ...(receipt.phase === "complete" ? {
        status: "deleted", head_commit: context.head, deleted_worktree_path: context.worktreePath,
        deleted_branch: context.branch, safety_refs: refs.includes(context.safetyRef) ? refs : [...refs, context.safetyRef],
      } : {}),
    };
    return state;
  }, { event: { type: "guardian_goal_external_completion", session_id: context.sessionId, phase: receipt.phase, head: context.head, landed_base_head: context.landedBase, safety_ref: context.safetyRef } });
  const session = next.sessions[context.sessionId];
  if (!session) throw new Error("selected completion session is missing after receipt update");
  return session;
}

function blocked(input: GuardianToolInput, reason: string, prepared?: Receipt): GuardianToolResult {
  return {
    ok: false, complete: input.mode === "apply" ? false : null,
    status: prepared ? "partial" : "blocked", lane: "goal", reason,
    scope: { kind: "session", sessionId: typeof input.sessionId === "string" ? input.sessionId : "" },
    blockers: [{ tool: "guardian_goal", reason }],
    ...(prepared ? { recoveryRequired: true, completionProof: prepared } : {}),
  };
}

export async function completeRemovedSessionGoal(input: GuardianToolInput): Promise<GuardianToolResult> {
  const mode = input.mode ?? "plan";
  if (mode !== "plan" && mode !== "apply") return blocked(input, "mode must be plan or apply");
  if (mode === "apply" && input.confirm !== true) return blocked(input, "removed-session apply requires confirm=true");
  let prepared: Receipt | undefined;
  try {
    const context = await contextFor(input);
    if (context.receipt?.phase === "complete") await requireCurrentScope(context, JSON.stringify(context.session));
    const plan = planFor(context);
    if (mode === "plan") return plan;
    if (input.confirmToken !== plan.confirmToken) return blocked(input, "confirm token mismatch; the scoped plan changed, re-run mode=plan");
    if (context.receipt?.phase === "complete") return plan;
    const pendingReceipt: Receipt = context.receipt ?? {
      version: 1, phase: "prepared", session_id: context.sessionId, branch: context.branch,
      worktree_path: context.worktreePath, remote: context.remote, base_ref: context.baseRef, expected_remote_head: context.head,
      landed_base_head: context.landedBase, started_head_commit: context.baseline,
      observed_base_head: context.baseHead, goal_fingerprint: context.goalFingerprint,
      allow_nonancestor_remote_deletion: context.allowNonAncestorRemoteDeletion,
      safety_ref: context.safetyRef, prepared_at: new Date().toISOString(),
    };
    const pendingSession = context.receipt ? context.session : await writeReceipt(context, JSON.stringify(context.session), pendingReceipt);
    prepared = pendingReceipt;
    await requireCurrentScope(context, JSON.stringify(pendingSession));
    let remoteResult: RecordLike;
    if (context.remotePlan) {
      remoteResult = await deleteRemoteBranchWithConfig({ repoRoot: context.repoRoot, cwd: context.repoRoot, mode: "apply", confirm: true, confirmToken: context.remotePlan.confirmToken, remote: context.remote, remoteBranch: context.branch, expectedRemoteHead: context.head, allowNonAncestorRemoteDeletion: input.allowNonAncestorRemoteDeletion === true }, context.config);
      if (remoteResult.ok !== true) return { ...blocked(input, typeof remoteResult.reason === "string" ? remoteResult.reason : "owned remote cleanup needs reconciliation", prepared), steps: [{ tool: "guardian_delete_remote_branch", result: remoteResult }] };
    } else {
      await deleteAbsentRemoteBranchAtExpectedAbsence(context.repoRoot, context.remote, context.branch);
      await finishOwnedReservation(context);
      remoteResult = { ok: true, status: "reconciled", remote: context.remote, remoteBranch: context.branch, safetyRef: context.safetyRef };
    }
    await fetchRemotePrune(context.repoRoot, context.remote);
    await requireAbsentTargets(context);
    const receipt: Receipt = { ...prepared, phase: "complete", observed_base_head: context.baseHead, completed_at: new Date().toISOString() };
    await writeReceipt(context, JSON.stringify(pendingSession), receipt);
    return {
      ...plan, ok: true, complete: true, status: "complete", completionProof: receipt,
      steps: [{ tool: "guardian_delete_remote_branch", ok: true, status: String(remoteResult.status), result: remoteResult }],
      hygienePostcondition: { mode: context.config.goal.hygieneCompletion, phase: "apply", status: "satisfied", residualCount: 0, targetAbsent: true },
    };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return blocked(input, error.message, prepared);
  }
}
