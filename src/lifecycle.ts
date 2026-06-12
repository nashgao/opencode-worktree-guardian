export const TERMINAL_SESSION_STATUSES = new Set(["deleted", "abandoned", "finished", "preserved", "superseded"]);

export function isTerminalSessionStatus(status: unknown) {
  return typeof status === "string" && TERMINAL_SESSION_STATUSES.has(status);
}

export function isTerminalSession(session: { status?: unknown } | undefined | null) {
  return isTerminalSessionStatus(session?.status);
}

export function isActiveSession(session: { status?: unknown } | undefined | null) {
  return session?.status === "active";
}

export function clearTerminalLifecycleFields(session: Record<string, any>) {
  if (session.status !== "active") return session;
  const next = { ...session };
  delete next.deleted_worktree_path;
  delete next.deleted_branch;
  delete next.branch_only_delete;
  delete next.branch_delete_failed;
  delete next.branch_delete_error;
  delete next.abandon_unmerged;
  delete next.abandoned_branch;
  delete next.unmerged_commits;
  return next;
}
