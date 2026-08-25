import crypto from "node:crypto";
import { compareCodeUnits } from "./goal-hygiene-postcondition.ts";
import type { GuardianToolResult, MutableRecord, RecordLike } from "./types.ts";
import { isRecordLike } from "./types.ts";

const PREVIEW_LIMIT = 8;
const DIGEST_TUPLE_LIMIT = 1024;
const STRING_BYTE_LIMIT = 256;
const PROJECTION_BYTE_LIMIT = 16_384;
const TRUNCATION_MARKER = "[truncated]";
const VALID_CONFIRM_TOKEN = /^[0-9a-f]{64}$/;
const SUMMARY_NUMBER_KEYS = ["candidateCount", "findingCount", "exclusionCount", "protectedInventoryCount", "protectedInventoryFileCount", "protectedInventoryDirectoryCount", "protectedInventoryTotalBytes", "reviewableCandidateCount", "reviewableShownCount", "reviewableOmittedCount", "reviewableTotalFileCount", "approvedTargetCount", "blockedTargetCount", "fatalBlockerCount", "removedTargetCount"] as const;
const SUMMARY_BOOLEAN_KEYS = ["protectedInventoryBytesTruncated", "reviewableTruncated", "scanFailed"] as const;
const TARGET_PREVIEW_FIELDS = ["path", "category", "severity", "reason", "kind"] as const;
const TARGET_DIGEST_FIELDS = [...TARGET_PREVIEW_FIELDS, "fingerprint"] as const;
const BLOCKER_FIELDS = ["path", "category", "reason", "fatal"] as const;

type Scalar = boolean | number | string | null;
type ScalarRecord = Record<string, Scalar>;
type Tuple = readonly string[];
type PreviewList = {
  readonly name: string;
  readonly total: number;
  readonly entries: ScalarRecord[];
  readonly value: MutableRecord;
};

function record(value: unknown): RecordLike {
  return isRecordLike(value) ? value : {};
}

function boundedText(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= STRING_BYTE_LIMIT) return value;
  const available = STRING_BYTE_LIMIT - Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  let byteLength = 0;
  let output = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (byteLength + characterBytes > available) break;
    output += character;
    byteLength += characterBytes;
  }
  return `${output}${TRUNCATION_MARKER}`;
}

function scalar(value: unknown): Scalar | undefined {
  if (typeof value === "string") return boundedText(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean" || value === null) return value;
  return undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? boundedText(value) : undefined;
}

function validConfirmToken(value: unknown): string | undefined {
  return typeof value === "string" && VALID_CONFIRM_TOKEN.test(value) ? value : undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function projectSummary(value: unknown): MutableRecord {
  const summary = record(value);
  const bySeverity = record(summary.bySeverity);
  const byCategory = record(summary.byCategory);
  const output: MutableRecord = {};
  for (const key of SUMMARY_NUMBER_KEYS) output[key] = count(summary[key]);
  output.bySeverity = { warn: count(bySeverity.warn), fail: count(bySeverity.fail) };
  output.byCategory = {
    "known-cleanable": count(byCategory["known-cleanable"]),
    "nested-git": count(byCategory["nested-git"]),
    suspicious: count(byCategory.suspicious),
  };
  for (const key of SUMMARY_BOOLEAN_KEYS) output[key] = summary[key] === true;
  return output;
}

function previewRecord(value: unknown, fields: readonly string[]): ScalarRecord {
  const source = record(value);
  const output: ScalarRecord = {};
  for (const field of fields) {
    const value = scalar(source[field]);
    if (value !== undefined) output[field] = value;
  }
  return output;
}

function previewScalar(value: unknown, field: string): ScalarRecord {
  const item = scalar(value);
  return item === undefined ? {} : { [field]: item };
}

function projectList(name: string, value: unknown, fields: readonly string[], scalarField?: string): PreviewList {
  const source = Array.isArray(value) ? value : [];
  const entries = source.slice(0, PREVIEW_LIMIT).map((entry) => scalarField ? previewScalar(entry, scalarField) : previewRecord(entry, fields));
  const output: MutableRecord = {
    [name]: entries,
    [`${name}Total`]: source.length,
    [`${name}OmittedCount`]: source.length - entries.length,
  };
  return { name, total: source.length, entries, value: output };
}

function tupleComparison(left: Tuple, right: Tuple): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = compareCodeUnits(left[index] ?? "", right[index] ?? "");
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function scalarToken(value: unknown): string {
  const item = scalar(value);
  if (item === undefined) return "undefined";
  if (item === null) return "null";
  return `${typeof item}:${String(item)}`;
}

function fieldTuple(scope: string, value: unknown, fields: readonly string[]): Tuple {
  const source = record(value);
  return [scope, ...fields.flatMap((field) => [field, scalarToken(source[field])])];
}

function addSummaryTuples(tuples: Tuple[], scope: string, value: unknown): void {
  const summary = record(value);
  const bySeverity = record(summary.bySeverity);
  const byCategory = record(summary.byCategory);
  tuples.push(fieldTuple(`${scope}:summary`, summary, SUMMARY_NUMBER_KEYS));
  tuples.push(fieldTuple(`${scope}:severity`, bySeverity, ["warn", "fail"]));
  tuples.push(fieldTuple(`${scope}:category`, byCategory, ["known-cleanable", "nested-git", "suspicious"]));
  tuples.push(fieldTuple(`${scope}:flags`, summary, SUMMARY_BOOLEAN_KEYS));
}

function addListTuples(tuples: Tuple[], scope: string, value: unknown, fields: readonly string[], scalarField?: string): void {
  const source = Array.isArray(value) ? value : [];
  tuples.push([scope, "total", String(source.length), "overflow", String(source.length >= DIGEST_TUPLE_LIMIT)]);
  const limit = Math.min(source.length, DIGEST_TUPLE_LIMIT - 1);
  for (let index = 0; index < limit; index += 1) {
    tuples.push(scalarField ? [scope, scalarField, scalarToken(source[index])] : fieldTuple(scope, source[index], fields));
  }
}

function appendTuple(hash: crypto.Hash, tuple: Tuple): void {
  hash.update(`${tuple.length}:`);
  for (const value of tuple) hash.update(`${Buffer.byteLength(value, "utf8")}:${value}`);
}

function resultDigest(result: GuardianToolResult): string {
  const source = record(result);
  const preflight = record(source.preflight);
  const report = record(source.report);
  const tuples: Tuple[] = [
    ["version", "2"],
    ["result", "ok", String(result.ok !== false), "status", text(result.status) ?? (result.ok === false ? "blocked" : "planned"), "reason", scalarToken(result.reason), "confirmToken", validConfirmToken(result.confirmToken) ?? "undefined", "tokenMatched", scalarToken(result.tokenMatched)],
    fieldTuple("preflight", preflight, ["repoRoot", "mode", "allowDirtyNestedGit"]),
    fieldTuple("report", report, ["action", "mode", "repoRoot"]),
  ];
  addSummaryTuples(tuples, "result", source.summary);
  addSummaryTuples(tuples, "preflight", preflight.summary);
  addSummaryTuples(tuples, "report", report.summary);
  addListTuples(tuples, "result:targets", source.targets, TARGET_DIGEST_FIELDS);
  addListTuples(tuples, "result:removedTargets", source.removedTargets, TARGET_DIGEST_FIELDS);
  addListTuples(tuples, "result:blockers", source.blockers, BLOCKER_FIELDS);
  addListTuples(tuples, "result:suggestedCommands", source.suggestedCommands, [], "command");
  addListTuples(tuples, "preflight:allowCategories", preflight.allowCategories, [], "category");
  addListTuples(tuples, "preflight:cleanupPaths", preflight.cleanupPaths, [], "path");
  addListTuples(tuples, "preflight:targets", preflight.targets, TARGET_DIGEST_FIELDS);
  addListTuples(tuples, "preflight:blockers", preflight.blockers, BLOCKER_FIELDS);
  addListTuples(tuples, "report:cleanupPaths", report.cleanupPaths, [], "path");
  addListTuples(tuples, "report:approvedTargets", report.approvedTargets, [], "path");
  addListTuples(tuples, "report:removedTargets", report.removedTargets, [], "path");
  addListTuples(tuples, "report:blockers", report.blockers, BLOCKER_FIELDS);
  const hash = crypto.createHash("sha256");
  for (const tuple of tuples.sort(tupleComparison)) appendTuple(hash, tuple);
  return hash.digest("hex");
}

function projectPreflight(value: unknown, lists: PreviewList[]): MutableRecord {
  const source = record(value);
  const allowCategories = projectList("allowCategories", source.allowCategories, [], "category");
  const cleanupPaths = projectList("cleanupPaths", source.cleanupPaths, [], "path");
  const targets = projectList("targets", source.targets, TARGET_PREVIEW_FIELDS);
  const blockers = projectList("blockers", source.blockers, BLOCKER_FIELDS);
  lists.push(allowCategories, cleanupPaths, targets, blockers);
  const repoRoot = text(source.repoRoot);
  const mode = text(source.mode);
  return {
    ...(repoRoot === undefined ? {} : { repoRoot }),
    ...(mode === undefined ? {} : { mode }),
    ...(typeof source.allowDirtyNestedGit === "boolean" ? { allowDirtyNestedGit: source.allowDirtyNestedGit } : {}),
    summary: projectSummary(source.summary),
    ...allowCategories.value,
    ...cleanupPaths.value,
    ...targets.value,
    ...blockers.value,
  };
}

function projectReport(value: unknown, lists: PreviewList[]): MutableRecord {
  const source = record(value);
  const cleanupPaths = projectList("cleanupPaths", source.cleanupPaths, [], "path");
  const approvedTargets = projectList("approvedTargets", source.approvedTargets, [], "path");
  const removedTargets = projectList("removedTargets", source.removedTargets, [], "path");
  const blockers = projectList("blockers", source.blockers, BLOCKER_FIELDS);
  lists.push(cleanupPaths, approvedTargets, removedTargets, blockers);
  const action = text(source.action);
  const mode = text(source.mode);
  const repoRoot = text(source.repoRoot);
  return {
    ...(action === undefined ? {} : { action }),
    ...(mode === undefined ? {} : { mode }),
    ...(repoRoot === undefined ? {} : { repoRoot }),
    summary: projectSummary(source.summary),
    ...cleanupPaths.value,
    ...approvedTargets.value,
    ...removedTargets.value,
    ...blockers.value,
  };
}

function enforceProjectionLimit(result: GuardianToolResult, lists: readonly PreviewList[]): void {
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > PROJECTION_BYTE_LIMIT) {
    const list = lists.find((candidate) => candidate.entries.length > 0);
    if (!list) return;
    list.entries.pop();
    list.value[`${list.name}OmittedCount`] = list.total - list.entries.length;
  }
}

export function projectGoalHygieneResult(result: GuardianToolResult): GuardianToolResult {
  const source = record(result);
  const lists: PreviewList[] = [];
  const targets = projectList("targets", source.targets, TARGET_PREVIEW_FIELDS);
  const removedTargets = projectList("removedTargets", source.removedTargets, TARGET_PREVIEW_FIELDS);
  const blockers = projectList("blockers", source.blockers, BLOCKER_FIELDS);
  const suggestedCommands = projectList("suggestedCommands", source.suggestedCommands, [], "command");
  lists.push(targets, removedTargets, blockers, suggestedCommands);
  const reason = text(source.reason);
  const confirmToken = validConfirmToken(source.confirmToken);
  const output: GuardianToolResult = {
    ok: result.ok !== false,
    status: text(result.status) ?? (result.ok === false ? "blocked" : "planned"),
    ...(reason === undefined ? {} : { reason }),
    ...(confirmToken === undefined ? {} : { confirmToken }),
    ...(typeof source.tokenMatched === "boolean" ? { tokenMatched: source.tokenMatched } : {}),
    digest: resultDigest(result),
    summary: projectSummary(source.summary),
    ...targets.value,
    ...removedTargets.value,
    ...blockers.value,
    preflight: projectPreflight(source.preflight, lists),
    report: projectReport(source.report, lists),
    ...suggestedCommands.value,
  };
  enforceProjectionLimit(output, lists);
  return output;
}
