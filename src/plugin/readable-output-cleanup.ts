import { arrayValue, recordValue, shortCommit, textValue } from "./readable-output-values.ts";

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
  const failCount = Number(recordValue(summary.bySeverity).fail ?? 0);
  const warnCount = Number(recordValue(summary.bySeverity).warn ?? 0);
  const scanFailed = result.ok === false || summary.scanFailed === true;
  const lines = [`${scanFailed ? "[FAIL]" : findings.length > 0 ? "[WARN]" : "[GOOD]"} guardian_hygiene scan`, `[INFO] repoRoot: ${textValue(result.repoRoot)}`];
  if (scanFailed) lines.push("[WARN] scan incomplete: findings and candidate counts are not trustworthy");
  else lines.push(`[INFO] findings: ${Number(summary.findingCount ?? findings.length)} | warn: ${warnCount} | fail: ${failCount} | exclusions: ${Number(summary.exclusionCount ?? exclusions.length)} | candidates: ${Number(summary.candidateCount ?? 0)} | reviewable: ${reviewableCount}`);
  const reason = textValue(result.reason, "");
  if (result.ok === false || reason) lines.push(`[FAIL] ${reason || "guardian_hygiene scan failed"}`);
  if (findings.length > 0) {
    lines.push("[WARN] top findings:");
    for (const entry of findings.slice(0, 8)) {
      const finding = recordValue(entry);
      lines.push(`  - ${textValue(finding.severity)} ${textValue(finding.category)} ${textValue(finding.path)}: ${textValue(finding.reason)}`);
    }
  }
  if (reviewableCount > 0) {
    lines.push(`[WARN] reviewable candidates: ${reviewableCount}${reviewableOmittedCount > 0 ? ` | omitted: ${reviewableOmittedCount}` : ""}`);
    lines.push("[INFO] reviewable entries require exact-path guardian_delete_paths planning if cleanup is intended");
    for (const entry of visibleReviewableCandidates) {
      const candidate = recordValue(entry);
      lines.push(`  - ${reviewableTextValue(candidate.status)} ${reviewableTextValue(candidate.path)}: ${reviewableTextValue(candidate.reason)}`);
      lines.push(`    ${reviewableTextValue(candidate.suggestedDeletePathCommand)}`);
    }
  }
  const suggestions = arrayValue(result.suggestedCommands);
  if (suggestions.length > 0) {
    lines.push("[INFO] suggested commands:");
    for (const command of suggestions.slice(0, 8)) lines.push(`  - ${textValue(command, String(command))}`);
  }
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
  if (targets.length > 0) {
    lines.push("[INFO] approved targets:");
    for (const entry of targets.slice(0, 8)) {
      const target = recordValue(entry);
      lines.push(`  - ${textValue(target.category)} ${textValue(target.path)}: ${textValue(target.reason)}`);
    }
  }
  if (blockers.length > 0) {
    lines.push("[WARN] blockers:");
    for (const entry of blockers.slice(0, 8)) {
      const blocker = recordValue(entry);
      lines.push(`  - ${blocker.fatal === true ? "fatal" : "blocked"} ${textValue(blocker.path)}: ${textValue(blocker.reason)}`);
    }
  }
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
  if (preflight.ancestryProven === false || Number(preflight.unmergedCommitCount ?? 0) > 0) {
    lines.push(`[WARN] ancestryProven: ${String(preflight.ancestryProven === true)} | ancestryRef: ${textValue(preflight.ancestryRef)} | unmergedCommitCount: ${Number(preflight.unmergedCommitCount ?? 0)}`);
  }
  const reason = textValue(result.reason, "");
  if (result.ok === false || reason) lines.push(`[FAIL] ${reason || "guardian_delete_worktree blocked"}`);
  if (typeof result.confirmToken === "string") lines.push(`[WARN] confirmToken: ${result.confirmToken}`);
  if (typeof result.safetyRef === "string") lines.push(`[INFO] safetyRef: ${result.safetyRef}`);
  const blockers = arrayValue(preflight.blockers);
  if (blockers.length > 0) {
    lines.push("[WARN] blockers:");
    for (const blocker of blockers.slice(0, 8)) lines.push(`  - ${textValue(blocker, String(blocker))}`);
  }
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
  if (targets.length > 0) {
    lines.push("[INFO] approved targets:");
    for (const entry of targets.slice(0, 8)) {
      const target = recordValue(entry);
      lines.push(`  - ${textValue(target.status)} ${textValue(target.kind)} ${textValue(target.path)}`);
    }
  }
  if (blockers.length > 0) {
    lines.push("[WARN] blockers:");
    for (const entry of blockers.slice(0, 8)) {
      const blocker = recordValue(entry);
      lines.push(`  - ${blocker.fatal === true ? "fatal" : "blocked"} ${textValue(blocker.path)}: ${textValue(blocker.reason)}`);
    }
  }
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
  const reviewArtifactPaths = arrayValue(preflight.reviewArtifactPaths);
  if (reviewArtifactPaths.length > 0) {
    lines.push(`[INFO] review artifacts: ${reviewArtifactPaths.length}`);
    for (const entry of reviewArtifactPaths.slice(0, 8)) lines.push(`  - ${textValue(entry, String(entry))}`);
  }
  const otherDirtyPaths = arrayValue(preflight.otherDirtyPaths);
  if (otherDirtyPaths.length > 0) {
    lines.push(`[WARN] other dirty paths: ${otherDirtyPaths.length}`);
    for (const entry of otherDirtyPaths.slice(0, 8)) lines.push(`  - ${textValue(entry, String(entry))}`);
  }
  const reason = textValue(result.reason, "");
  if (result.ok === false || reason) lines.push(`[FAIL] ${reason || "guardian_unblock_finish blocked"}`);
  if (typeof result.nextAction === "string") lines.push(`[INFO] nextAction: ${result.nextAction}`);
  if (typeof result.commitMessage === "string") lines.push(`[INFO] commitMessage: ${result.commitMessage}`);
  if (typeof result.commit === "string") lines.push(`[INFO] commit: ${shortCommit(result.commit)}`);
  if (typeof result.safetyRef === "string") lines.push(`[INFO] safetyRef: ${result.safetyRef}`);
  return lines.join("\n");
}
