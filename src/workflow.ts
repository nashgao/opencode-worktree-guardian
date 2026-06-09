import crypto from "node:crypto";
import path from "node:path";
import { expandWorktreeRoot, loadConfig } from "./config.ts";
import { guardianDeleteWorktree } from "./delete.ts";
import { fetchRemote, getCurrentBranch, getDirtyFiles, getRefCommit, getRepoRoot, isAncestor, listBranches, listStashes, listWorktrees } from "./git.ts";

const MAX_WORKFLOW_CLEANUP_CANDIDATES = 25;

function samePath(left: string, right: string) {
  return path.resolve(left) === path.resolve(right);
}

function isInside(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function blocked(reason: string, details: Record<string, unknown> = {}, preflight?: Record<string, unknown>) {
  if (preflight) preflight.blockers = [...((preflight.blockers as string[] | undefined) ?? []), reason];
  return { ok: false, status: "blocked", reason, ...details, ...(preflight ? { preflight } : {}) };
}

function candidateTokenMaterial(candidate: Record<string, unknown>) {
  return {
    kind: candidate.kind,
    targetPath: candidate.targetPath ?? null,
    branch: candidate.branch ?? null,
    head: candidate.head ?? null,
    targetKind: candidate.targetKind ?? null,
  };
}

function createWorkflowToken(preflight: Record<string, unknown>, candidates: Record<string, unknown>[]) {
  const material = {
    repoRoot: preflight.repoRoot,
    baseRef: preflight.baseRef,
    baseRefOid: preflight.baseRefOid,
    candidates: candidates.map(candidateTokenMaterial),
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

function isGuardianWorktreeStatusPath(repoRoot: string, guardianRoot: string, statusPath: string) {
  const absoluteStatusPath = path.resolve(repoRoot, statusPath.replace(/\/$/, ""));
  return isInside(absoluteStatusPath, guardianRoot);
}

async function plannedCandidate(repoRoot: string, config: Record<string, unknown>, input: Record<string, unknown>) {
  const plan = await guardianDeleteWorktree({ repoRoot, cwd: repoRoot, mode: "plan", deleteBranch: true, config, ...input });
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

async function discoverCandidates(repoRoot: string, cwd: string, config: Record<string, unknown>, preflight: Record<string, unknown>) {
  const baseRef = `${String(config.remote)}/${String(config.baseBranch)}`;
  const guardianRoot = path.resolve(repoRoot, expandWorktreeRoot(String(config.worktreeRoot), repoRoot));
  const currentWorktree = await getRepoRoot(cwd);
  const worktrees = await listWorktrees(repoRoot) as Array<{ path: string; branch?: string; head?: string }>;
  const checkedOutBranches = new Set(worktrees.map((worktree) => worktree.branch).filter(Boolean));
  const candidates: Record<string, unknown>[] = [];
  const blockers: Record<string, unknown>[] = [];

  for (const worktree of worktrees) {
    if (samePath(worktree.path, repoRoot) || samePath(worktree.path, currentWorktree)) continue;
    if (!isInside(path.resolve(worktree.path), guardianRoot)) continue;
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
      blockers.push({ kind: "worktree", targetPath: worktree.path, branch: worktree.branch, reason: "worktree has uncommitted changes", dirtyFileCount: dirtyFiles.length });
      continue;
    }
    if (!(await isAncestor(repoRoot, worktree.head, baseRef))) {
      blockers.push({ kind: "worktree", targetPath: worktree.path, branch: worktree.branch, head: worktree.head, reason: "worktree branch is not proven reachable from base ref" });
      continue;
    }
    const candidate = await plannedCandidate(repoRoot, config, { targetPath: worktree.path });
    if (candidate.ok) candidates.push({ kind: "worktree", ...candidate });
    else blockers.push({ kind: "worktree", targetPath: worktree.path, branch: worktree.branch, reason: candidate.reason });
  }

  const branches = await listBranches(repoRoot) as Array<{ name: string; commit: string }>;
  for (const branch of branches) {
    if (!branch.name || !branch.commit) continue;
    if (checkedOutBranches.has(branch.name)) continue;
    if ((config.protectedBranches as string[]).includes(branch.name)) continue;
    if (!(await isAncestor(repoRoot, branch.commit, baseRef))) continue;
    const candidate = await plannedCandidate(repoRoot, config, { branch: branch.name });
    if (candidate.ok) candidates.push({ kind: "branch", ...candidate });
  }

  if (candidates.length > MAX_WORKFLOW_CLEANUP_CANDIDATES) {
    blockers.push({ kind: "candidate-bound", reason: `cleanup candidate count exceeds maximum ${MAX_WORKFLOW_CLEANUP_CANDIDATES}`, candidateCount: candidates.length, maxCandidateCount: MAX_WORKFLOW_CLEANUP_CANDIDATES });
  }

  preflight.candidateCount = candidates.length;
  preflight.blockerCount = blockers.length;
  preflight.maxCandidateCount = MAX_WORKFLOW_CLEANUP_CANDIDATES;
  return { candidates, blockers };
}

export async function guardianFinishWorkflow(input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const { config } = input.config && typeof input.config === "object" ? { config: input.config as Record<string, unknown> } : await loadConfig(repoRoot);
  const mode = input.mode ?? "plan";
  const baseRef = `${String(config.remote)}/${String(config.baseBranch)}`;
  const guardianRoot = path.resolve(repoRoot, expandWorktreeRoot(String(config.worktreeRoot), repoRoot));
  const preflight: Record<string, unknown> = {
    repoRoot: path.resolve(repoRoot),
    mode,
    remote: config.remote,
    baseBranch: config.baseBranch,
    baseRef,
    baseRefOid: null,
    baseRefFetched: false,
    currentBranch: null,
    dirtyFiles: [],
    dirtyFileCount: 0,
    stashCount: 0,
    candidateCount: 0,
    blockerCount: 0,
    blockers: [],
  };

  if (mode !== "plan" && mode !== "apply") return blocked("mode must be plan or apply", { mode }, preflight);

  try {
    await fetchRemote(repoRoot, String(config.remote));
    preflight.baseRefFetched = true;
    preflight.baseRefOid = await getRefCommit(repoRoot, baseRef);
  } catch (error) {
    return blocked("remote base ref could not be fetched or resolved", { baseRef, error: error instanceof Error ? error.message : String(error) }, preflight);
  }

  preflight.currentBranch = await getCurrentBranch(repoRoot);
  const dirtyFiles = await getDirtyFiles(repoRoot);
  const blockingDirtyFiles = dirtyFiles.filter((file) => !isGuardianWorktreeStatusPath(repoRoot, guardianRoot, file));
  const ignoredGuardianWorktreeFiles = dirtyFiles.filter((file) => isGuardianWorktreeStatusPath(repoRoot, guardianRoot, file));
  preflight.dirtyFiles = dirtyFiles;
  preflight.dirtyFileCount = dirtyFiles.length;
  preflight.blockingDirtyFiles = blockingDirtyFiles;
  preflight.blockingDirtyFileCount = blockingDirtyFiles.length;
  preflight.ignoredGuardianWorktreeFiles = ignoredGuardianWorktreeFiles;
  preflight.ignoredGuardianWorktreeFileCount = ignoredGuardianWorktreeFiles.length;
  if (blockingDirtyFiles.length > 0) return blocked("primary worktree has uncommitted changes; commit implemented code before finish workflow cleanup", { dirtyFiles: blockingDirtyFiles }, preflight);

  const stashes = await listStashes(repoRoot);
  preflight.stashCount = stashes.length;
  if (stashes.length > 0 && config.allowStashIfUnrelated !== true) return blocked("stash inventory is non-empty", { stashes }, preflight);

  const { candidates, blockers } = await discoverCandidates(repoRoot, cwd, config, preflight);
  if (blockers.length > 0) return blocked("cleanup blockers must be resolved before apply", { candidates, blockers }, preflight);
  const confirmToken = createWorkflowToken(preflight, candidates);
  if (mode === "plan") return { ok: true, status: "planned", confirmToken, preflight, candidates, blockers };
  if (input.confirmToken !== confirmToken) return blocked("confirm token mismatch; re-run mode=plan and use the returned confirmToken", { tokenMatched: false, candidates, blockers }, preflight);

  const results = [];
  for (const candidate of candidates) {
    const targetKind = typeof candidate.targetKind === "string" ? candidate.targetKind : undefined;
    const targetPath = targetKind === "worktree" && typeof candidate.targetPath === "string" ? candidate.targetPath : undefined;
    const branch = targetKind !== "worktree" && typeof candidate.branch === "string" ? candidate.branch : undefined;
    const plan = await guardianDeleteWorktree({ repoRoot, cwd: repoRoot, mode: "plan", targetPath, branch, deleteBranch: true, config });
    if (!plan.ok) {
      results.push({ ...candidateTokenMaterial(candidate), ok: false, status: "blocked", reason: plan.reason });
      continue;
    }
    const apply = await guardianDeleteWorktree({ repoRoot, cwd: repoRoot, mode: "apply", targetPath, branch, deleteBranch: true, confirmToken: plan.confirmToken, config });
    results.push({ ...candidateTokenMaterial(candidate), ok: apply.ok, status: apply.status, reason: apply.reason, worktreeRemoved: apply.worktreeRemoved, branchDeleted: apply.branchDeleted, safetyRef: apply.safetyRef });
  }

  const failedResults = results.filter((result) => result.ok !== true);
  return { ok: failedResults.length === 0, status: failedResults.length === 0 ? "cleaned" : "partial", preflight, candidates, blockers, results };
}
