import crypto from "node:crypto";

export function snapshotPreflight(preflight: Record<string, unknown>) {
  const snapshot: Record<string, unknown> = { ...preflight, blockers: [...((preflight.blockers as string[] | undefined) ?? [])] };
  return snapshot;
}

export function withDeleteReport(result: Record<string, unknown>, preflight: Record<string, unknown>, reportDetails: Record<string, unknown> = {}) {
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

export function blocked(reason: string, details: Record<string, unknown>, preflight: Record<string, unknown>) {
  preflight.blockers = [...((preflight.blockers as string[] | undefined) ?? []), reason];
  return withDeleteReport({ ok: false, status: "blocked", reason, ...details }, preflight, { action: "blocked" });
}

export function errorMessage(error: unknown) {
  if (typeof error === "object" && error !== null) {
    const details = error as Record<string, unknown>;
    if (typeof details.gitStderr === "string" && details.gitStderr.length > 0) return details.gitStderr;
    if (typeof details.message === "string" && details.message.length > 0) return details.message;
  }
  return String(error);
}

export function createConfirmToken(preflight: Record<string, unknown>) {
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
