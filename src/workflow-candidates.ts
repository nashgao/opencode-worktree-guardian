import crypto from "node:crypto";
import path from "node:path";
import { expandWorktreeRoot } from "./config.ts";
import { guardianDeleteWorktree } from "./delete.ts";
import { buildSafetyRef, getDirtyFiles, getRepoRoot, isAncestor, listBranches, listRemoteBranches, listWorktrees } from "./git.ts";
import { configuredRemoteAuthority } from "./git-authority.ts";
import { hasNoRemoteBranchCleanupSafetyRef, hasValidRemoteBranchCleanupSafetyRef, remoteBranchCleanupReservations } from "./state-remote-branch-reservation.ts";

const DEFAULT_MAX_WORKFLOW_CLEANUP_CANDIDATES = 25;

// Caps candidates per run only; per-target gates in guardianDeleteWorktree
// (dirty proof, ancestry, safety refs) still apply to every candidate.
function resolveMaxWorkflowCleanupCandidates(): number {
  const raw = Number(process.env.GUARDIAN_MAX_CLEANUP_CANDIDATES);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_WORKFLOW_CLEANUP_CANDIDATES;
}

export const MAX_WORKFLOW_CLEANUP_CANDIDATES = resolveMaxWorkflowCleanupCandidates();

const RESERVED_CLEANUP_BRANCH_PREFIXES = ["rescue/"] as const;

export function isReservedCleanupBranch(branch: string): boolean {
  return RESERVED_CLEANUP_BRANCH_PREFIXES.some((prefix) => branch.startsWith(prefix));
}

export function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

export function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function candidateTokenMaterial(candidate: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: candidate.kind,
    targetPath: candidate.targetPath ?? null,
    branch: candidate.branch ?? null,
    head: candidate.head ?? null,
    targetKind: candidate.targetKind ?? null,
    remote: candidate.remote ?? null,
    remoteBranch: candidate.remoteBranch ?? null,
    confirmToken: candidate.confirmToken ?? null,
    safetyRef: candidate.safetyRef ?? null,
    remoteBranchAbsent: candidate.remoteBranchAbsent === true,
    remoteAction: candidate.remoteAction ?? null,
    observedHead: candidate.observedHead ?? null,
    reservationPhase: candidate.reservationPhase ?? "none",
  };
}

export function createWorkflowToken(preflight: Record<string, unknown>, candidates: readonly Record<string, unknown>[], reservationRetirementCandidates: readonly Record<string, unknown>[] = []): string {
  const material = {
    repoRoot: preflight.repoRoot,
    baseRef: preflight.baseRef,
    baseRefOid: preflight.baseRefOid,
    allowIgnoredFiles: preflight.allowIgnoredFiles === true,
    candidates: candidates.map(candidateTokenMaterial),
    reservationRetirementCandidates: reservationRetirementCandidates.map(candidateTokenMaterial),
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

export function workflowApplyWorkCount(plan: Record<string, unknown>): number {
  const candidates = Array.isArray(plan.candidates) ? plan.candidates.length : 0;
  const retirements = Array.isArray(plan.reservationRetirementCandidates) ? plan.reservationRetirementCandidates.length : 0;
  return candidates + retirements;
}

export function isGuardianWorktreeStatusPath(repoRoot: string, guardianRoot: string, statusPath: string): boolean {
  const absoluteStatusPath = path.resolve(repoRoot, statusPath.replace(/\/$/, ""));
  return isInside(absoluteStatusPath, guardianRoot);
}

export async function plannedCandidate(repoRoot: string, config: Record<string, unknown>, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const plan = await guardianDeleteWorktree({ repoRoot, cwd: repoRoot, mode: "plan", deleteBranch: true, allowMergedGuardianBranch: true, config, ...input, ancestryBaseRef: configuredRemoteAuthority(config).authorityRef });
  if (!plan.ok) return { ok: false, reason: plan.reason, plan };
  const preflight = plan.preflight as Record<string, unknown>;
  return {
    ok: true,
    confirmToken: plan.confirmToken,
    targetKind: preflight.targetKind,
    targetPath: preflight.targetPath ?? null,
    branch: preflight.branch ?? null,
    head: preflight.head ?? null,
    ancestryProven: preflight.ancestryProven,
    plan,
  };
}

export async function discoverCandidates(repoRoot: string, cwd: string, config: Record<string, unknown>, preflight: Record<string, unknown>, allowIgnoredFiles = false, excludedBranches: readonly string[] = [], allowAbandonUnmerged = false, safetyRefStamp: unknown = preflight.baseRefOid): Promise<{ readonly candidates: Record<string, unknown>[]; readonly blockers: Record<string, unknown>[]; readonly reservationRetirementCandidates: Record<string, unknown>[] }> {
  const baseAuthorityRef = configuredRemoteAuthority(config).authorityRef;
  const guardianRoot = path.resolve(repoRoot, expandWorktreeRoot(String(config.worktreeRoot), repoRoot));
  const currentWorktree = await getRepoRoot(cwd);
  const worktrees = await listWorktrees(repoRoot) as Array<{ path: string; branch?: string; head?: string }>;
  const checkedOutBranches = new Set(worktrees.map((worktree) => worktree.branch).filter(Boolean));
  const excludedBranchSet = new Set(excludedBranches.filter((branch) => branch.length > 0));
  const candidates: Record<string, unknown>[] = [];
  const blockers: Record<string, unknown>[] = [];
  let reservationRetirementCandidates: Record<string, unknown>[] = [];
  const cleanableCheckedOutBranches = new Set<string>();

  for (const worktree of worktrees) {
    if (samePath(worktree.path, repoRoot) || samePath(worktree.path, currentWorktree)) continue;
    if (!isInside(path.resolve(worktree.path), guardianRoot)) continue;
    if (worktree.branch && excludedBranchSet.has(worktree.branch)) continue;
    if (!worktree.branch || !worktree.head) {
      blockers.push({ kind: "worktree", targetPath: worktree.path, branch: worktree.branch ?? null, head: worktree.head ?? null, reason: "detached Guardian worktree cannot be cleaned by finish workflow" });
      continue;
    }
    if ((config.protectedBranches as string[]).includes(worktree.branch)) {
      blockers.push({ kind: "worktree", targetPath: worktree.path, branch: worktree.branch, head: worktree.head, reason: "protected branch worktree cannot be cleaned by finish workflow" });
      continue;
    }
    const dirtyFiles = await getDirtyFiles(worktree.path);
    if (dirtyFiles.length > 0) {
      blockers.push({ kind: "worktree", targetPath: worktree.path, branch: worktree.branch, head: worktree.head, reason: "worktree has uncommitted changes", dirtyFileCount: dirtyFiles.length });
      continue;
    }
    if (!(await isAncestor(repoRoot, worktree.head, baseAuthorityRef))) {
      blockers.push({ kind: "worktree", targetPath: worktree.path, branch: worktree.branch, head: worktree.head, reason: "worktree branch is not proven reachable from base ref" });
      continue;
    }
    const candidate = await plannedCandidate(repoRoot, config, { targetPath: worktree.path, allowIgnoredFiles });
    if (candidate.ok) {
      cleanableCheckedOutBranches.add(worktree.branch);
      candidates.push({ kind: "worktree", ...candidate });
    } else blockers.push({ kind: "worktree", targetPath: worktree.path, branch: worktree.branch, reason: candidate.reason });
  }

  const branches = await listBranches(repoRoot) as Array<{ name: string; commit: string }>;
  const localBranches = new Set(branches.map((branch) => branch.name).filter(Boolean));
  const branchPrefix = typeof config.branchPrefix === "string" ? config.branchPrefix : "";
  for (const branch of branches) {
    if (!branch.name || !branch.commit) continue;
    if (branch.name === String(config.baseBranch)) continue;
    if (excludedBranchSet.has(branch.name)) continue;
    if (isReservedCleanupBranch(branch.name)) continue;
    if (checkedOutBranches.has(branch.name)) continue;
    if ((config.protectedBranches as string[]).includes(branch.name)) continue;
    const guardianPrefixed = branchPrefix.length > 0 && branch.name.startsWith(branchPrefix);
    const ancestryProven = await isAncestor(repoRoot, branch.commit, baseAuthorityRef);
    const abandonUnmergedBranch = guardianPrefixed && allowAbandonUnmerged;
    if (!ancestryProven && !abandonUnmergedBranch) continue;
    const candidate = await plannedCandidate(repoRoot, config, {
      branch: branch.name,
      allowIgnoredFiles,
      ...(ancestryProven ? {} : { abandonUnmerged: true, allowMergedGuardianBranch: false }),
    });
    if (candidate.ok) candidates.push({ kind: "branch", abandonUnmerged: !ancestryProven, ...candidate });
    else blockers.push({ kind: "branch", branch: branch.name, head: branch.commit, reason: candidate.reason, plan: candidate.plan });
  }

  const remote = String(config.remote);
  const remoteBranches = await listRemoteBranches(repoRoot, remote);
  const remoteReservations = (await remoteBranchCleanupReservations(repoRoot, config)).filter((reservation) => reservation.remote === remote);
  const reservedRemoteBranches = new Set<string>();
  for (const remoteBranch of remoteBranches) {
    if (!remoteBranch.branch || !remoteBranch.commit) continue;
    if (remoteBranch.branch === String(config.baseBranch)) continue;
    if (excludedBranchSet.has(remoteBranch.branch)) continue;
    if (isReservedCleanupBranch(remoteBranch.branch)) continue;
    if ((config.protectedBranches as string[]).includes(remoteBranch.branch)) continue;
    if (checkedOutBranches.has(remoteBranch.branch) && !cleanableCheckedOutBranches.has(remoteBranch.branch)) continue;
    const reservation = remoteReservations.find((entry) => entry.remote_branch === remoteBranch.branch);
    if (reservation && reservation.head !== remoteBranch.commit) {
      const reservationInput = { repoRoot, config, remote, remoteBranch: remoteBranch.branch, head: reservation.head, safetyRef: reservation.safety_ref };
      const phase = reservation.phase ?? "active";
      const pendingMayRetire = phase === "pending-proof"
        && await isAncestor(repoRoot, reservation.head, remoteBranch.commit)
        && await hasNoRemoteBranchCleanupSafetyRef(reservationInput);
      const activeMayRetire = phase === "active" && await hasValidRemoteBranchCleanupSafetyRef(reservationInput);
      if (pendingMayRetire || activeMayRetire) reservationRetirementCandidates.push({ kind: "remote-branch-reservation-retirement", targetKind: "remote-branch-reservation-retirement", remote, remoteBranch: remoteBranch.branch, branch: remoteBranch.branch, head: reservation.head, observedHead: remoteBranch.commit, safetyRef: reservation.safety_ref, reservationPhase: phase, remoteAction: "retire-advanced-reservation" });
      else blockers.push({ kind: "remote-branch", remote, remoteBranch: remoteBranch.branch, head: reservation.head, observedHead: remoteBranch.commit, safetyRef: reservation.safety_ref, reason: "advanced remote branch reservation lacks valid Guardian safety-ref evidence" });
      reservedRemoteBranches.add(remoteBranch.branch);
      continue;
    }
    if (!(await isAncestor(repoRoot, remoteBranch.commit, baseAuthorityRef))) continue;
    candidates.push({ kind: "remote-branch", targetKind: "remote-branch", remote, remoteBranch: remoteBranch.branch, branch: remoteBranch.branch, head: remoteBranch.commit, safetyRef: reservation?.safety_ref ?? buildSafetyRef("remote-branch-cleanup", `${remote}/${remoteBranch.branch}`, safetyRefStamp), reservationPhase: reservation?.phase ?? "none", remoteAction: "delete-remote-branch", localBranchExists: localBranches.has(remoteBranch.branch) });
    reservedRemoteBranches.add(remoteBranch.branch);
  }

  const retirementTotal = reservationRetirementCandidates.length;
  if (retirementTotal > MAX_WORKFLOW_CLEANUP_CANDIDATES) {
    const omitted = retirementTotal - MAX_WORKFLOW_CLEANUP_CANDIDATES;
    reservationRetirementCandidates = reservationRetirementCandidates.slice(0, MAX_WORKFLOW_CLEANUP_CANDIDATES);
    blockers.push({ kind: "reservation-retirement-bound", reason: `reservation retirement candidates exceed maximum ${MAX_WORKFLOW_CLEANUP_CANDIDATES}`, retirementCandidateCount: retirementTotal, retirementCandidateOmittedCount: omitted, maxCandidateCount: MAX_WORKFLOW_CLEANUP_CANDIDATES });
    preflight.reservationRetirementCandidateCount = retirementTotal;
    preflight.reservationRetirementCandidateOmittedCount = omitted;
  } else {
    preflight.reservationRetirementCandidateCount = retirementTotal;
    preflight.reservationRetirementCandidateOmittedCount = 0;
  }
  for (const reservation of remoteReservations) {
    if (reservedRemoteBranches.has(reservation.remote_branch)) continue;
    if (reservation.remote_branch === String(config.baseBranch) || excludedBranchSet.has(reservation.remote_branch) || isReservedCleanupBranch(reservation.remote_branch) || (config.protectedBranches as string[]).includes(reservation.remote_branch)) {
      blockers.push({ kind: "remote-branch", remote, remoteBranch: reservation.remote_branch, head: reservation.head, safetyRef: reservation.safety_ref, reason: "remote branch cleanup reservation is no longer eligible" });
      continue;
    }
    candidates.push({ kind: "remote-branch", targetKind: "remote-branch", remote, remoteBranch: reservation.remote_branch, branch: reservation.remote_branch, head: reservation.head, safetyRef: reservation.safety_ref, reservationPhase: reservation.phase ?? "active", remoteBranchAbsent: true, remoteAction: "reconcile-absent-remote-branch", localBranchExists: localBranches.has(reservation.remote_branch) });
  }

  if (candidates.length > MAX_WORKFLOW_CLEANUP_CANDIDATES) {
    blockers.push({ kind: "candidate-bound", reason: `cleanup candidate count exceeds maximum ${MAX_WORKFLOW_CLEANUP_CANDIDATES}`, candidateCount: candidates.length, maxCandidateCount: MAX_WORKFLOW_CLEANUP_CANDIDATES });
  }

  preflight.candidateCount = candidates.length;
  preflight.physicalCandidateCount = candidates.length;
  preflight.reservationRetirementApplyCount = reservationRetirementCandidates.length;
  preflight.applyWorkCount = candidates.length + reservationRetirementCandidates.length;
  preflight.blockerCount = blockers.length;
  preflight.maxCandidateCount = MAX_WORKFLOW_CLEANUP_CANDIDATES;
  return { candidates, blockers, reservationRetirementCandidates };
}
