import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isEnoent, isSameOrInside } from "./filesystem-boundaries.ts";
import { parseQuarantineJournalRecord } from "./quarantine-types.ts";
import { withStateTransaction } from "./state.ts";
import { ensureDurableDirectory, writeDurableCreate } from "./state-durable-file.ts";
import type { GuardianPaths } from "./types.ts";
import type { QuarantineItemRecordV1, QuarantineMoveOperationPhase, QuarantineOperationRecordV1, QuarantinePurgeOperationPhase } from "./quarantine-types.ts";
import { errorCode } from "./types.ts";

export { reconcileQuarantineOperation } from "./quarantine-journal-reconcile.ts";
export type { QuarantineEvidence, QuarantineReconciliation } from "./quarantine-journal-reconcile.ts";

export type QuarantineJournalErrorKind = "collision" | "digest" | "identity" | "invalid" | "transition" | "symlink";

export class QuarantineJournalError extends Error {
  override readonly name = "QuarantineJournalError";
  readonly kind: QuarantineJournalErrorKind;
  constructor(kind: QuarantineJournalErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export type JournaledRecord<T> = { readonly record: T; readonly digest: string; readonly relativePath: string };
export type QuarantineJournalHooks = { readonly afterRecordDurable?: (record: JournaledRecord<QuarantineItemRecordV1 | QuarantineOperationRecordV1>) => Promise<void> };
export type QuarantineJournalWriteInput<T> = { readonly paths: GuardianPaths; readonly record: T; readonly hooks?: QuarantineJournalHooks };
export type QuarantineItemTransition = Omit<QuarantineItemRecordV1, "version" | "kind">;
export type QuarantineOperationTransition = Omit<QuarantineOperationRecordV1, "version" | "kind">;

function digest(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function journalError(kind: QuarantineJournalErrorKind, message: string): QuarantineJournalError {
  return new QuarantineJournalError(kind, message);
}

function recordContent(record: QuarantineItemRecordV1 | QuarantineOperationRecordV1): string {
  return `${JSON.stringify(record)}\n`;
}

function recordFileName(record: QuarantineItemRecordV1 | QuarantineOperationRecordV1): string {
  const predecessor = record.predecessorDigest ?? "root";
  return record.kind === "quarantine-item" ? `${record.state}-${predecessor}.json` : `${record.phase}-${predecessor}.json`;
}

function recordDirectory(paths: GuardianPaths, record: QuarantineItemRecordV1 | QuarantineOperationRecordV1): string {
  const identity = record.kind === "quarantine-item" ? record.quarantineId : record.operationId;
  return path.join(paths.journalDir, record.kind === "quarantine-item" ? "items" : "operations", digest(identity));
}

function recordPath(paths: GuardianPaths, record: QuarantineItemRecordV1 | QuarantineOperationRecordV1): string {
  return path.join(recordDirectory(paths, record), recordFileName(record));
}

async function assertMetadataPath(paths: GuardianPaths, target: string): Promise<void> {
  if (!isSameOrInside(target, paths.gitDir)) throw journalError("invalid", `Quarantine journal escapes common Git directory: ${target}`);
  const parts = path.relative(paths.gitDir, target).split(path.sep).filter(Boolean);
  let current = paths.gitDir;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw journalError("symlink", `Refusing quarantine journal symlink: ${current}`);
      if (!isSameOrInside(await fs.realpath(current), paths.gitDir)) throw journalError("symlink", `Quarantine journal ancestor escapes common Git directory: ${current}`);
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
  }
}

async function prepareMetadata(paths: GuardianPaths, target: string): Promise<void> {
  await assertMetadataPath(paths, target);
  await ensureDurableDirectory(paths.dir);
  await ensureDurableDirectory(paths.journalDir);
  await ensureDurableDirectory(paths.lockTmpDir);
  await ensureDurableDirectory(path.dirname(target));
  await assertMetadataPath(paths, target);
}

function asJournaledRecord(content: string, relativePath: string): JournaledRecord<QuarantineItemRecordV1 | QuarantineOperationRecordV1> {
  const actualDigest = digest(content);
  try {
    return { record: parseQuarantineJournalRecord(JSON.parse(content)), digest: actualDigest, relativePath };
  } catch (error) {
    throw journalError("invalid", `Malformed quarantine journal record: ${relativePath}`);
  }
}

async function readDirectory(paths: GuardianPaths, kind: "items" | "operations", identifier: string): Promise<readonly JournaledRecord<QuarantineItemRecordV1 | QuarantineOperationRecordV1>[]> {
  const directory = path.join(paths.journalDir, kind, digest(identifier));
  await assertMetadataPath(paths, directory);
  let entries: readonly import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const records: JournaledRecord<QuarantineItemRecordV1 | QuarantineOperationRecordV1>[] = [];
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile()) throw journalError("invalid", `Quarantine journal contains a non-file record: ${path.join(directory, entry.name)}`);
    const target = path.join(directory, entry.name);
    await assertMetadataPath(paths, target);
    const relativePath = path.relative(paths.dir, target).split(path.sep).join("/");
    const journaled = asJournaledRecord(await fs.readFile(target, "utf8"), relativePath);
    if (recordFileName(journaled.record) !== entry.name || recordDirectory(paths, journaled.record) !== directory) throw journalError("identity", `Quarantine journal record path identity mismatch: ${relativePath}`);
    if (kind === "items" && (journaled.record.kind !== "quarantine-item" || journaled.record.quarantineId !== identifier)) throw journalError("identity", `Quarantine item identity mismatch: ${relativePath}`);
    if (kind === "operations" && (journaled.record.kind !== "quarantine-operation" || journaled.record.operationId !== identifier)) throw journalError("identity", `Quarantine operation identity mismatch: ${relativePath}`);
    records.push(journaled);
  }
  return records;
}

function terminalRecord<T extends QuarantineItemRecordV1 | QuarantineOperationRecordV1>(records: readonly JournaledRecord<T>[], label: string): JournaledRecord<T> | undefined {
  if (records.length === 0) return undefined;
  const roots = records.filter((record) => record.record.predecessorDigest === undefined);
  if (roots.length !== 1) throw journalError("transition", `${label} must have exactly one root transition`);
  let current = roots[0];
  if (!current) throw journalError("transition", `${label} root is missing`);
  const seen = new Set<string>();
  while (true) {
    if (seen.has(current.digest)) throw journalError("transition", `${label} has a predecessor cycle`);
    seen.add(current.digest);
    const successors = records.filter((candidate) => candidate.record.predecessorDigest === current.digest);
    if (successors.length === 0) return current;
    if (successors.length !== 1) throw journalError("transition", `${label} has multiple successor transitions`);
    const successor = successors[0];
    if (!successor) throw journalError("transition", `${label} successor is missing`);
    current = successor;
  }
}

function sameIdentity(left: QuarantineItemRecordV1 | QuarantineOperationRecordV1, right: QuarantineItemRecordV1 | QuarantineOperationRecordV1): boolean {
  return left.quarantineId === right.quarantineId && left.sessionId === right.sessionId && left.lineageId === right.lineageId
    && left.originalRelativePath === right.originalRelativePath && left.originalWorktreePath === right.originalWorktreePath && left.artifactPath === right.artifactPath
    && JSON.stringify(left.fingerprint) === JSON.stringify(right.fingerprint) && left.fingerprintDigest === right.fingerprintDigest && left.manifestDigest === right.manifestDigest
    && left.doneIntentDigest === right.doneIntentDigest && left.guardianStateRevision === right.guardianStateRevision && left.sessionRevision === right.sessionRevision
    && left.deviceId === right.deviceId && left.nonce === right.nonce && left.createdAt === right.createdAt;
}

function itemTransitionAllowed(current: JournaledRecord<QuarantineItemRecordV1> | undefined, next: QuarantineItemRecordV1): void {
  if (!current) {
    if (next.state !== "available" || next.predecessorDigest !== undefined) throw journalError("transition", "An absent quarantine item can only transition to available");
    return;
  }
  if (current.record.state !== "available") throw journalError("transition", `Quarantine item is terminal: ${current.record.state}`);
  if (next.state === "available" || next.predecessorDigest !== current.digest || !sameIdentity(current.record, next)) throw journalError("transition", "Quarantine item transition does not match its available predecessor");
}

function expectedOperationPhase(action: QuarantineOperationRecordV1["action"], phase: QuarantineMoveOperationPhase | QuarantinePurgeOperationPhase): string | undefined {
  switch (action) {
    case "quarantine":
    case "restore":
      switch (phase) {
        case "prepared": return "renamed";
        case "renamed": return "committed";
        case "committed": return undefined;
        default: throw journalError("transition", `Invalid move operation phase: ${phase}`);
      }
    case "purge":
      switch (phase) {
        case "prepared": return "tombstoned";
        case "tombstoned": return "removed";
        case "removed": return "committed";
        case "committed": return undefined;
        default: throw journalError("transition", `Invalid purge operation phase: ${phase}`);
      }
    default: throw journalError("transition", `Invalid operation action: ${action}`);
  }
}

function operationTransitionAllowed(current: JournaledRecord<QuarantineOperationRecordV1> | undefined, item: JournaledRecord<QuarantineItemRecordV1> | undefined, next: QuarantineOperationRecordV1): void {
  if (!current) {
    if (next.phase !== "prepared" || next.predecessorDigest !== undefined) throw journalError("transition", "An operation can only start at prepared");
    if (next.action === "quarantine" && item !== undefined) throw journalError("transition", "Quarantine operation requires an absent item");
    if (next.action !== "quarantine" && item?.record.state !== "available") throw journalError("transition", "Restore and purge require an available item");
    return;
  }
  if (current.record.action !== next.action || current.record.operationId !== next.operationId || current.record.predecessorDigest === next.predecessorDigest || !sameIdentity(current.record, next)) throw journalError("transition", "Operation identity does not match its predecessor");
  if (current.record.action === "restore") {
    if (next.action !== "restore" || current.record.targetWorktreePath !== next.targetWorktreePath) throw journalError("identity", "Restore target changed during operation");
  }
  if (current.record.action === "purge") {
    if (next.action !== "purge" || current.record.tombstonePath !== next.tombstonePath) throw journalError("identity", "Purge tombstone changed during operation");
  }
  if (current.record.predecessorDigest !== undefined && current.record.phase === "committed") throw journalError("transition", "Committed operation is terminal");
  if (next.predecessorDigest !== current.digest || next.phase !== expectedOperationPhase(current.record.action, current.record.phase)) throw journalError("transition", "Operation phase is not the immediate successor");
}

async function writeRecordLocked<T extends QuarantineItemRecordV1 | QuarantineOperationRecordV1>(input: QuarantineJournalWriteInput<T>): Promise<JournaledRecord<T>> {
  const target = recordPath(input.paths, input.record);
  await prepareMetadata(input.paths, target);
  const content = recordContent(input.record);
  const relativePath = path.relative(input.paths.dir, target).split(path.sep).join("/");
  const journaled = { record: input.record, digest: digest(content), relativePath } satisfies JournaledRecord<T>;
  try {
    await writeDurableCreate(target, input.paths.lockTmpDir, content);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    await assertMetadataPath(input.paths, target);
    if (await fs.readFile(target, "utf8") !== content) throw journalError("collision", `Refusing to overwrite quarantine journal record: ${relativePath}`);
  }
  await input.hooks?.afterRecordDurable?.(journaled);
  return journaled;
}

async function assertNoConflictingRecord(paths: GuardianPaths, record: QuarantineItemRecordV1 | QuarantineOperationRecordV1): Promise<void> {
  const target = recordPath(paths, record);
  await assertMetadataPath(paths, target);
  try {
    if (await fs.readFile(target, "utf8") !== recordContent(record)) throw journalError("collision", `Refusing to overwrite quarantine journal record: ${path.relative(paths.dir, target)}`);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
}

export async function readQuarantineItem(input: { readonly paths: GuardianPaths; readonly quarantineId: string }): Promise<JournaledRecord<QuarantineItemRecordV1> | undefined> {
  const records = await readDirectory(input.paths, "items", input.quarantineId);
  return terminalRecord(records.filter((record): record is JournaledRecord<QuarantineItemRecordV1> => record.record.kind === "quarantine-item"), `item ${input.quarantineId}`);
}

export async function readQuarantineOperation(input: { readonly paths: GuardianPaths; readonly operationId: string }): Promise<JournaledRecord<QuarantineOperationRecordV1> | undefined> {
  const records = await readDirectory(input.paths, "operations", input.operationId);
  return terminalRecord(records.filter((record): record is JournaledRecord<QuarantineOperationRecordV1> => record.record.kind === "quarantine-operation"), `operation ${input.operationId}`);
}

export async function writeQuarantineItemTransitionLocked(input: QuarantineJournalWriteInput<QuarantineItemRecordV1>): Promise<JournaledRecord<QuarantineItemRecordV1>> {
  await assertNoConflictingRecord(input.paths, input.record);
  const current = await readQuarantineItem({ paths: input.paths, quarantineId: input.record.quarantineId });
  if (current?.digest === digest(recordContent(input.record))) return writeRecordLocked(input);
  itemTransitionAllowed(current, input.record);
  return writeRecordLocked(input);
}

function itemRecord(transition: QuarantineItemTransition): QuarantineItemRecordV1 {
  const record = parseQuarantineJournalRecord({ version: 1, kind: "quarantine-item", ...transition });
  if (record.kind !== "quarantine-item") throw journalError("invalid", "Expected a quarantine item transition");
  return record;
}

function operationRecord(transition: QuarantineOperationTransition): QuarantineOperationRecordV1 {
  const record = parseQuarantineJournalRecord({ version: 1, kind: "quarantine-operation", ...transition });
  if (record.kind !== "quarantine-operation") throw journalError("invalid", "Expected a quarantine operation transition");
  return record;
}

export async function writeQuarantineItemTransition(input: QuarantineJournalWriteInput<QuarantineItemTransition>): Promise<JournaledRecord<QuarantineItemRecordV1>> {
  const record = itemRecord(input.record);
  return withStateTransaction(input.paths, () => writeQuarantineItemTransitionLocked({ ...input, record }));
}

export async function writeQuarantineOperationTransitionLocked(input: QuarantineJournalWriteInput<QuarantineOperationRecordV1>): Promise<JournaledRecord<QuarantineOperationRecordV1>> {
  await assertNoConflictingRecord(input.paths, input.record);
  const [operation, item] = await Promise.all([readQuarantineOperation({ paths: input.paths, operationId: input.record.operationId }), readQuarantineItem({ paths: input.paths, quarantineId: input.record.quarantineId })]);
  if (operation?.digest === digest(recordContent(input.record))) return writeRecordLocked(input);
  operationTransitionAllowed(operation, item, input.record);
  return writeRecordLocked(input);
}

export async function writeQuarantineOperationTransition(input: QuarantineJournalWriteInput<QuarantineOperationTransition>): Promise<JournaledRecord<QuarantineOperationRecordV1>> {
  const record = operationRecord(input.record);
  return withStateTransaction(input.paths, () => writeQuarantineOperationTransitionLocked({ ...input, record }));
}

// No identity index is needed: the hashed directory name is opaque, but every record already
// carries its own operationId, so each bucket's terminal record can be found and verified with
// the same readDirectory/terminalRecord path used by readQuarantineOperation.
export async function listIncompleteQuarantineOperations(input: { readonly paths: GuardianPaths }): Promise<readonly JournaledRecord<QuarantineOperationRecordV1>[]> {
  const root = path.join(input.paths.journalDir, "operations");
  await assertMetadataPath(input.paths, root);
  let directories: readonly import("node:fs").Dirent[];
  try {
    directories = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const incomplete: JournaledRecord<QuarantineOperationRecordV1>[] = [];
  for (const directoryEntry of [...directories].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!directoryEntry.isDirectory() || !/^[0-9a-f]{64}$/.test(directoryEntry.name)) throw journalError("invalid", `Malformed quarantine operation directory: ${path.join(root, directoryEntry.name)}`);
    const directory = path.join(root, directoryEntry.name);
    await assertMetadataPath(input.paths, directory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const records: JournaledRecord<QuarantineItemRecordV1 | QuarantineOperationRecordV1>[] = [];
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile()) throw journalError("invalid", `Quarantine journal contains a non-file record: ${path.join(directory, entry.name)}`);
      const target = path.join(directory, entry.name);
      await assertMetadataPath(input.paths, target);
      const relativePath = path.relative(input.paths.dir, target).split(path.sep).join("/");
      const journaled = asJournaledRecord(await fs.readFile(target, "utf8"), relativePath);
      if (journaled.record.kind !== "quarantine-operation" || digest(journaled.record.operationId) !== directoryEntry.name || recordDirectory(input.paths, journaled.record) !== directory || recordFileName(journaled.record) !== entry.name) {
        throw journalError("identity", `Quarantine operation record path identity mismatch: ${relativePath}`);
      }
      records.push(journaled);
    }
    const operationRecords = records.filter((record): record is JournaledRecord<QuarantineOperationRecordV1> => record.record.kind === "quarantine-operation");
    const terminal = terminalRecord(operationRecords, `operation directory ${directoryEntry.name}`);
    if (terminal && terminal.record.phase !== "committed") incomplete.push(terminal);
  }
  return incomplete.sort((left, right) => left.record.operationId.localeCompare(right.record.operationId));
}
