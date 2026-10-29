import { appendCleanupEvidence, appendFinalPostflightEvidence } from "./readable-output-evidence.ts";
import { appendReservationRetirementEvidence } from "./readable-output-retirement.ts";
import { appendBoundedList, appendStashInventoryWarning, arrayValue, recordValue, shortCommit, textValue } from "./readable-output-values.ts";
import { sanitizeGoalResidualText } from "../goal-hygiene-postcondition.ts";

function statusPrefix(result: Record<string, unknown>): "[FAIL]" | "[WARN]" | "[GOOD]" {
  if (result.ok === false || result.status === "blocked") return "[FAIL]";
  if (result.status === "planned" || result.status === "planned-partial" || result.status === "partial") return "[WARN]";
  return "[GOOD]";
}

function boolText(goal: Record<string, unknown>, key: string): string {
  return `${key}=${String(goal[key] === true)}`;
}

function formatGoalFlags(goal: Record<string, unknown>): string {
  return [
    boolText(goal, "commitDirty"),
    boolText(goal, "landToBase"),
    boolText(goal, "pushBase"),
    boolText(goal, "cleanupWorktrees"),
    boolText(goal, "cleanupBranches"),
    boolText(goal, "cleanupHygiene"),
  ].join(" ");
}

function formatStep(entry: unknown): string {
  const step = recordValue(entry);
  const result = recordValue(step.result);
  const summary = recordValue(result.summary);
  const lane = textValue(result.lane, "");
  const reason = textValue(step.reason ?? result.reason, "");
  const hygieneTargets = Number(summary.approvedTargetCount ?? arrayValue(result.targets).length);
  const blockers = arrayValue(result.blockers).length || Number(summary.blockedTargetCount ?? 0);
  const details = step.tool === "guardian_hygiene"
    ? ` targets=${hygieneTargets} blockers=${blockers}`
    : lane
      ? ` lane=${lane}`
      : "";
  return `  - ${textValue(step.tool)} status=${textValue(step.status)} ok=${String(step.ok === true)}${details}${reason ? ` reason=${reason}` : ""}`;
}

function appendHygienePostcondition(lines: string[], value: unknown, complete: boolean | null): void {
  const postcondition = recordValue(value);
  if (Object.keys(postcondition).length === 0) return;
  const counts = recordValue(postcondition.residualByCategory);
  const protectedInventory = recordValue(postcondition.protectedInventory);
  const shownProtectedRoots = arrayValue(protectedInventory.rootsShown);
  const shownFindings = arrayValue(postcondition.residualFindingsShown);
  const shownReviewables = arrayValue(postcondition.reviewableCandidatesShown);
  const residualCount = Number(postcondition.residualCount ?? 0);
  const reviewableCount = Number(postcondition.reviewableCandidateCount ?? 0);
  const completeText = complete === null ? "pending" : String(complete);
  lines.push(`[INFO] hygiene mode=${sanitizeGoalResidualText(postcondition.mode)} phase=${sanitizeGoalResidualText(postcondition.phase)} status=${sanitizeGoalResidualText(postcondition.status)} complete=${completeText}`);
  lines.push(`[${residualCount > 0 ? "WARN" : "INFO"}] hygiene residuals: ${residualCount} | known-cleanable=${Number(counts["known-cleanable"] ?? 0)} | empty-directory=${Number(counts["filesystem-only-empty-directory"] ?? 0)} | nested-git=${Number(counts["nested-git"] ?? 0)} | suspicious=${Number(counts.suspicious ?? 0)}`);
  if (shownFindings.length > 0) {
    appendBoundedList({
      lines,
      heading: "[WARN] hygiene residual findings",
      entries: shownFindings,
      count: postcondition.residualFindingCount ?? residualCount,
      format: (entry) => {
      const finding = recordValue(entry);
        return `  - ${sanitizeGoalResidualText(finding.category)} ${sanitizeGoalResidualText(finding.path)}: ${sanitizeGoalResidualText(finding.reason)}`;
      },
    });
  }
  if (reviewableCount > 0) {
    appendBoundedList({
      lines,
      heading: "[WARN] hygiene reviewable candidates",
      entries: shownReviewables,
      count: reviewableCount,
      format: (entry) => {
        const candidate = recordValue(entry);
        const fileCount = Number(candidate.fileCount ?? 0);
        const bytes = Number(candidate.bytes ?? 0);
        const bytesSuffix = candidate.bytesTruncated === true ? `${bytes}+` : String(bytes);
        return `  - ${sanitizeGoalResidualText(candidate.status)} ${sanitizeGoalResidualText(candidate.path)} (${fileCount} file${fileCount === 1 ? "" : "s"}, ${bytesSuffix} bytes): ${sanitizeGoalResidualText(candidate.reason)}\n    next: ${sanitizeGoalResidualText(candidate.suggestedDeletePathCommand)}`;
      },
    });
    lines.push(`[INFO] reviewable digest: ${sanitizeGoalResidualText(postcondition.reviewableDigest)}`);
    lines.push("[INFO] reviewable resolution: pass exact current regular newly added files through intentionalPaths in both goal phases, or use the exact guardian_delete_paths mode=plan command above; tracked additions require allowTracked=true");
  }
  if (postcondition.reviewableInventoryComplete === false) lines.push("[WARN] hygiene inventory coverage is incomplete; strict residue completion remains partial");
  lines.push(`[INFO] hygiene exclusions: ${Number(postcondition.protectedExclusionCount ?? 0)} | reviewable inventory: ${reviewableCount}`);
  const protectedRootCount = Number(protectedInventory.rootCount ?? 0);
  if (protectedRootCount > 0) {
    const protectedBytes = Number(protectedInventory.totalBytes ?? 0);
    const rootsTruncated = protectedInventory.rootsTruncated === true;
    const protectedMeasurementSuffix = protectedInventory.bytesTruncated === true ? "+" : "";
    lines.push(`[WARN] protected inventory: ${protectedRootCount}${rootsTruncated ? "+" : ""} root${protectedRootCount === 1 && !rootsTruncated ? "" : "s"} | files=${Number(protectedInventory.fileCount ?? 0)}${protectedMeasurementSuffix} | directories=${Number(protectedInventory.directoryCount ?? 0)}${protectedMeasurementSuffix} | bytes=${protectedBytes}${protectedMeasurementSuffix} | assessment=not-assessed | cleanup-authorized=false`);
    appendBoundedList({
      lines,
      heading: "[WARN] protected roots requiring retention review",
      entries: shownProtectedRoots,
      count: protectedRootCount,
      countIsLowerBound: rootsTruncated,
      limit: 12,
      format: (entry) => `  - ${sanitizeGoalResidualText(entry)}`,
    });
    if (rootsTruncated) lines.push("[WARN] additional protected roots were omitted by the bounded inventory");
  }
}

function appendSessionCompletionProof(lines: string[], result: Record<string, unknown>, scope: Record<string, unknown>, steps: unknown[]): void {
  const proofStep = recordValue(steps.find((entry) => recordValue(entry).tool === "guardian_goal"));
  const proof = recordValue(proofStep.result);
  const session = recordValue(proof.session);
  const receipt = recordValue(result.completionProof);
  const remoteStep = recordValue(steps.find((entry) => recordValue(entry).tool === "guardian_delete_remote_branch"));
  const remoteResult = recordValue(remoteStep.result);
  const remotePreflight = recordValue(remoteResult.preflight);
  const targetAbsent = result.ok === true && recordValue(result.hygienePostcondition).targetAbsent === true;
  const absence = (value: unknown) => value === true ? "true" : value === false ? "false" : "not-revalidated";
  const phase = textValue(receipt.phase, "not-prepared");
  const remoteObserved = proof.observedRemoteHead !== undefined ? proof.observedRemoteHead : remotePreflight.observedRemoteHead;
  const sourceObservation = result.ok === true && result.complete === true
    ? "absent (verified)"
    : remoteObserved === null ? "absent (owned receipt reconciliation)" : textValue(remoteObserved, "not-revalidated");
  lines.push(`[INFO] scoped deletion proof: session=${textValue(scope.sessionId)} | remote=${textValue(receipt.remote ?? remotePreflight.remote ?? remoteResult.remote)} | branch=${textValue(session.branch ?? receipt.branch ?? remotePreflight.remoteBranch ?? remoteResult.remoteBranch)}`);
  lines.push(`[INFO] original worktree: ${textValue(session.worktree_path ?? receipt.worktree_path)}`);
  lines.push(`[INFO] original baseline: ${textValue(session.started_head_commit ?? receipt.started_head_commit ?? recordValue(result.trackedBaseline).commit)}`);
  lines.push(`[INFO] expected source OID: ${textValue(proof.expectedRemoteHead ?? receipt.expected_remote_head ?? remotePreflight.expectedRemoteHead)}`);
  lines.push(`[INFO] landed base OID: ${textValue(proof.landedBaseHead ?? receipt.landed_base_head)}`);
  lines.push(`[INFO] authoritative base: ${textValue(proof.baseRef ?? remotePreflight.baseRef ?? receipt.base_ref)} | observed OID=${textValue(proof.observedBaseHead ?? remotePreflight.baseRefOid ?? receipt.observed_base_head)}`);
  lines.push(`[INFO] safety ref: ${textValue(proof.safetyRef ?? receipt.safety_ref ?? remotePreflight.safetyRef ?? remoteResult.safetyRef)} | create-only before exact-head leased source deletion`);
  lines.push(`[INFO] absence checks: worktreeAbsent=${absence(proof.worktreeAbsent ?? (targetAbsent ? true : undefined))} | localBranchAbsent=${absence(proof.localBranchAbsent ?? (targetAbsent ? true : undefined))} | remote source=${sourceObservation}`);
  lines.push(`[INFO] nonancestor deletion opt-in: ${absence(receipt.allow_nonancestor_remote_deletion ?? remotePreflight.allowNonAncestorRemoteDeletion)}`);
  lines.push(`[INFO] completion receipt: version=${receipt.version === 1 ? "1" : "not-prepared"} | phase=${phase}`);
  if (receipt.phase === "prepared") lines.push("[WARN] prepared recovery: retain this receipt and safety ref; re-plan/reconcile only the identical owned session and proof");
  if (receipt.phase !== "prepared" && receipt.phase !== "complete") lines.push("[INFO] apply records prepared before remote mutation and complete only after revalidated owned postconditions");
  lines.push("[WARN] limits: committed delivery and current owned-target absence only; historical dirty, ignored and untracked filesystem disposition is the external operator's attestation, not verified here. No primary publishing, hygiene, bulk GC or unrelated-session cleanup.");
}

export function formatGuardianGoalOutput(rawResult: unknown): string {
  const result = recordValue(rawResult);
  const goal = recordValue(result.goal);
  const scope = recordValue(result.scope);
  const steps = arrayValue(result.steps);
  const blockers = arrayValue(result.blockers);
  const intentionalPaths = arrayValue(result.intentionalPaths);
  const lines = [
    `${statusPrefix(result)} guardian_goal ${textValue(result.status)}`,
    scope.kind === "session"
      ? `[INFO] scope: session sessionId=${textValue(scope.sessionId)} | complete=${result.complete === null ? "pending" : String(result.complete === true)} | session completion only; not a project-cleanliness claim`
      : `[INFO] desired: ${formatGoalFlags(goal)}`,
    `[INFO] steps: ${steps.length} | blockers: ${blockers.length}`,
  ];
  if (scope.kind === "session") appendSessionCompletionProof(lines, result, scope, steps);
  const trackedBaseline = recordValue(result.trackedBaseline);
  if (typeof trackedBaseline.commit === "string") lines.push(`[INFO] tracked baseline: ${shortCommit(trackedBaseline.commit)} | source=${textValue(trackedBaseline.source)}`);
  appendBoundedList({ lines, heading: "[INFO] one-shot intentional paths", entries: intentionalPaths, limit: 12, format: (entry) => `  - ${sanitizeGoalResidualText(entry)}` });
  appendHygienePostcondition(lines, result.hygienePostcondition, result.complete === null ? null : result.complete === true);
  const doneStep = steps.map(recordValue).find((step) => step.tool === "guardian_done" || step.tool === "guardian_finish_workflow");
  const doneResult = recordValue(doneStep?.result);
  const donePreflight = recordValue(doneResult.preflight);
  const doneCleanupPlan = recordValue(doneResult.cleanupPlan);
  const doneCleanupPreflight = recordValue(doneCleanupPlan.preflight);
  appendStashInventoryWarning(lines, donePreflight.stashCount ?? doneResult.stashCount ?? doneCleanupPreflight.stashCount);
  const reason = textValue(result.reason, "");
  if (result.ok === false && reason) lines.push(`[FAIL] ${reason}`);
  if (typeof result.nextAction === "string") lines.push(`[INFO] nextAction: ${textValue(result.nextAction)}`);
  appendBoundedList({ lines, heading: "[INFO] goal steps", entries: steps, format: formatStep });
  appendBoundedList({ lines, heading: "[WARN] blockers", entries: blockers, format: (entry) => {
    const blocker = recordValue(entry);
    return `  - ${textValue(blocker.tool)}: ${textValue(blocker.reason)}`;
  } });
  for (const step of steps.map(recordValue)) {
    const nested = recordValue(step.result);
    if (Object.keys(nested).length === 0 || (step.tool !== "guardian_done" && step.tool !== "guardian_finish_workflow")) continue;
    lines.push(`[${nested.ok === false || nested.status === "blocked" || nested.status === "partial" || nested.status === "planned-partial" ? "WARN" : "INFO"}] ${textValue(step.tool)} evidence:`);
    appendCleanupEvidence(lines, nested);
    appendReservationRetirementEvidence(lines, nested);
    appendFinalPostflightEvidence(lines, nested.finalPostflight);
  }
  if (typeof result.commit === "string") lines.push(`[INFO] commit: ${shortCommit(result.commit)}`);
  return lines.join("\n");
}
