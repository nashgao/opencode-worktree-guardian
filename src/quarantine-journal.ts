import fs from "node:fs/promises";
import path from "node:path";
import { isEnoent } from "./filesystem-boundaries.ts";
import { assertMetadataPath, digest, journalError, readQuarantineItem, readQuarantineOperation, recordContent, recordPath } from "./quarantine-journal-records.ts";
import type { JournaledRecord } from "./quarantine-journal-records.ts";
import { parseQuarantineJournalRecord } from "./quarantine-types.ts";
import { withStateTransaction } from "./state.ts";
import { ensureDurableDirectory, writeDurableCreate } from "./state-durable-file.ts";
import type { GuardianPaths } from "./types.ts";
import type { QuarantineItemRecordV1, QuarantineMoveOperationPhase, QuarantineOperationRecordV1, QuarantinePurgeOperationPhase } from "./quarantine-types.ts";
import { errorCode } from "./types.ts";

export { reconcileQuarantineOperation } from "./quarantine-journal-reconcile.ts";
export type { QuarantineEvidence, QuarantineReconciliation } from "./quarantine-journal-reconcile.ts";
export { listIncompleteQuarantineOperations, listQuarantineItems, QuarantineJournalError, readQuarantineItem, readQuarantineOperation } from "./quarantine-journal-records.ts";
export type { JournaledRecord, QuarantineJournalErrorKind } from "./quarantine-journal-records.ts";
export type QuarantineJournalHooks = { readonly afterRecordDurable?: (record: JournaledRecord<QuarantineItemRecordV1 | QuarantineOperationRecordV1>) => Promise<void> };
export type QuarantineJournalWriteInput<T> = { readonly paths: GuardianPaths; readonly record: T; readonly hooks?: QuarantineJournalHooks };
export type QuarantineItemTransition = Omit<QuarantineItemRecordV1, "version" | "kind">;
export type QuarantineOperationTransition = Omit<QuarantineOperationRecordV1, "version" | "kind">;

async function prepareMetadata(paths: GuardianPaths, target: string): Promise<void> {
  await assertMetadataPath(paths, target);
  await ensureDurableDirectory(paths.dir);
  await ensureDurableDirectory(paths.journalDir);
  await ensureDurableDirectory(paths.lockTmpDir);
  await ensureDurableDirectory(path.dirname(target));
  await assertMetadataPath(paths, target);
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
