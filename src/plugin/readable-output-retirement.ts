import { appendBoundedList, arrayValue, recordValue, shortCommit, textValue } from "./readable-output-values.ts";

function formatRetirement(entry: unknown): string {
  const retirement = recordValue(entry);
  const phase = textValue(retirement.reservationPhase, "active");
  const activeSafetyRef = phase === "active" && typeof retirement.safetyRef === "string" && retirement.safetyRef.length > 0;
  const preservation = activeSafetyRef
    ? ` safetyRef=${textValue(retirement.safetyRef)} remote branch preserved=true safety ref preserved=true`
    : " remote branch preserved=true safety-ref proof absent/pending";
  return `  - status=${textValue(retirement.status, "planned")} reservationPhase=${phase} remote=${textValue(retirement.remote)} remoteBranch=${textValue(retirement.remoteBranch)} head=${shortCommit(retirement.head)} observedHead=${shortCommit(retirement.observedHead)}${preservation}`;
}

function nonNegativeCount(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function optionalCount(result: Record<string, unknown>, key: string): string | null {
  const value = result[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? `${key === "retirementCandidateCount" ? "candidates" : key === "applyWorkCount" ? "applyWork" : key === "retiredCount" ? "retired" : "failed"}=${Math.floor(value)}` : null;
}

function nestedRecords(record: Record<string, unknown>): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [record];
  for (const key of ["plan", "apply", "preSession", "postSession"] as const) {
    const child = recordValue(record[key]);
    if (Object.keys(child).length > 0) records.push(...nestedRecords(child));
  }
  return records;
}

function reservationIdentity(entry: unknown): string {
  const reservation = recordValue(entry);
  return [
    "remote",
    "remoteBranch",
    "head",
    "observedHead",
    "reservationPhase",
    "safetyRef",
    "action",
    "remoteAction",
    "remoteBranchPresent",
  ].map((key) => `${key}=${textValue(reservation[key])}`).join("\u0000");
}

function uniqueEntries(entries: readonly unknown[], identityOf: (entry: unknown) => string, preferLast = false): unknown[] {
  if (preferLast) {
    const unique = new Map<string, unknown>();
    for (const entry of entries) unique.set(identityOf(entry), entry);
    return [...unique.values()];
  }
  const identities = new Set<string>();
  return entries.filter((entry) => {
    const identity = identityOf(entry);
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
}

function deferredIdentity(entry: unknown): string {
  const deferred = recordValue(entry);
  const nestedReservations = arrayValue(deferred.reservationRetirementCandidates).map(reservationIdentity).sort();
  if (nestedReservations.length === 0) return reservationIdentity(deferred);
  return ["kind", "status", "reason"].map((key) => `${key}=${textValue(deferred[key])}`).concat(nestedReservations).join("\u0000");
}

function retirementEvidence(result: Record<string, unknown>) {
  const cleanupSweep = recordValue(result.cleanupSweep);
  const aggregate = Object.keys(cleanupSweep).length > 0 ? cleanupSweep : result;
  const records = nestedRecords(aggregate);
  return {
    aggregate,
    candidates: uniqueEntries(records.flatMap((record) => arrayValue(record.reservationRetirementCandidates)), reservationIdentity),
    results: uniqueEntries(records.flatMap((record) => arrayValue(record.reservationRetirementResults)), reservationIdentity, true),
    freshPlanRequired: result.freshPlanRequired === true || records.some((record) => record.freshPlanRequired === true),
    deferred: uniqueEntries(records.flatMap((record) => arrayValue(record.remaining)).filter((entry) => recordValue(entry).kind === "reservation-retirement"), deferredIdentity).length,
  };
}

function summaryNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function formatCleanupSweepSummary(rawSweep: unknown): string {
  const sweep = recordValue(rawSweep);
  const base = `[INFO] cleanupSweep: ok=${String(sweep.ok === true)} status=${textValue(sweep.status)} candidates=${summaryNumber(sweep, "candidateCount")} cleaned=${summaryNumber(sweep, "cleanedCount")} failed=${summaryNumber(sweep, "failedCount")}`;
  const retirement = [
    ["retirementCandidates", summaryNumber(sweep, "retirementCandidateCount")],
    ["retired", summaryNumber(sweep, "retiredCount")],
    ["retirementFailed", summaryNumber(sweep, "retirementFailedCount")],
    ["applyWork", summaryNumber(sweep, "applyWorkCount")],
  ] as const;
  return retirement.some(([, count]) => count > 0) ? `${base} ${retirement.map(([label, count]) => `${label}=${count}`).join(" ")}` : base;
}

export function appendReservationRetirementEvidence(lines: string[], rawResult: unknown): void {
  const result = recordValue(rawResult);
  const evidence = retirementEvidence(result);
  const preflight = recordValue(evidence.aggregate.preflight);
  const candidates = evidence.candidates;
  const results = evidence.results;
  const summary = [
    optionalCount(evidence.aggregate, "retirementCandidateCount"),
    optionalCount(evidence.aggregate, "applyWorkCount"),
    optionalCount(evidence.aggregate, "retiredCount"),
    optionalCount(evidence.aggregate, "retirementFailedCount"),
  ].filter((entry): entry is string => entry !== null);
  if (summary.length > 0) lines.push(`[INFO] retirement summary: ${summary.join(" ")}`);
  appendBoundedList({
    lines,
    heading: "[WARN] reservation retirement candidates",
    entries: candidates,
    count: nonNegativeCount(preflight.reservationRetirementCandidateCount, candidates.length),
    format: formatRetirement,
  });
  appendBoundedList({
    lines,
    heading: "[INFO] reservation retirement results",
    entries: results,
    count: nonNegativeCount(preflight.reservationRetirementResultCount, results.length),
    format: formatRetirement,
  });
  if (evidence.deferred > 0) lines.push(`[WARN] deferred cleanup: ${evidence.deferred}`);
  if (evidence.freshPlanRequired) lines.push("[WARN] fresh plan required before cleanup");
}
