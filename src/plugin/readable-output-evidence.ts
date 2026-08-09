import { DETAIL_LIST_LIMIT, appendBoundedList, arrayValue, recordValue, shortCommit, textValue } from "./readable-output-values.ts";

function inlineItems(entries: readonly unknown[]): string {
  const visible = entries.slice(0, DETAIL_LIST_LIMIT).map((entry) => textValue(entry, String(entry)));
  const omitted = entries.length - visible.length;
  return omitted > 0 ? `${entries.length} | shown: ${visible.join(", ")} | omitted: ${omitted}` : visible.join(", ");
}

export function appendOperationalScope(lines: string[], rawScope: unknown, compact = false): void {
  const scope = recordValue(rawScope);
  if (Object.keys(scope).length === 0) return;
  const effectiveRemote = textValue(scope.effectiveRemote);
  const freshness = textValue(scope.freshness);
  const localBranchCount = Number(scope.localBranchCount ?? 0);
  const effectiveRemoteBranchCount = Number(scope.effectiveRemoteBranchCount ?? 0);
  const secondaryRemotes = arrayValue(scope.unexaminedSecondaryRemotes);
  if (compact) {
    lines.push(`[INFO] operational scope: effective remote=${effectiveRemote} freshness=${freshness} local branches=${localBranchCount} effective-remote branches=${effectiveRemoteBranchCount}`);
    lines.push(`[INFO] secondary remotes were not branch-scanned: ${secondaryRemotes.length === 0 ? "none" : inlineItems(secondaryRemotes)}`);
    return;
  }
  lines.push("[INFO] operational scope:");
  lines.push(`  effective remote: ${effectiveRemote} | freshness: ${freshness}`);
  lines.push(`  local branches: ${localBranchCount} | effective-remote branches: ${effectiveRemoteBranchCount}`);
  if (secondaryRemotes.length === 0) {
    lines.push("  secondary remotes were not branch-scanned: none");
    return;
  }
  lines.push(`  secondary remotes were not branch-scanned: ${inlineItems(secondaryRemotes)}`);
}

function formatPostflightBlocker(entry: unknown): string {
  const blocker = recordValue(entry);
  const scalarFields = [
    ["branch", blocker.branch],
    ["remote", blocker.remote],
    ["remoteBranch", blocker.remoteBranch],
    ["targetPath", blocker.targetPath],
    ["path", blocker.path],
    ["worktreePath", blocker.worktreePath],
    ["head", blocker.head],
    ["observedHead", blocker.observedHead],
    ["safetyRef", blocker.safetyRef],
    ["baseBranch", blocker.baseBranch],
    ["baseRef", blocker.baseRef],
    ["baseHead", blocker.baseHead],
    ["localHead", blocker.localHead],
    ["commit", blocker.commit],
    ["source", blocker.source],
  ] as const;
  const details = scalarFields
    .flatMap(([label, value]) => typeof value === "string" && value.length > 0 ? [` ${label}=${label === "head" || label === "observedHead" || label === "baseHead" || label === "localHead" || label === "commit" ? shortCommit(value) : textValue(value)}`] : [])
    .join("");
  return `  - kind=${textValue(blocker.kind)}${details} reason=${textValue(blocker.reason)}`;
}

function formatBlockerBranch(entry: unknown): string {
  const branch = recordValue(entry);
  if (typeof branch.name === "string") return `  - name=${textValue(branch.name)} commit=${shortCommit(branch.commit)}`;
  if (typeof branch.branch === "string") return `  - branch=${textValue(branch.branch)} commit=${shortCommit(branch.commit)}`;
  return `  - ${textValue(entry, String(entry))}`;
}

function formatBlockerWorktree(entry: unknown): string {
  const worktree = recordValue(entry);
  return `  - branch=${textValue(worktree.branch)} path=${textValue(worktree.path ?? worktree.worktreePath)}`;
}

function formatBlockerStash(entry: unknown): string {
  const stash = recordValue(entry);
  return `  - name=${textValue(stash.name ?? stash.ref ?? entry, String(entry))}`;
}

function appendPostflightBlockers(lines: string[], blockers: readonly unknown[]): void {
  if (blockers.length === 0) return;
  const shown = blockers.slice(0, DETAIL_LIST_LIMIT);
  lines.push(`[WARN] final postflight blockers: ${blockers.length}${blockers.length > shown.length ? ` | omitted: ${blockers.length - shown.length}` : ""}`);
  for (const entry of shown) {
    lines.push(formatPostflightBlocker(entry));
    const blocker = recordValue(entry);
    appendBoundedList({ lines, heading: "[WARN] blocker branches", entries: arrayValue(blocker.branches), format: formatBlockerBranch });
    appendBoundedList({ lines, heading: "[WARN] blocker worktrees", entries: arrayValue(blocker.worktrees), format: formatBlockerWorktree });
    appendBoundedList({ lines, heading: "[WARN] blocker stashes", entries: arrayValue(blocker.stashes), format: formatBlockerStash });
  }
}

function formatDroppedCommit(entry: unknown): string {
  const commit = recordValue(entry);
  const refs = arrayValue(commit.safetyRefs);
  const source = textValue(commit.source, "");
  const reason = textValue(commit.reason, "");
  const details = [source ? ` source=${source}` : "", reason ? ` reason=${reason}` : "", refs.length > 0 ? ` safetyRefs=${inlineItems(refs)}` : ""].join("");
  return `  - commit=${shortCommit(commit.commit)}${details}`;
}

function formatSafetyRef(entry: unknown): string {
  const ref = recordValue(entry);
  return `  - name=${textValue(ref.name)} commit=${shortCommit(ref.commit)} subject=${textValue(ref.subject)}`;
}

export function appendFinalPostflightEvidence(lines: string[], rawPostflight: unknown): void {
  const postflight = recordValue(rawPostflight);
  if (Object.keys(postflight).length === 0) return;
  const status = textValue(postflight.status, postflight.ok === false ? "blocked" : "unknown");
  const reason = textValue(postflight.reason, "");
  lines.push(`${postflight.ok === false || status === "blocked" ? "[WARN]" : "[INFO]"} final postflight: ${status}${reason ? ` | reason: ${reason}` : ""}`);
  if (postflight.ok === true && status === "passed") {
    appendOperationalScope(lines, postflight.operationalScope, true);
  } else if (postflight.baseRef !== undefined || postflight.baseBranch !== undefined) {
    lines.push(`[INFO] final postflight base: ${textValue(postflight.baseRef)} | branch: ${textValue(postflight.baseBranch)} | head: ${shortCommit(postflight.baseHead)}`);
    appendOperationalScope(lines, postflight.operationalScope);
  }
  appendPostflightBlockers(lines, arrayValue(postflight.blockers));
  appendBoundedList({ lines, heading: "[WARN] dropped commits", entries: arrayValue(postflight.droppedCommits), format: formatDroppedCommit });
  const inventory = recordValue(postflight.refInventory);
  appendBoundedList({ lines, heading: "[INFO] safety refs", entries: arrayValue(inventory.safetyOnlyRefs), count: inventory.safetyOnlyRefCount, format: formatSafetyRef });
  appendBoundedList({ lines, heading: "[INFO] preserved refs", entries: arrayValue(inventory.activePreservedRefs), count: inventory.activePreservedRefCount, format: formatSafetyRef });
}

export function formatCleanupResult(entry: unknown): string {
  const item = recordValue(entry);
  const abandon = item.abandonUnmerged === true ? " abandonUnmerged=true" : "";
  const safetyRef = typeof item.safetyRef === "string" ? ` safetyRef=${textValue(item.safetyRef)}` : "";
  const remote = typeof item.remote === "string" ? ` remote=${textValue(item.remote)}` : "";
  const remoteBranch = typeof item.remoteBranch === "string" ? ` remoteBranch=${textValue(item.remoteBranch)}` : "";
  const remoteDeleted = item.remoteBranchDeleted === true ? " remoteBranchDeleted=true" : "";
  return `  - status=${textValue(item.status)} branch=${textValue(item.branch)} worktreeRemoved=${String(item.worktreeRemoved === true)} branchDeleted=${String(item.branchDeleted === true)}${remoteDeleted}${remote}${remoteBranch}${safetyRef}${abandon}`;
}

export function appendCleanupResults(lines: string[], results: readonly unknown[]): void {
  appendBoundedList({ lines, heading: "[INFO] cleanup results", entries: results, format: formatCleanupResult });
}

function cleanupEntries(result: Record<string, unknown>, cleanupPlan: Record<string, unknown>, key: string): unknown[] {
  const direct = arrayValue(result[key]);
  return direct.length > 0 ? direct : arrayValue(cleanupPlan[key]);
}

function formatCleanupCandidate(entry: unknown): string {
  const candidate = recordValue(entry);
  const abandon = candidate.abandonUnmerged === true ? " abandonUnmerged=true" : "";
  return `  - kind=${textValue(candidate.kind)} targetKind=${textValue(candidate.targetKind)} branch=${textValue(candidate.branch)} path=${textValue(candidate.targetPath)} head=${shortCommit(candidate.head)}${abandon}`;
}

function formatCleanupBlocker(entry: unknown): string {
  const blocker = recordValue(entry);
  return `  - kind=${textValue(blocker.kind)} branch=${textValue(blocker.branch)} path=${textValue(blocker.targetPath)} reason=${textValue(blocker.reason)}`;
}

function formatRemaining(entry: unknown): string {
  const remaining = recordValue(entry);
  const head = remaining.head ? ` head=${shortCommit(remaining.head)}` : "";
  const reason = textValue(remaining.reason, "");
  return `  - kind=${textValue(remaining.kind)} branch=${textValue(remaining.branch)} path=${textValue(remaining.targetPath)}${head}${reason ? ` reason=${reason}` : ""}`;
}

export function appendCleanupEvidence(lines: string[], rawResult: unknown): void {
  const result = recordValue(rawResult);
  const cleanupPlan = recordValue(result.cleanupPlan);
  const preflight = recordValue(result.preflight);
  const cleanupPreflight = recordValue(cleanupPlan.preflight);
  appendBoundedList({
    lines,
    heading: "[INFO] cleanup candidates",
    entries: cleanupEntries(result, cleanupPlan, "candidates"),
    count: preflight.candidateCount ?? cleanupPreflight.candidateCount,
    format: formatCleanupCandidate,
  });
  appendBoundedList({
    lines,
    heading: "[WARN] cleanup blockers",
    entries: cleanupEntries(result, cleanupPlan, "blockers"),
    count: preflight.blockerCount ?? cleanupPreflight.blockerCount,
    format: formatCleanupBlocker,
  });
  appendBoundedList({ lines, heading: "[WARN] remaining repo blockers", entries: arrayValue(result.remaining), format: formatRemaining });
  appendCleanupResults(lines, arrayValue(result.results));
}
