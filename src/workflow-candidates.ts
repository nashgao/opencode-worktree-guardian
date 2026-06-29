import crypto from "node:crypto";
import path from "node:path";
import { expandWorktreeRoot } from "./config.ts";
import { guardianDeleteWorktree } from "./delete.ts";
import { getDirtyFiles, getRepoRoot, isAncestor, listBranches, listRemoteBranches, listWorktrees } from "./git.ts";

export const MAX_WORKFLOW_CLEANUP_CANDIDATES = 25;

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
  };
}

export function createWorkflowToken(preflight: Record<string, unknown>, candidates: readonly Record<string, unknown>[]): string {
  const material = {
    repoRoot: preflight.repoRoot,
    baseRef: preflight.baseRef,
    baseRefOid: preflight.baseRefOid,
    candidates: candidates.map(candidateTokenMaterial),
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

export function isGuardianWorktreeStatusPath(repoRoot: string, guardianRoot: string, statusPath: string): boolean {
  const absoluteStatusPath = path.resolve(repoRoot, statusPath.replace(/\/$/, ""));
  return isInside(absoluteStatusPath, guardianRoot);
}

export async function plannedCandidate(repoRoot: string, config: Record<string, unknown>, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const plan = await guardianDeleteWorktree({ repoRoot, cwd: repoRoot, mode: "plan", deleteBranch: true, allowMergedGuardianBranch: true, ancestryBaseRef: `${String(config.remote)}/${String(config.baseBranch)}`, config, ...input });
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

export async function discoverCandidates(repoRoot: string, cwd: string, config: Record<string, unknown>, preflight: Record<string, unknown>, allowIgnoredFiles = false, excludedBranches: readonly string[] = [], allowAbandonUnmerged = false): Promise<{ readonly candidates: Record<string, unknown>[]; readonly blockers: Record<string, unknown>[] }> {
  const baseRef = `${String(config.remote)}/${String(config.baseBranch)}`;
  const guardianRoot = path.resolve(repoRoot, expandWorktreeRoot(String(config.worktreeRoot), repoRoot));
  const currentWorktree = await getRepoRoot(cwd);
  const worktrees = await listWorktrees(repoRoot) as Array<{ path: string; branch?: string; head?: string }>;
  const checkedOutBranches = new Set(worktrees.map((worktree) => worktree.branch).filter(Boolean));
  const excludedBranchSet = new Set(excludedBranches.filter((branch) => branch.length > 0));
  const candidates: Record<string, unknown>[] = [];
  const blockers: Record<string, unknown>[] = [];
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
    if (!(await isAncestor(repoRoot, worktree.head, baseRef))) {
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
    if (branchPrefix.length === 0 || !branch.name.startsWith(branchPrefix)) continue;
    if (checkedOutBranches.has(branch.name)) continue;
    if ((config.protectedBranches as string[]).includes(branch.name)) continue;
    const ancestryProven = await isAncestor(repoRoot, branch.commit, baseRef);
    if (!ancestryProven && !allowAbandonUnmerged) continue;
    const candidate = await plannedCandidate(repoRoot, config, {
      branch: branch.name,
      allowIgnoredFiles,
      ...(ancestryProven ? {} : { abandonUnmerged: true, allowMergedGuardianBranch: false }),
    });
    if (candidate.ok) candidates.push({ kind: "branch", abandonUnmerged: !ancestryProven, ...candidate });
    else blockers.push({ kind: "branch", branch: branch.name, head: branch.commit, reason: candidate.reason, plan: candidate.plan });
  }

  const remote = String(config.remote);
  if (branchPrefix.length > 0) {
    const remoteBranches = await listRemoteBranches(repoRoot, remote);
    for (const remoteBranch of remoteBranches) {
      if (!remoteBranch.branch || !remoteBranch.commit) continue;
      if (!remoteBranch.branch.startsWith(branchPrefix)) continue;
      if (remoteBranch.branch === String(config.baseBranch)) continue;
      if (excludedBranchSet.has(remoteBranch.branch)) continue;
      if ((config.protectedBranches as string[]).includes(remoteBranch.branch)) continue;
      if (checkedOutBranches.has(remoteBranch.branch) && !cleanableCheckedOutBranches.has(remoteBranch.branch)) continue;
      if (!(await isAncestor(repoRoot, remoteBranch.commit, baseRef))) continue;
      candidates.push({ kind: "remote-branch", targetKind: "remote-branch", remote, remoteBranch: remoteBranch.branch, branch: remoteBranch.branch, head: remoteBranch.commit, localBranchExists: localBranches.has(remoteBranch.branch) });
    }
  }

  if (candidates.length > MAX_WORKFLOW_CLEANUP_CANDIDATES) {
    blockers.push({ kind: "candidate-bound", reason: `cleanup candidate count exceeds maximum ${MAX_WORKFLOW_CLEANUP_CANDIDATES}`, candidateCount: candidates.length, maxCandidateCount: MAX_WORKFLOW_CLEANUP_CANDIDATES });
  }

  preflight.candidateCount = candidates.length;
  preflight.blockerCount = blockers.length;
  preflight.maxCandidateCount = MAX_WORKFLOW_CLEANUP_CANDIDATES;
  return { candidates, blockers };
}
