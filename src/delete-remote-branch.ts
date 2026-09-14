import crypto from "node:crypto";
import { configForResolvedBase, resolveBaseRef } from "./done-base-ref.ts";
import { loadConfig } from "./config.ts";
import { buildSafetyRef, deleteAbsentRemoteBranchAtExpectedAbsence, deleteRemoteBranchAtExpectedHead, fetchRemotePrune, getRefCommit, getRefCommitOrNull, getRepoRoot, isAncestor, remoteTrackingRef } from "./git.ts";
import { isReservedCleanupBranch } from "./workflow-candidates.ts";
import { completeRemoteBranchCleanupSafetyRefReservation, hasValidRemoteBranchCleanupSafetyRef, remoteBranchCleanupReservations, reserveRemoteBranchCleanupSafetyRef } from "./state-remote-branch-reservation.ts";

function blocked(reason: string, preflight: Record<string, unknown>): Record<string, unknown> {
  return { ok: false, status: "blocked", reason, preflight };
}

function requiredString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function confirmToken(preflight: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    repoRoot: preflight.repoRoot,
    remote: preflight.remote,
    baseRef: preflight.baseRef,
    baseRefOid: preflight.baseRefOid,
    remoteBranch: preflight.remoteBranch,
    expectedRemoteHead: preflight.expectedRemoteHead,
    observedRemoteHead: preflight.observedRemoteHead,
    ancestryProven: preflight.ancestryProven,
    allowNonAncestorRemoteDeletion: preflight.allowNonAncestorRemoteDeletion,
    safetyRef: preflight.safetyRef,
  })).digest("hex");
}

export async function guardianDeleteRemoteBranch(input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const mode = input.mode ?? "plan";
  const remote = requiredString(input, "remote");
  const remoteBranch = requiredString(input, "remoteBranch");
  const expectedRemoteHead = requiredString(input, "expectedRemoteHead");
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const preflight: Record<string, unknown> = {
    repoRoot,
    mode,
    remote,
    remoteBranch,
    expectedRemoteHead,
    observedRemoteHead: null,
    baseRef: null,
    baseRefOid: null,
    ancestryProven: null,
    remoteBranchAbsent: false,
    reconciliationAuthorized: false,
    allowNonAncestorRemoteDeletion: input.allowNonAncestorRemoteDeletion === true,
    safetyRef: null,
  };
  if (mode !== "plan" && mode !== "apply") return blocked("mode must be plan or apply", preflight);
  if (!remote || !remoteBranch || !expectedRemoteHead) return blocked("remote, remoteBranch, and expectedRemoteHead must be exact non-empty strings", preflight);
  if (mode === "apply" && input.confirm !== true) return blocked("guardian_delete_remote_branch apply requires confirm=true", preflight);

  const { config } = await loadConfig(repoRoot);
  const resolvedBase = await resolveBaseRef(repoRoot, config);
  const effectiveConfig = configForResolvedBase(config, resolvedBase);
  preflight.baseRef = resolvedBase.authorityRef;
  if (remote !== effectiveConfig.remote) return blocked("remote must exactly match the resolved Guardian remote authority", preflight);
  if (remoteBranch === effectiveConfig.baseBranch || (effectiveConfig.protectedBranches as string[]).includes(remoteBranch) || isReservedCleanupBranch(remoteBranch)) {
    return blocked("protected or reserved remote branches cannot be deleted", preflight);
  }

  preflight.safetyRef = buildSafetyRef("remote-branch-cleanup", `${remote}/${remoteBranch}`, input.timestamp ?? expectedRemoteHead);
  const safetyRef = String(preflight.safetyRef);
  const reservationInput = { repoRoot, config: effectiveConfig, remote, remoteBranch, head: expectedRemoteHead, safetyRef };
  try {
    await fetchRemotePrune(repoRoot, remote);
    preflight.baseRefOid = await getRefCommit(repoRoot, resolvedBase.authorityRef);
    preflight.observedRemoteHead = await getRefCommitOrNull(repoRoot, remoteTrackingRef(remote, remoteBranch));
  } catch (error) {
    return blocked(error instanceof Error ? error.message : String(error), preflight);
  }
  if (preflight.observedRemoteHead === null) {
    const exactReservation = (await remoteBranchCleanupReservations(repoRoot, effectiveConfig)).some((reservation) => reservation.remote === remote
      && reservation.remote_branch === remoteBranch
      && reservation.head === expectedRemoteHead
      && reservation.safety_ref === safetyRef
      && (reservation.phase ?? "active") === "active");
    if (!exactReservation || !(await hasValidRemoteBranchCleanupSafetyRef(reservationInput))) {
      return blocked("absent remote branch requires an exact durable Guardian safety-ref reservation", preflight);
    }
    preflight.remoteBranchAbsent = true;
    preflight.reconciliationAuthorized = true;
  } else if (preflight.observedRemoteHead !== expectedRemoteHead) return blocked("remote branch head no longer matches expectedRemoteHead", preflight);

  try {
    preflight.ancestryProven = await isAncestor(repoRoot, expectedRemoteHead, resolvedBase.authorityRef);
  } catch (error) {
    return blocked(error instanceof Error ? error.message : String(error), preflight);
  }
  if (preflight.ancestryProven !== true && input.allowNonAncestorRemoteDeletion !== true) {
    return blocked("nonancestor remote deletion requires allowNonAncestorRemoteDeletion=true", preflight);
  }
  const token = confirmToken(preflight);
  if (mode === "plan") return { ok: true, status: "planned", confirmToken: token, preflight };
  if (input.confirmToken !== token) return blocked("confirm token mismatch; re-run mode=plan and use the returned confirmToken", preflight);

  try {
    await reserveRemoteBranchCleanupSafetyRef(reservationInput);
    if (preflight.remoteBranchAbsent === true) {
      await deleteAbsentRemoteBranchAtExpectedAbsence(repoRoot, remote, remoteBranch);
    } else {
      try {
        await deleteRemoteBranchAtExpectedHead(repoRoot, remote, remoteBranch, expectedRemoteHead);
      } catch (error) {
        try {
          await fetchRemotePrune(repoRoot, remote);
          const observedRemoteHead = await getRefCommitOrNull(repoRoot, remoteTrackingRef(remote, remoteBranch));
          if (observedRemoteHead !== null && observedRemoteHead !== expectedRemoteHead) {
            return { ok: false, status: "blocked", reason: "remote branch head changed before the leased deletion could complete", remote, remoteBranch, expectedRemoteHead, observedRemoteHead, safetyRef, preflight };
          }
          return { ok: false, status: "indeterminate", reason: error instanceof Error ? error.message : String(error), remote, remoteBranch, expectedRemoteHead, observedRemoteHead, remoteBranchDeleted: null, safetyRef, preflight, recoveryRequired: true };
        } catch {
          return { ok: false, status: "indeterminate", reason: error instanceof Error ? error.message : String(error), remote, remoteBranch, expectedRemoteHead, remoteBranchDeleted: null, safetyRef, preflight, recoveryRequired: true };
        }
      }
      try {
        await fetchRemotePrune(repoRoot, remote);
        const observedRemoteHead = await getRefCommitOrNull(repoRoot, remoteTrackingRef(remote, remoteBranch));
        if (observedRemoteHead !== null) {
          return { ok: false, status: "indeterminate", reason: "remote branch remains observable after deletion push", remote, remoteBranch, expectedRemoteHead, observedRemoteHead, remoteBranchDeleted: null, safetyRef, preflight, recoveryRequired: true };
        }
      } catch (error) {
        return { ok: false, status: "indeterminate", reason: error instanceof Error ? error.message : String(error), remote, remoteBranch, expectedRemoteHead, remoteBranchDeleted: null, safetyRef, preflight, recoveryRequired: true };
      }
    }
    try {
      await completeRemoteBranchCleanupSafetyRefReservation(reservationInput);
    } catch (error) {
      const remoteBranchDeleted = preflight.remoteBranchAbsent !== true;
      return { ok: false, status: remoteBranchDeleted ? "deleted-pending-reconciliation" : "reconciliation-pending", reason: error instanceof Error ? error.message : String(error), remote, remoteBranch, expectedRemoteHead, remoteBranchDeleted, remoteBranchReconciled: preflight.remoteBranchAbsent === true, safetyRef, preflight, recoveryRequired: true };
    }
    return preflight.remoteBranchAbsent === true
      ? { ok: true, status: "reconciled", remote, remoteBranch, expectedRemoteHead, remoteBranchDeleted: false, remoteBranchReconciled: true, safetyRef, preflight }
      : { ok: true, status: "deleted", remote, remoteBranch, expectedRemoteHead, remoteBranchDeleted: true, safetyRef, preflight };
  } catch (error) {
    return { ok: false, status: "blocked", reason: error instanceof Error ? error.message : String(error), remote, remoteBranch, expectedRemoteHead, safetyRef, preflight };
  }
}
