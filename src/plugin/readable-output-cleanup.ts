import { appendBoundedList, appendStashInventoryWarning, arrayValue, recordValue, shortCommit, textValue } from "./readable-output-values.ts";

function reviewableTextValue(value: unknown, fallback = "-") {
  return textValue(value, fallback)
    .replace(/\r\n|\n|\r/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/(^|\\n|[^A-Za-z0-9_])mode\s*=\s*apply\b/gi, "$1mode=<redacted>")
    .replace(/(^|\\n|[^A-Za-z0-9_])confirmDelete\s*=\s*true\b/gi, "$1confirmDelete=<redacted>")
    .replace(/(^|\\n|[^A-Za-z0-9_])confirmToken\s*[:=]\s*[^\\\s]+/gi, "$1confirmation=<redacted>")
    .replace(/(^|\\n|[^A-Za-z0-9_])confirmToken\b/gi, "$1confirmation")
    .replace(/(^|[^A-Za-z0-9_]|\\n)rm\s+-rf\b/gi, "$1rm <redacted>")
    .replace(/(^|[^A-Za-z0-9_]|\\n)git\s+clean\b/gi, "$1git <redacted>");
}

export function formatGuardianHygieneOutput(rawResult: unknown) {
  const result = recordValue(rawResult);
  if (["planned", "cleaned", "blocked"].includes(textValue(result.status, ""))) return formatGuardianHygienePlanOutput(rawResult);
  const summary = recordValue(result.summary);
  const findings = arrayValue(result.findings);
  const exclusions = arrayValue(result.exclusions);
  const reviewableCandidates = arrayValue(result.reviewableCandidates);
  const reviewableCount = Number(summary.reviewableCandidateCount ?? reviewableCandidates.length);
  const visibleReviewableCandidates = reviewableCandidates;
  const reviewableOmittedCount = Number(summary.reviewableOmittedCount ?? Math.max(0, reviewableCount - visibleReviewableCandidates.length));
  const reviewableTotalFileCount = Number(summary.reviewableTotalFileCount ?? reviewableCount);
  const reviewableTotalBytes = Number(summary.reviewableTotalBytes ?? 0);
  const reviewableBytesTruncated = summary.reviewableBytesTruncated === true;
  const failCount = Number(recordValue(summary.bySeverity).fail ?? 0);
  const warnCount = Number(recordValue(summary.bySeverity).warn ?? 0);
  const scanFailed = result.ok === false || summary.scanFailed === true;
  const inventoryIncomplete = summary.filesystemOnlyEmptyDirectoryScanComplete === false;
  const lines = [`${scanFailed ? "[FAIL]" : findings.length > 0 || reviewableCount > 0 || inventoryIncomplete ? "[WARN]" : "[GOOD]"} guardian_hygiene scan`, `[INFO] repoRoot: ${textValue(result.repoRoot)}`];
  if (scanFailed) lines.push("[WARN] scan incomplete: findings and candidate counts are not trustworthy");
  else lines.push(`[INFO] findings: ${Number(summary.findingCount ?? findings.length)} | warn: ${warnCount} | fail: ${failCount} | exclusions: ${Number(summary.exclusionCount ?? exclusions.length)} | candidates: ${Number(summary.candidateCount ?? 0)} | reviewable: ${reviewableCount}`);
  if (!scanFailed && inventoryIncomplete) lines.push("[WARN] inventory coverage is incomplete: filesystem-only empty-directory scan was truncated");
  const reason = textValue(result.reason, "");
  if (result.ok === false || reason) lines.push(`[FAIL] ${reason || "guardian_hygiene scan failed"}`);
  if (findings.length > 0) {
    lines.push("[WARN] findings:");
    for (const entry of findings) {
      const finding = recordValue(entry);
      lines.push(`  - ${textValue(finding.severity)} ${textValue(finding.category)} ${textValue(finding.path)}: ${textValue(finding.reason)}`);
    }
  }
  if (reviewableCount > 0) {
    lines.push(`[WARN] reviewable candidates: ${reviewableCount}${reviewableOmittedCount > 0 ? ` | omitted: ${reviewableOmittedCount}` : ""} | files covered: ${reviewableTotalFileCount} | bytes covered: ${reviewableTotalBytes}${reviewableBytesTruncated ? " (lower bound; measurement truncated)" : ""}`);
    lines.push("[INFO] reviewable entries require exact-path guardian_delete_paths planning if cleanup is intended");
    for (const entry of visibleReviewableCandidates) {
      const candidate = recordValue(entry);
      const fileCount = Number(candidate.fileCount ?? 1);
      const bytes = Number(candidate.bytes ?? 0);
      const bytesSuffix = candidate.bytesTruncated === true ? `${bytes}+ bytes` : `${bytes} bytes`;
      lines.push(`  - ${reviewableTextValue(candidate.status)} ${reviewableTextValue(candidate.path)} (${fileCount} file${fileCount === 1 ? "" : "s"}, ${bytesSuffix}): ${reviewableTextValue(candidate.reason)}`);
      lines.push(`    ${reviewableTextValue(candidate.suggestedDeletePathCommand)}`);
    }
  }
  const filesystemOnlyEmptyDirectories = arrayValue(result.filesystemOnlyEmptyDirectories);
  if (filesystemOnlyEmptyDirectories.length > 0) {
    lines.push(`[WARN] filesystem-only empty directories: ${filesystemOnlyEmptyDirectories.length} | omitted: 0`);
    for (const entry of filesystemOnlyEmptyDirectories) {
      const directory = recordValue(entry);
      lines.push(`  - ${reviewableTextValue(directory.classification)} ${reviewableTextValue(directory.path)}: ${reviewableTextValue(directory.reason)}`);
    }
  }
  const suggestions = arrayValue(result.suggestedCommands);
  appendBoundedList({ lines, heading: "[INFO] suggested commands", entries: suggestions, format: (command) => `  - ${textValue(command, String(command))}` });
  return lines.join("\n");
}

function formatGuardianHygienePlanOutput(rawResult: unknown) {
  const result = recordValue(rawResult);
  const summary = recordValue(result.summary);
  const targets = arrayValue(result.targets);
  const removedTargets = arrayValue(result.removedTargets);
  const blockers = arrayValue(result.blockers);
  const lines = [
    `${result.ok === false ? "[FAIL]" : result.status === "planned" ? "[WARN]" : "[GOOD]"} guardian_hygiene ${textValue(result.status)}`,
    `[INFO] approvedTargets: ${Number(summary.approvedTargetCount ?? targets.length)} | removedTargets: ${Number(summary.removedTargetCount ?? removedTargets.length)} | blockers: ${Number(summary.blockedTargetCount ?? blockers.length)} | fatal: ${Number(summary.fatalBlockerCount ?? 0)}`,
  ];
  const reason = textValue(result.reason, "");
  if (result.ok === false || reason) lines.push(`[FAIL] ${reason || "guardian_hygiene blocked"}`);
  appendBoundedList({
    lines,
    heading: "[INFO] approved targets",
    entries: targets,
    count: summary.approvedTargetCount,
    format: (entry) => {
      const target = recordValue(entry);
      return `  - ${textValue(target.category)} ${textValue(target.path)}: ${textValue(target.reason)}`;
    },
  });
  appendBoundedList({
    lines,
    heading: "[WARN] blockers",
    entries: blockers,
    count: summary.blockedTargetCount,
    format: (entry) => {
      const blocker = recordValue(entry);
      return `  - ${blocker.fatal === true ? "fatal" : "blocked"} ${textValue(blocker.path)}: ${textValue(blocker.reason)}`;
    },
  });
  return lines.join("\n");
}

export function formatGuardianDeleteOutput(rawResult: unknown) {
  const result = recordValue(rawResult);
  const preflight = recordValue(result.preflight);
  const lines = [
    `${result.ok === false ? "[FAIL]" : result.status === "planned" ? "[WARN]" : "[GOOD]"} guardian_delete_worktree ${textValue(result.status)}`,
    `[INFO] mode: ${textValue(preflight.mode)} | targetKind: ${textValue(preflight.targetKind, "worktree")} | deleteBranch: ${String(preflight.deleteBranch === true)} | abandonUnmerged: ${String(preflight.abandonUnmerged === true)} | branchDeleted: ${String(result.branchDeleted === true)} | worktreeRemoved: ${String(result.worktreeRemoved === true)}`,
    `[INFO] targetPath: ${textValue(preflight.targetPath ?? result.targetPath)}`,
    `[INFO] branch: ${textValue(preflight.branch ?? result.branch)} | head: ${shortCommit(preflight.head ?? result.head)}`,
  ];
  appendStashInventoryWarning(lines, preflight.stashCount);
  if (preflight.allowRedundantDirtyPaths === true || Number(preflight.redundantDirtyFileCount ?? 0) > 0) {
    lines.push(`[INFO] allowRedundantDirtyPaths: ${String(preflight.allowRedundantDirtyPaths === true)} | baseRef: ${textValue(preflight.baseRef)} | baseRefOid: ${shortCommit(preflight.baseRefOid)}`);
    lines.push(`[INFO] redundantDirtyFileCount: ${Number(preflight.redundantDirtyFileCount ?? 0)} | dirtySnapshotRef: ${textValue(preflight.dirtySnapshotRef ?? result.dirtySnapshotRef)}`);
    const proofs = arrayValue(preflight.redundantDirtyProofs);
    appendBoundedList({
      lines,
      heading: "[INFO] redundant dirty proofs",
      entries: proofs,
      format: (entry) => {
        const proof = recordValue(entry);
        return `  - ${textValue(proof.status)} ${textValue(proof.kind)} ${textValue(proof.path)}: matchesBase=${String(proof.matchesBase === true)}`;
      },
    });
  }
  if (preflight.ancestryProven === false || Number(preflight.unmergedCommitCount ?? 0) > 0) {
    lines.push(`[WARN] ancestryProven: ${String(preflight.ancestryProven === true)} | ancestryRef: ${textValue(preflight.ancestryRef)} | unmergedCommitCount: ${Number(preflight.unmergedCommitCount ?? 0)}`);
  }
  const reason = textValue(result.reason, "");
  if (result.ok === false || reason) lines.push(`[FAIL] ${reason || "guardian_delete_worktree blocked"}`);
  if (typeof result.confirmToken === "string") lines.push(`[WARN] confirmToken: ${result.confirmToken}`);
  if (typeof result.safetyRef === "string") lines.push(`[INFO] safetyRef: ${result.safetyRef}`);
  const blockers = arrayValue(preflight.blockers);
  appendBoundedList({ lines, heading: "[WARN] blockers", entries: blockers, format: (blocker) => `  - ${textValue(blocker, String(blocker))}` });
  return lines.join("\n");
}

export function formatGuardianDeletePathsOutput(rawResult: unknown) {
  const result = recordValue(rawResult);
  const summary = recordValue(result.summary);
  const targets = arrayValue(result.targets);
  const removedTargets = arrayValue(result.removedTargets);
  const blockers = arrayValue(result.blockers);
  const preflight = recordValue(result.preflight);
  const lines = [
    `${result.ok === false ? "[FAIL]" : result.status === "planned" ? "[WARN]" : "[GOOD]"} guardian_delete_paths ${textValue(result.status)}`,
    `[INFO] paths: ${arrayValue(preflight.paths).length} | approvedTargets: ${Number(summary.approvedTargetCount ?? targets.length)} | removedTargets: ${Number(summary.removedTargetCount ?? removedTargets.length)} | blockers: ${Number(summary.blockedTargetCount ?? blockers.length)} | fatal: ${Number(summary.fatalBlockerCount ?? 0)}`,
    `[INFO] allowTracked: ${String(preflight.allowTracked === true)} | allowRecursive: ${String(preflight.allowRecursive === true)}`,
  ];
  const reason = textValue(result.reason, "");
  if (result.ok === false || reason) lines.push(`[FAIL] ${reason || "guardian_delete_paths blocked"}`);
  appendBoundedList({
    lines,
    heading: "[INFO] approved targets",
    entries: targets,
    count: summary.approvedTargetCount,
    format: (entry) => {
      const target = recordValue(entry);
      return `  - ${textValue(target.status)} ${textValue(target.kind)} ${textValue(target.path)}`;
    },
  });
  appendBoundedList({
    lines,
    heading: "[WARN] blockers",
    entries: blockers,
    count: summary.blockedTargetCount,
    format: (entry) => {
      const blocker = recordValue(entry);
      return `  - ${blocker.fatal === true ? "fatal" : "blocked"} ${textValue(blocker.path)}: ${textValue(blocker.reason)}`;
    },
  });
  return lines.join("\n");
}

export function formatGuardianUnblockFinishOutput(rawResult: unknown) {
  const result = recordValue(rawResult);
  const preflight = recordValue(result.preflight);
  const lines = [
    `${result.ok === false ? "[FAIL]" : result.status === "planned" ? "[WARN]" : "[GOOD]"} guardian_unblock_finish ${textValue(result.status)}`,
    `[INFO] action: ${textValue(result.action ?? preflight.action)} | sessionId: ${textValue(preflight.sessionId)} | branch: ${textValue(preflight.branch)}`,
    `[INFO] worktreePath: ${textValue(preflight.worktreePath)}`,
  ];
  appendStashInventoryWarning(lines, preflight.stashCount);
  const reviewArtifactPaths = arrayValue(preflight.reviewArtifactPaths);
  appendBoundedList({ lines, heading: "[INFO] review artifacts", entries: reviewArtifactPaths, format: (entry) => `  - ${textValue(entry, String(entry))}` });
  const otherDirtyPaths = arrayValue(preflight.otherDirtyPaths);
  appendBoundedList({ lines, heading: "[WARN] other dirty paths", entries: otherDirtyPaths, format: (entry) => `  - ${textValue(entry, String(entry))}` });
  const reason = textValue(result.reason, "");
  if (result.ok === false || reason) lines.push(`[FAIL] ${reason || "guardian_unblock_finish blocked"}`);
  if (typeof result.nextAction === "string") lines.push(`[INFO] nextAction: ${textValue(result.nextAction)}`);
  if (typeof result.commitMessage === "string") lines.push(`[INFO] commitMessage: ${textValue(result.commitMessage)}`);
  if (typeof result.commit === "string") lines.push(`[INFO] commit: ${shortCommit(result.commit)}`);
  if (typeof result.safetyRef === "string") lines.push(`[INFO] safetyRef: ${result.safetyRef}`);
  return lines.join("\n");
}

export function formatGuardianQuarantineOutput(rawResult: unknown) {
  const result = recordValue(rawResult);
  const action = textValue(result.action);
  const quarantineId = textValue(result.quarantineId);
  const status = textValue(result.status, result.ok === false ? "blocked" : "planned");
  const lines = [`${result.ok === false ? "[FAIL]" : status === "planned" || status === "needs-selection" ? "[WARN]" : "[GOOD]"} guardian_quarantine ${status}`, `[INFO] action: ${action} | quarantineId: ${quarantineId}`];
  if (typeof result.selectedTargetWorktreePath === "string") lines.push(`[INFO] targetWorktreePath: ${textValue(result.selectedTargetWorktreePath)}`);
  const eligible = arrayValue(result.eligibleTargetWorktreePaths);
  appendBoundedList({ lines, heading: "[INFO] eligible restore worktrees", entries: eligible, format: (entry) => `  - ${textValue(entry, String(entry))}` });
  if (result.ok === false) lines.push(`[FAIL] ${textValue(result.reason, "guardian_quarantine blocked")}`);
  else if (typeof result.confirmToken === "string") lines.push(`[INFO] plan ready for explicit confirmation`);
  return lines.join("\n");
}
