import path from "node:path";
import { getBranchCommit, listRefs } from "./git.ts";
import { isTerminalSession, isActiveSession } from "./lifecycle.ts";
import { samePath } from "./filesystem-boundaries.ts";
import type { GuardianSession, WorktreeEntry } from "./types.ts";

export type TargetResolution = {
  entry?: WorktreeEntry;
  session?: GuardianSession;
  targetKind?: "worktree" | "orphan-branch" | "stale-branch" | "merged-branch";
  branch?: string;
  head?: string;
  ownershipProof?: string;
  unresolvedReason: string;
};

function findSessionByWorktree(sessions: GuardianSession[], targetPath: string) {
  const matchingSessions = sessions.filter((session) => typeof session.worktree_path === "string" && samePath(session.worktree_path, targetPath));
  return matchingSessions.find(isActiveSession) ?? matchingSessions[0];
}

function sessionWorktreeEntry(session: GuardianSession | undefined, worktrees: WorktreeEntry[]) {
  return session?.worktree_path ? worktrees.find((worktree) => samePath(worktree.path, session.worktree_path ?? "")) : undefined;
}

function sessionBranchCheckedOut(session: GuardianSession | undefined, worktrees: WorktreeEntry[]) {
  return Boolean(session?.branch && worktrees.some((worktree) => worktree.branch === session.branch));
}

function safeRefSegment(value: unknown) {
  return String(value)
    .replace(/^refs\//, "")
    .replace(/\.\.+/g, ".")
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
}

function safetyRefMatchesBranch(refName: string, safeBranch: string) {
  const prefix = "refs/opencode-guardian/";
  if (!refName.startsWith(prefix)) return false;
  const parts = refName.slice(prefix.length).split("/").filter(Boolean);
  if (parts.length < 3) return false;
  const branchStart = parts[0] === "preserved" ? 2 : 1;
  return parts.slice(branchStart, -1).join("/") === safeBranch;
}

function branchFromInput(input: Record<string, unknown>) {
  return typeof input.branch === "string" && input.branch.length > 0 ? input.branch : undefined;
}

function explicitTargets(input: Record<string, unknown>) {
  return ["sessionId", "targetPath", "branch"].filter((key) => typeof input[key] === "string" && String(input[key]).length > 0);
}

function conflictingExplicitTarget(input: Record<string, unknown>, sessions: GuardianSession[]) {
  const branch = branchFromInput(input);
  if (!branch) return undefined;
  if (typeof input.sessionId === "string" && input.sessionId.length > 0) {
    const session = sessions.find((candidate) => candidate.session_id === input.sessionId);
    if (!session) return `sessionId does not match guardian state for branch ${branch}`;
    if (session?.branch && session.branch !== branch) return `sessionId resolves to branch ${session.branch}, not ${branch}`;
  }
  if (typeof input.targetPath === "string" && input.targetPath.length > 0) {
    const resolved = path.resolve(String(input.repoRoot ?? process.cwd()), input.targetPath);
    const pathSessions = sessions.filter((session) => typeof session.worktree_path === "string" && samePath(session.worktree_path, resolved));
    if (pathSessions.length === 0) return `targetPath does not match guardian state for branch ${branch}`;
    if (pathSessions.length > 1) return `targetPath matches multiple guardian sessions for branch ${branch}`;
    if (pathSessions.length === 1 && pathSessions[0].branch && pathSessions[0].branch !== branch) return `targetPath resolves to branch ${pathSessions[0].branch}, not ${branch}`;
  }
  return undefined;
}

function orphanBranchResolution(session: GuardianSession | undefined, worktrees: WorktreeEntry[], deleteRequestedBranch: boolean, repoRoot: string): TargetResolution | undefined {
  if (!session) return undefined;
  if (!deleteRequestedBranch) return undefined;
  if (!session.branch || !session.worktree_path) return undefined;
  if (session.status === "deleted") return undefined;
  const entry = sessionWorktreeEntry(session, worktrees);
  if (entry && !samePath(entry.path, repoRoot)) return undefined;
  if (sessionBranchCheckedOut(session, worktrees)) return undefined;
  return { session, targetKind: "orphan-branch", unresolvedReason: entry ? "recorded session worktree is the primary repo but the branch is not checked out" : "recorded session worktree is not in git worktree list" };
}

async function staleBranchResolution(input: Record<string, unknown>, worktrees: WorktreeEntry[], sessions: GuardianSession[], repoRoot: string, requestedSession?: GuardianSession): Promise<TargetResolution | undefined> {
  const branch = branchFromInput(input) ?? (requestedSession && isTerminalSession(requestedSession) ? requestedSession.branch : undefined);
  if (!branch || input.deleteBranch !== true) return undefined;
  if (worktrees.some((worktree) => worktree.branch === branch)) return undefined;
  let head: string;
  try {
    head = await getBranchCommit(repoRoot, branch);
  } catch {
    return undefined;
  }
  const terminalMatches = requestedSession && isTerminalSession(requestedSession) ? [requestedSession] : sessions.filter((session) => session.branch === branch && isTerminalSession(session));
  if (terminalMatches.length > 1) return { branch, head, targetKind: "stale-branch", unresolvedReason: "branch matches multiple terminal guardian sessions" };
  if (terminalMatches.length === 1 && terminalMatches[0].head_commit === head) {
    return { session: terminalMatches[0], branch, head, targetKind: "stale-branch", ownershipProof: "terminal-session", unresolvedReason: "branch has no checked-out worktree but terminal guardian state proves ownership" };
  }
  const safeBranch = safeRefSegment(branch);
  const safetyRefs = (await listRefs(repoRoot, "refs/opencode-guardian")) as Array<{ name?: string; commit?: string }>;
  const matchingRefs = safetyRefs.filter((ref) => ref.commit === head && typeof ref.name === "string" && safetyRefMatchesBranch(ref.name, safeBranch));
  if (matchingRefs.length > 0) return { branch, head, targetKind: "stale-branch", ownershipProof: "safety-ref", unresolvedReason: "branch has no checked-out worktree but guardian safety refs prove ownership" };
  return undefined;
}

function configuredBranchPrefix(input: Record<string, unknown>): string {
  const config = input.config;
  if (config && typeof config === "object" && "branchPrefix" in config && typeof (config as { branchPrefix?: unknown }).branchPrefix === "string") return (config as { branchPrefix: string }).branchPrefix;
  return "guardian/";
}

async function mergedBranchResolution(input: Record<string, unknown>, worktrees: WorktreeEntry[], repoRoot: string): Promise<TargetResolution | undefined> {
  const branch = branchFromInput(input);
  if (!branch || input.deleteBranch !== true) return undefined;
  const branchPrefix = configuredBranchPrefix(input);
  if (branchPrefix.length > 0 && branch.startsWith(branchPrefix)) return undefined;
  if (worktrees.some((worktree) => worktree.branch === branch)) return undefined;
  try {
    const head = await getBranchCommit(repoRoot, branch);
    return { branch, head, targetKind: "merged-branch", unresolvedReason: "local branch is not checked out in any worktree and can be deleted if ancestry is proven" };
  } catch {
    return undefined;
  }
}

export async function findTarget(input: Record<string, unknown>, worktrees: WorktreeEntry[], sessions: GuardianSession[]): Promise<TargetResolution> {
  const targets = explicitTargets(input);
  if (targets.length > 1) return { unresolvedReason: `target inputs conflict: provide exactly one of targetPath, sessionId, or branch; received ${targets.join(", ")}` };
  const conflict = conflictingExplicitTarget(input, sessions);
  if (conflict) return { unresolvedReason: `target inputs conflict: ${conflict}` };
  const deleteRequestedBranch = input.deleteBranch === true;
  const repoRoot = String(input.repoRoot ?? process.cwd());
  if (typeof input.sessionId === "string" && input.sessionId.length > 0) {
    const session = sessions.find((candidate) => candidate.session_id === input.sessionId);
    const staleBranch = await staleBranchResolution(input, worktrees, sessions, repoRoot, session);
    if (staleBranch) return staleBranch;
    const entry = sessionWorktreeEntry(session, worktrees);
    return orphanBranchResolution(session, worktrees, deleteRequestedBranch, repoRoot) ?? (entry ? { entry, session, targetKind: "worktree", unresolvedReason: "" } : { session, unresolvedReason: session ? "recorded session worktree is not in git worktree list" : "sessionId does not match guardian state" });
  }
  if (typeof input.targetPath === "string" && input.targetPath.length > 0) {
    const resolved = path.resolve(repoRoot, input.targetPath);
    const entry = worktrees.find((worktree) => samePath(worktree.path, resolved));
    if (entry) return { entry, session: findSessionByWorktree(sessions, entry.path), targetKind: "worktree", unresolvedReason: "" };
    const matches = sessions.filter((session) => typeof session.worktree_path === "string" && samePath(session.worktree_path, resolved));
    return matches.length === 1 ? orphanBranchResolution(matches[0], worktrees, deleteRequestedBranch, repoRoot) ?? { session: matches[0], unresolvedReason: "targetPath is not in git worktree list" } : { unresolvedReason: matches.length > 1 ? "targetPath matches multiple guardian sessions" : "targetPath is not in git worktree list" };
  }
  if (typeof input.branch === "string" && input.branch.length > 0) {
    const staleBranch = await staleBranchResolution(input, worktrees, sessions, repoRoot);
    if (staleBranch) return staleBranch;
    const mergedBranch = await mergedBranchResolution(input, worktrees, repoRoot);
    if (mergedBranch) return mergedBranch;
    const matches = worktrees.filter((worktree) => worktree.branch === input.branch);
    if (matches.length === 1) return { entry: matches[0], session: findSessionByWorktree(sessions, matches[0].path), targetKind: "worktree", unresolvedReason: "" };
    const sessionMatches = sessions.filter((session) => session.branch === input.branch && session.status !== "deleted");
    return sessionMatches.length === 1 ? orphanBranchResolution(sessionMatches[0], worktrees, deleteRequestedBranch, repoRoot) ?? { session: sessionMatches[0], unresolvedReason: "branch is not checked out in git worktree list" } : { unresolvedReason: matches.length > 1 ? "branch matches multiple worktrees" : sessionMatches.length > 1 ? "branch matches multiple guardian sessions" : "branch is not checked out in git worktree list" };
  }
  return { entry: undefined, session: undefined, unresolvedReason: "one of targetPath, sessionId, or branch is required" };
}
