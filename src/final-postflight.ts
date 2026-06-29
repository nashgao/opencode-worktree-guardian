import path from "node:path";
import { resolveBaseRef } from "./done-base-ref.ts";
import { fetchRemotePrune, getRefCommit, isAncestor, listBranches, listRefs, listRemoteBranches, listStashes, listWorktrees } from "./git.ts";

export type FinalPostflightCommit = {
  readonly commit: string;
  readonly source?: string;
  readonly reason?: string;
  readonly discardConfirmed?: boolean;
  readonly discardEvidence?: Record<string, unknown>;
};

export type FinalPostflightBlocker = {
  readonly kind: string;
  readonly reason: string;
  readonly [key: string]: unknown;
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

function postflightCommits(value: unknown): FinalPostflightCommit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): FinalPostflightCommit[] => {
    if (typeof entry === "string" && entry.length > 0) return [{ commit: entry }];
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    return typeof record.commit === "string" && record.commit.length > 0
      ? [{
        commit: record.commit,
        source: typeof record.source === "string" ? record.source : undefined,
        reason: typeof record.reason === "string" ? record.reason : undefined,
        discardConfirmed: record.discardConfirmed === true,
        discardEvidence: record.discardEvidence && typeof record.discardEvidence === "object" ? record.discardEvidence as Record<string, unknown> : undefined,
      }]
      : [];
  });
}

function safetyNamespace(refName: string): string {
  return refName.replace(/^refs\/opencode-guardian\//, "").split("/")[0] ?? "";
}

export async function runFinalCleanupPostflight(input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const repoRoot = path.resolve(String(input.repoRoot ?? process.cwd()));
  const config = input.config && typeof input.config === "object" ? input.config as Record<string, unknown> : {};
  const enforceSingleBranch = input.enforceSingleBranch !== false;
  const enforceSingleRemoteBranch = input.enforceSingleRemoteBranch !== false;
  const enforceSingleWorktree = input.enforceSingleWorktree !== false;
  const plannedBaseSync = input.plannedBaseSync === true;
  const requiredCommits = postflightCommits(input.requiredCommits);
  const blockers: FinalPostflightBlocker[] = [];
  const resolved = await resolveBaseRef(repoRoot, config);
  const baseRef = resolved.baseRef;
  const baseBranch = resolved.localBaseBranch;
  const configuredBaseBranch = typeof input.baseBranch === "string" && input.baseBranch.length > 0
    ? input.baseBranch
    : typeof config.baseBranch === "string" && config.baseBranch.length > 0
      ? config.baseBranch
      : "main";
  const allowedRemoteBranches = new Set([configuredBaseBranch, baseBranch, resolved.remoteBranch, ...stringArray(input.allowedRemoteBranches)]);
  const allowedLocalBranches = new Set([baseBranch, ...stringArray(input.allowedLocalBranches)]);
  const allowedWorktreeBranches = new Set([baseBranch, ...stringArray(input.allowedWorktreeBranches), ...stringArray(input.allowedLocalBranches)]);

  await fetchRemotePrune(repoRoot, resolved.remote);
  const baseHead = await getRefCommit(repoRoot, baseRef);
  const branches = await listBranches(repoRoot);
  const worktrees = await listWorktrees(repoRoot);
  const remoteBranches = await listRemoteBranches(repoRoot, resolved.remote);
  const stashes = await listStashes(repoRoot);
  const safetyRefs = await listRefs(repoRoot, "refs/opencode-guardian");

  const baseBranchEntry = branches.find((branch) => branch.name === baseBranch);
  if (!baseBranchEntry) blockers.push({ kind: "base-branch-missing", reason: `local base branch ${baseBranch} is missing`, baseBranch });
  else if (baseBranchEntry.commit !== baseHead && !plannedBaseSync) blockers.push({ kind: "base-branch-unsynced", reason: `local ${baseBranch} does not match ${baseRef}`, baseBranch, localHead: baseBranchEntry.commit, baseRef, baseHead });

  if (enforceSingleBranch) {
    const extraBranches = branches.filter((branch) => !allowedLocalBranches.has(branch.name));
    if (extraBranches.length > 0) blockers.push({ kind: "extra-local-branches", reason: "final cleanup requires no non-base local branches", branches: extraBranches });
  }

  if (enforceSingleRemoteBranch) {
    const extraRemoteBranches = remoteBranches.filter((branch) => !allowedRemoteBranches.has(branch.branch));
    if (extraRemoteBranches.length > 0) blockers.push({ kind: "extra-remote-branches", reason: "final cleanup requires no non-base remote branches on the effective remote", remote: resolved.remote, branches: extraRemoteBranches });
  }

  if (enforceSingleWorktree) {
    const extraWorktrees = worktrees.filter((worktree) => typeof worktree.branch !== "string" || !allowedWorktreeBranches.has(worktree.branch));
    if (extraWorktrees.length > 0) blockers.push({ kind: "extra-worktrees", reason: "final cleanup requires no non-base worktrees", worktrees: extraWorktrees });
  }

  if (stashes.length > 0 && config.allowStashIfUnrelated !== true) blockers.push({ kind: "stashes", reason: "stash inventory is non-empty", stashes });

  const droppedCommits = [];
  for (const required of requiredCommits) {
    const reachable = await isAncestor(repoRoot, required.commit, baseRef);
    if (reachable) continue;
    const refs = safetyRefs.filter((ref) => ref.commit === required.commit).map((ref) => ref.name);
    const dropped = { ...required, baseRef, safetyRefs: refs, safetyOnly: refs.length > 0 };
    droppedCommits.push(dropped);
    if (!required.discardConfirmed) {
      blockers.push({ kind: "dropped-required-commit", reason: "required commit is recoverable at most, not present on final base", ...dropped });
    }
  }

  const safetyOnlyRefs = safetyRefs.filter((ref) => safetyNamespace(ref.name) !== "preserved").map((ref) => ({ name: ref.name, commit: ref.commit, subject: ref.subject }));
  const activePreservedRefs = safetyRefs.filter((ref) => safetyNamespace(ref.name) === "preserved").map((ref) => ({ name: ref.name, commit: ref.commit, subject: ref.subject }));
  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? "passed" : "blocked",
    reason: blockers.length === 0 ? undefined : "final cleanup postflight failed",
    repoRoot,
    baseRef,
    baseBranch,
    baseHead,
    blockers,
    droppedCommits,
    branches,
    remoteBranches,
    worktrees,
    stashes,
    refInventory: {
      safetyOnlyRefs,
      activePreservedRefs,
      safetyOnlyRefCount: safetyOnlyRefs.length,
      activePreservedRefCount: activePreservedRefs.length,
    },
  };
}
