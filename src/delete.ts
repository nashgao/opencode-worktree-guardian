import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expandWorktreeRoot, loadConfig } from "./config.ts";
import { abandonBranch, createSafetyRef, deleteBranch, getBranchCommit, getDirtyFiles, getHeadCommit, getIgnoredFiles, getRepoRoot, isAncestor, listRefs, listStashes, listUnmergedCommits, listWorktrees, removeWorktree } from "./git.ts";
import { getGuardianPaths, readState, recordSession } from "./state.ts";

type GuardianSession = {
  session_id?: string;
  status?: string;
  branch?: string;
  worktree_path?: string;
  base_ref?: string;
  head_commit?: string;
  safety_refs?: string[];
  deleted_worktree_path?: string;
  deleted_branch?: string | null;
  abandoned_branch?: string;
  branch_only_delete?: boolean;
};

type WorktreeEntry = {
  path: string;
  head?: string;
  branch?: string;
  detached?: boolean;
  bare?: boolean;
};

type TargetResolution = {
  entry?: WorktreeEntry;
  session?: GuardianSession;
  targetKind?: "worktree" | "orphan-branch" | "stale-branch";
  branch?: string;
  head?: string;
  ownershipProof?: string;
  unresolvedReason: string;
};

function samePath(left: string, right: string) {
  return path.resolve(left) === path.resolve(right);
}

function isInside(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function snapshotPreflight(preflight: Record<string, unknown>) {
  const snapshot: Record<string, unknown> = { ...preflight, blockers: [...((preflight.blockers as string[] | undefined) ?? [])] };
  return snapshot;
}

function withDeleteReport(result: Record<string, unknown>, preflight: Record<string, unknown>, reportDetails: Record<string, unknown> = {}) {
  const preflightSnapshot = snapshotPreflight(preflight);
  return {
    ...result,
    preflight: preflightSnapshot,
    report: {
      action: reportDetails.action ?? result.status,
      mode: preflightSnapshot.mode,
      targetPath: preflightSnapshot.targetPath,
      branch: preflightSnapshot.branch,
      head: preflightSnapshot.head,
      sessionId: preflightSnapshot.sessionId,
      sessionStatus: preflightSnapshot.sessionStatus,
      deleteBranch: preflightSnapshot.deleteBranch,
      abandonUnmerged: preflightSnapshot.abandonUnmerged,
      ancestryRef: preflightSnapshot.ancestryRef,
      ancestryProven: preflightSnapshot.ancestryProven,
      unmergedCommitCount: preflightSnapshot.unmergedCommitCount,
      dirtyFileCount: preflightSnapshot.dirtyFileCount,
      ignoredFileCount: preflightSnapshot.ignoredFileCount,
      stashCount: preflightSnapshot.stashCount,
      safetyRef: preflightSnapshot.safetyRef ?? result.safetyRef ?? null,
      blockers: preflightSnapshot.blockers,
      ...reportDetails,
    },
  };
}

function blocked(reason: string, details: Record<string, unknown>, preflight: Record<string, unknown>) {
  preflight.blockers = [...((preflight.blockers as string[] | undefined) ?? []), reason];
  return withDeleteReport({ ok: false, status: "blocked", reason, ...details }, preflight, { action: "blocked" });
}

function errorMessage(error: unknown) {
  if (typeof error === "object" && error !== null) {
    const details = error as Record<string, unknown>;
    if (typeof details.gitStderr === "string" && details.gitStderr.length > 0) return details.gitStderr;
    if (typeof details.message === "string" && details.message.length > 0) return details.message;
  }
  return String(error);
}

function createConfirmToken(preflight: Record<string, unknown>) {
  const material = {
    repoRoot: preflight.repoRoot,
    targetKind: preflight.targetKind ?? "worktree",
    targetPath: preflight.targetPath,
    worktreeListed: preflight.worktreeListed !== false,
    branch: preflight.branch ?? "<detached>",
    head: preflight.head,
    sessionId: preflight.sessionId ?? null,
    sessionStatus: preflight.sessionStatus ?? "unrecorded",
    deleteBranch: preflight.deleteBranch === true,
    abandonUnmerged: preflight.abandonUnmerged === true,
    allowIgnoredFiles: preflight.allowIgnoredFiles === true,
    ignoredFiles: preflight.ignoredFiles ?? [],
    ignoredFileFingerprint: preflight.ignoredFileFingerprint ?? [],
    ancestryRef: preflight.ancestryRef ?? null,
    ancestryProven: preflight.ancestryProven === true,
    unmergedCommits: preflight.unmergedCommits ?? [],
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

function findSessionByWorktree(sessions: GuardianSession[], targetPath: string) {
  return sessions.find((session) => typeof session.worktree_path === "string" && samePath(session.worktree_path, targetPath));
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

function isTerminalSession(session: GuardianSession) {
  return session.status === "deleted" || session.status === "abandoned";
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

async function findTarget(input: Record<string, unknown>, worktrees: WorktreeEntry[], sessions: GuardianSession[]): Promise<TargetResolution> {
  const targets = explicitTargets(input);
  if (targets.length > 1) return { unresolvedReason: `target inputs conflict: provide exactly one of targetPath, sessionId, or branch; received ${targets.join(", ")}` };
  const conflict = conflictingExplicitTarget(input, sessions);
  if (conflict) return { unresolvedReason: `target inputs conflict: ${conflict}` };
  const deleteRequestedBranch = input.deleteBranch === true;
  if (typeof input.sessionId === "string" && input.sessionId.length > 0) {
    const session = sessions.find((candidate) => candidate.session_id === input.sessionId);
    const staleBranch = await staleBranchResolution(input, worktrees, sessions, String(input.repoRoot ?? process.cwd()), session);
    if (staleBranch) return staleBranch;
    const entry = sessionWorktreeEntry(session, worktrees);
    return orphanBranchResolution(session, worktrees, deleteRequestedBranch, String(input.repoRoot ?? process.cwd())) ?? (entry ? { entry, session, targetKind: "worktree", unresolvedReason: "" } : { session, unresolvedReason: session ? "recorded session worktree is not in git worktree list" : "sessionId does not match guardian state" });
  }
  if (typeof input.targetPath === "string" && input.targetPath.length > 0) {
    const resolved = path.resolve(String(input.repoRoot ?? process.cwd()), input.targetPath);
    const entry = worktrees.find((worktree) => samePath(worktree.path, resolved));
    if (entry) return { entry, session: findSessionByWorktree(sessions, entry.path), targetKind: "worktree", unresolvedReason: "" };
    const matches = sessions.filter((session) => typeof session.worktree_path === "string" && samePath(session.worktree_path, resolved));
    return matches.length === 1 ? orphanBranchResolution(matches[0], worktrees, deleteRequestedBranch, String(input.repoRoot ?? process.cwd())) ?? { session: matches[0], unresolvedReason: "targetPath is not in git worktree list" } : { unresolvedReason: matches.length > 1 ? "targetPath matches multiple guardian sessions" : "targetPath is not in git worktree list" };
  }
  if (typeof input.branch === "string" && input.branch.length > 0) {
    const staleBranch = await staleBranchResolution(input, worktrees, sessions, String(input.repoRoot ?? process.cwd()));
    if (staleBranch) return staleBranch;
    const matches = worktrees.filter((worktree) => worktree.branch === input.branch);
    if (matches.length === 1) return { entry: matches[0], session: findSessionByWorktree(sessions, matches[0].path), targetKind: "worktree", unresolvedReason: "" };
    const sessionMatches = sessions.filter((session) => session.branch === input.branch && session.status !== "deleted");
    return sessionMatches.length === 1 ? orphanBranchResolution(sessionMatches[0], worktrees, deleteRequestedBranch, String(input.repoRoot ?? process.cwd())) ?? { session: sessionMatches[0], unresolvedReason: "branch is not checked out in git worktree list" } : { unresolvedReason: matches.length > 1 ? "branch matches multiple worktrees" : sessionMatches.length > 1 ? "branch matches multiple guardian sessions" : "branch is not checked out in git worktree list" };
  }
  return { entry: undefined, session: undefined, unresolvedReason: "one of targetPath, sessionId, or branch is required" };
}

async function recordAncestryPreflight(repoRoot: string, head: string, baseRef: string, preflight: Record<string, unknown>) {
  preflight.ancestryRef = baseRef;
  const proven = await isAncestor(repoRoot, head, baseRef);
  preflight.ancestryProven = proven;
  if (proven) {
    preflight.unmergedCommits = [];
    preflight.unmergedCommitCount = 0;
    return proven;
  }
  let unmergedCommits: { commit: string; subject: string | undefined }[] = [];
  try {
    unmergedCommits = await listUnmergedCommits(repoRoot, head, baseRef);
  } catch (error) {
    preflight.unmergedCommitError = errorMessage(error);
  }
  preflight.unmergedCommits = unmergedCommits;
  preflight.unmergedCommitCount = unmergedCommits.length;
  return proven;
}

async function collectIgnoredFileFingerprint(worktreePath: string, ignoredFiles: string[]) {
  const entries = new Set<string>();
  async function addEntry(relativePath: string) {
    const normalized = relativePath.replace(/\/+/g, "/");
    entries.add(normalized);
    if (!normalized.endsWith("/")) return;
    const absoluteDir = path.join(worktreePath, normalized);
    let children: string[] = [];
    try {
      children = await fs.readdir(absoluteDir);
    } catch {
      return;
    }
    for (const child of children) await addEntry(`${normalized}${child}${(await fs.stat(path.join(absoluteDir, child))).isDirectory() ? "/" : ""}`);
  }
  for (const ignoredFile of ignoredFiles) await addEntry(ignoredFile);
  return [...entries].sort();
}

export async function guardianDeleteWorktree(input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const { config } = input.config && typeof input.config === "object" ? { config: input.config as Record<string, unknown> } : await loadConfig(repoRoot);
  const mode = input.mode;
  const deleteRequestedBranch = input.deleteBranch === true;
  const abandonUnmerged = input.abandonUnmerged === true;
  const allowIgnoredFiles = input.allowIgnoredFiles === true;
  const preflight: Record<string, unknown> = {
    repoRoot: path.resolve(repoRoot),
    mode,
    targetKind: null,
    targetPath: null,
    worktreeListed: null,
    branch: null,
    head: null,
    detached: false,
    sessionId: null,
    sessionStatus: "unrecorded",
    sessionRecorded: false,
    deleteBranch: deleteRequestedBranch,
    abandonUnmerged,
    ancestryRef: null,
    ancestryProven: null,
    unmergedCommits: [],
    unmergedCommitCount: 0,
    allowIgnoredFiles,
    dirtyFiles: [],
    dirtyFileCount: 0,
    ignoredFiles: [],
    ignoredFileCount: 0,
    stashCount: 0,
    safetyRef: null,
    blockers: [],
  };

  if (mode !== "plan" && mode !== "apply") return blocked("mode must be plan or apply", { mode }, preflight);
  if (abandonUnmerged && !deleteRequestedBranch) return blocked("abandonUnmerged requires deleteBranch=true", {}, preflight);

  const guardianPaths = await getGuardianPaths(repoRoot);
  const state = input.state && typeof input.state === "object" ? input.state as { sessions?: Record<string, GuardianSession> } : await readState(guardianPaths, { repoRoot, config });
  const sessions = Object.values(state.sessions ?? {});
  const worktrees = await listWorktrees(repoRoot) as WorktreeEntry[];
  const { entry, session, targetKind, branch: resolvedBranch, head: resolvedHead, ownershipProof, unresolvedReason } = await findTarget({ ...input, repoRoot }, worktrees, sessions);
  if (!entry && targetKind !== "orphan-branch" && targetKind !== "stale-branch") return blocked(unresolvedReason, {}, preflight);

  preflight.targetKind = targetKind ?? "worktree";
  preflight.worktreeListed = Boolean(entry);
  preflight.sessionId = session?.session_id ?? null;
  preflight.sessionStatus = session?.status ?? "unrecorded";
  preflight.sessionRecorded = Boolean(session);

  if (targetKind === "orphan-branch" || targetKind === "stale-branch") {
    const branch = String(resolvedBranch ?? session?.branch ?? "");
    preflight.targetPath = session?.worktree_path ? path.resolve(String(session.worktree_path)) : null;
    preflight.branch = branch;
    preflight.detached = false;
    preflight.ownershipProof = ownershipProof ?? (targetKind === "orphan-branch" ? "active-session" : null);
    if (targetKind === "stale-branch" && !ownershipProof) return blocked(unresolvedReason, { branch }, preflight);

    if (!deleteRequestedBranch) return blocked(`${targetKind} Guardian branch cleanup requires deleteBranch=true`, { branch }, preflight);
    if ((config.protectedBranches as string[]).includes(branch)) return blocked("protected branches cannot be deleted by guardian_delete_worktree", { branch }, preflight);
    const checkedOut = worktrees.find((worktree) => worktree.branch === branch);
    preflight.branchCheckedOut = Boolean(checkedOut);
    if (checkedOut) return blocked("branch is checked out in a git worktree", { branch, targetPath: checkedOut.path }, preflight);

    let head = resolvedHead;
    try {
      head = head ?? await getBranchCommit(repoRoot, branch);
    } catch {
      return blocked("branch does not exist", { branch }, preflight);
    }
    preflight.head = head;

    const stashes = await listStashes(repoRoot);
    preflight.stashCount = stashes.length;
    if (stashes.length > 0 && config.allowStashIfUnrelated !== true) {
      return blocked("stash inventory is non-empty", { stashes }, preflight);
    }

    const baseRef = session?.base_ref ?? `${String(config.remote)}/${String(config.baseBranch)}`;
    const proven = await recordAncestryPreflight(repoRoot, head, baseRef, preflight);
    if (!proven && abandonUnmerged && preflight.unmergedCommitError) return blocked("unmerged commits could not be listed", { branch, head, baseRef, error: preflight.unmergedCommitError }, preflight);
    if (!proven && !abandonUnmerged) return blocked("branch head is not proven reachable from base ref", { branch, head, baseRef }, preflight);

    const confirmToken = createConfirmToken(preflight);
    if (mode === "plan") {
      return withDeleteReport({ ok: true, status: "planned", confirmToken }, preflight, { action: "planned" });
    }

    if (input.confirmToken !== confirmToken) {
      return blocked("confirm token mismatch; re-run mode=plan and use the returned confirmToken", { tokenMatched: false }, preflight);
    }

    const safetyRef = await createSafetyRef(repoRoot, { sessionId: session?.session_id ?? "orphan-guardian-branch", branch, commit: head, timestamp: input.timestamp });
    preflight.safetyRef = safetyRef;
    if (!proven && abandonUnmerged) await abandonBranch(repoRoot, branch);
    else await deleteBranch(repoRoot, branch);

    if (session?.session_id) {
      await recordSession(repoRoot, config, {
        ...session,
        session_id: session.session_id,
        status: !proven && abandonUnmerged ? "abandoned" : "deleted",
        head_commit: head,
        safety_refs: [...(session.safety_refs ?? []), safetyRef],
        deleted_worktree_path: session.worktree_path,
        deleted_branch: branch,
        branch_only_delete: true,
        abandon_unmerged: !proven && abandonUnmerged,
        abandoned_branch: !proven && abandonUnmerged ? branch : undefined,
        unmerged_commits: !proven && abandonUnmerged ? preflight.unmergedCommits : undefined,
      }, { event: { type: targetKind === "stale-branch" ? "guardian_delete_stale_branch" : "guardian_delete_orphan_branch", session_id: session.session_id, ref: safetyRef } });
    }

    const actionPrefix = targetKind === "stale-branch" ? "stale-branch" : "orphan-branch";
    return withDeleteReport({ ok: true, status: !proven && abandonUnmerged ? "abandoned" : "deleted", targetPath: session?.worktree_path ?? null, branch, head, safetyRef, branchDeleted: true, worktreeRemoved: false, abandonUnmerged: !proven && abandonUnmerged }, preflight, { action: !proven && abandonUnmerged ? `${actionPrefix}-abandoned` : `${actionPrefix}-deleted`, worktreeRemoved: false });
  }

  if (!entry) return blocked(unresolvedReason, {}, preflight);

  preflight.targetPath = path.resolve(entry.path);
  preflight.worktreeListed = true;
  preflight.branch = entry.branch ?? null;
  preflight.head = entry.head ?? null;
  preflight.detached = entry.detached === true || !entry.branch;

  if (samePath(entry.path, repoRoot)) return blocked("refusing to delete the primary repo worktree", { targetPath: entry.path }, preflight);

  const currentWorktree = await getRepoRoot(cwd);
  preflight.currentWorktree = currentWorktree;
  if (samePath(entry.path, currentWorktree)) return blocked("refusing to delete the current execution worktree", { targetPath: entry.path, currentWorktree }, preflight);
  if (entry.detached || !entry.branch) return blocked("detached HEAD worktrees cannot be deleted by guardian_delete_worktree", { targetPath: entry.path }, preflight);
  if ((config.protectedBranches as string[]).includes(entry.branch)) return blocked("protected branches cannot be deleted by guardian_delete_worktree", { branch: entry.branch }, preflight);

  const guardianRoot = path.resolve(repoRoot, expandWorktreeRoot(String(config.worktreeRoot), repoRoot));
  if (!session && !isInside(path.resolve(entry.path), guardianRoot)) {
    return blocked("unrecorded worktrees outside the Guardian worktree root cannot be deleted", { targetPath: entry.path, guardianRoot }, preflight);
  }

  const dirtyFiles = await getDirtyFiles(entry.path);
  preflight.dirtyFiles = dirtyFiles;
  preflight.dirtyFileCount = dirtyFiles.length;
  if (dirtyFiles.length > 0) return blocked("worktree has uncommitted changes", { dirtyFiles, targetPath: entry.path }, preflight);

    const ignoredFiles = await getIgnoredFiles(entry.path);
    preflight.ignoredFiles = ignoredFiles;
    preflight.ignoredFileFingerprint = await collectIgnoredFileFingerprint(entry.path, ignoredFiles);
    preflight.ignoredFileCount = ignoredFiles.length;
  if (ignoredFiles.length > 0 && !allowIgnoredFiles) return blocked("worktree has ignored files", { ignoredFiles, targetPath: entry.path }, preflight);

  const stashes = await listStashes(repoRoot);
  preflight.stashCount = stashes.length;
  if (stashes.length > 0 && config.allowStashIfUnrelated !== true) {
    return blocked("stash inventory is non-empty", { stashes }, preflight);
  }

  if (deleteRequestedBranch) {
    const head = entry.head ?? await getHeadCommit(entry.path);
    preflight.head = head;
    const baseRef = session?.base_ref ?? `${String(config.remote)}/${String(config.baseBranch)}`;
    const proven = await recordAncestryPreflight(repoRoot, head, baseRef, preflight);
    if (!proven && abandonUnmerged && preflight.unmergedCommitError) return blocked("unmerged commits could not be listed", { branch: entry.branch, head, baseRef, error: preflight.unmergedCommitError }, preflight);
    if (!proven && !abandonUnmerged) return blocked("branch head is not proven reachable from base ref", { branch: entry.branch, head, baseRef }, preflight);
  }

  const confirmToken = createConfirmToken(preflight);
  if (mode === "plan") {
    return withDeleteReport({ ok: true, status: "planned", confirmToken }, preflight, { action: "planned" });
  }

  if (input.confirmToken !== confirmToken) {
    return blocked("confirm token mismatch; re-run mode=plan and use the returned confirmToken", { tokenMatched: false }, preflight);
  }

  const safetySessionId = session?.session_id ?? "unrecorded-worktree";
  const head = String(preflight.head ?? await getHeadCommit(entry.path));
  const safetyRef = await createSafetyRef(repoRoot, { sessionId: safetySessionId, branch: entry.branch, commit: head, timestamp: input.timestamp });
  preflight.safetyRef = safetyRef;

  await removeWorktree(repoRoot, entry.path);
  let branchDeleted = false;
  if (deleteRequestedBranch) {
    try {
      if (preflight.ancestryProven === false && abandonUnmerged) await abandonBranch(repoRoot, entry.branch);
      else await deleteBranch(repoRoot, entry.branch);
      branchDeleted = true;
    } catch (error) {
      const branchDeleteError = errorMessage(error);
      if (session?.session_id) {
        await recordSession(repoRoot, config, {
          ...session,
          session_id: session.session_id,
          status: "deleted",
          head_commit: head,
          safety_refs: [...(session.safety_refs ?? []), safetyRef],
          deleted_worktree_path: entry.path,
          deleted_branch: null,
          branch_delete_failed: true,
          branch_delete_error: branchDeleteError,
          abandon_unmerged: preflight.ancestryProven === false && abandonUnmerged,
          unmerged_commits: preflight.ancestryProven === false && abandonUnmerged ? preflight.unmergedCommits : undefined,
        }, { event: { type: "guardian_delete_worktree_partial", session_id: session.session_id, ref: safetyRef } });
      }
      return withDeleteReport({
        ok: false,
        status: "partial",
        reason: "worktree deleted but branch deletion failed",
        targetPath: entry.path,
        branch: entry.branch,
        head,
        safetyRef,
        branchDeleted: false,
        worktreeRemoved: true,
        error: branchDeleteError,
      }, preflight, { action: "worktree-deleted-branch-delete-failed", worktreeRemoved: true, branchDeleteError });
    }
  }

  if (session?.session_id) {
    const abandoned = preflight.ancestryProven === false && abandonUnmerged;
    await recordSession(repoRoot, config, {
      ...session,
      session_id: session.session_id,
      status: abandoned ? "abandoned" : "deleted",
      head_commit: head,
      safety_refs: [...(session.safety_refs ?? []), safetyRef],
      deleted_worktree_path: entry.path,
      deleted_branch: branchDeleted ? entry.branch : null,
      abandon_unmerged: abandoned,
      abandoned_branch: abandoned ? entry.branch : undefined,
      unmerged_commits: abandoned ? preflight.unmergedCommits : undefined,
    }, { event: { type: "guardian_delete_worktree", session_id: session.session_id, ref: safetyRef } });
  }

  const abandoned = preflight.ancestryProven === false && abandonUnmerged;
  return withDeleteReport({ ok: true, status: abandoned ? "abandoned" : "deleted", targetPath: entry.path, branch: entry.branch, head, safetyRef, branchDeleted, abandonUnmerged: abandoned }, preflight, { action: abandoned ? "worktree-and-branch-abandoned" : branchDeleted ? "worktree-and-branch-deleted" : "worktree-deleted" });
}
