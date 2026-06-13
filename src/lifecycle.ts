import type { MutableRecord } from "./types.ts";

export const TERMINAL_SESSION_STATUS_VALUES = ["deleted", "abandoned", "finished", "preserved", "superseded"] as const;
export type TerminalSessionStatus = typeof TERMINAL_SESSION_STATUS_VALUES[number];
export const TERMINAL_SESSION_STATUSES = new Set<string>(TERMINAL_SESSION_STATUS_VALUES);

export function isTerminalSessionStatus(status: unknown): status is TerminalSessionStatus {
  return typeof status === "string" && TERMINAL_SESSION_STATUSES.has(status);
}

export function isTerminalSession(session: { status?: unknown } | undefined | null): boolean {
  return isTerminalSessionStatus(session?.status);
}

export function isActiveSession<T extends { status?: unknown }>(session: T | undefined | null): session is T & { readonly status: "active" } {
  return session?.status === "active";
}

export function clearTerminalLifecycleFields(session: MutableRecord) {
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
