import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isEnoent, isSameOrInside } from "./filesystem-boundaries.ts";
import { parseQuarantineJournalRecord } from "./quarantine-types.ts";
import type { QuarantineItemRecordV1, QuarantineOperationRecordV1 } from "./quarantine-types.ts";
import type { GuardianPaths } from "./types.ts";

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

export function digest(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function journalError(kind: QuarantineJournalErrorKind, message: string): QuarantineJournalError {
  return new QuarantineJournalError(kind, message);
}

export function recordContent(record: QuarantineItemRecordV1 | QuarantineOperationRecordV1): string {
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

export function recordPath(paths: GuardianPaths, record: QuarantineItemRecordV1 | QuarantineOperationRecordV1): string {
  return path.join(recordDirectory(paths, record), recordFileName(record));
}

export async function assertMetadataPath(paths: GuardianPaths, target: string): Promise<void> {
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

function asJournaledRecord(content: string, relativePath: string): JournaledRecord<QuarantineItemRecordV1 | QuarantineOperationRecordV1> {
  const actualDigest = digest(content);
  try {
    return { record: parseQuarantineJournalRecord(JSON.parse(content)), digest: actualDigest, relativePath };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
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

export async function readQuarantineItem(input: { readonly paths: GuardianPaths; readonly quarantineId: string }): Promise<JournaledRecord<QuarantineItemRecordV1> | undefined> {
  const records = await readDirectory(input.paths, "items", input.quarantineId);
  return terminalRecord(records.filter((record): record is JournaledRecord<QuarantineItemRecordV1> => record.record.kind === "quarantine-item"), `item ${input.quarantineId}`);
}

export async function readQuarantineOperation(input: { readonly paths: GuardianPaths; readonly operationId: string }): Promise<JournaledRecord<QuarantineOperationRecordV1> | undefined> {
  const records = await readDirectory(input.paths, "operations", input.operationId);
  return terminalRecord(records.filter((record): record is JournaledRecord<QuarantineOperationRecordV1> => record.record.kind === "quarantine-operation"), `operation ${input.operationId}`);
}

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
    const records: JournaledRecord<QuarantineOperationRecordV1>[] = [];
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile()) throw journalError("invalid", `Quarantine journal contains a non-file record: ${path.join(directory, entry.name)}`);
      const target = path.join(directory, entry.name);
      await assertMetadataPath(input.paths, target);
      const relativePath = path.relative(input.paths.dir, target).split(path.sep).join("/");
      const journaled = asJournaledRecord(await fs.readFile(target, "utf8"), relativePath);
      if (journaled.record.kind !== "quarantine-operation" || digest(journaled.record.operationId) !== directoryEntry.name || recordDirectory(input.paths, journaled.record) !== directory || recordFileName(journaled.record) !== entry.name) {
        throw journalError("identity", `Quarantine operation record path identity mismatch: ${relativePath}`);
      }
      records.push({ ...journaled, record: journaled.record });
    }
    const terminal = terminalRecord(records, `operation directory ${directoryEntry.name}`);
    if (terminal && terminal.record.phase !== "committed") incomplete.push(terminal);
  }
  return incomplete.sort((left, right) => left.record.operationId.localeCompare(right.record.operationId));
}

export async function listQuarantineItems(input: { readonly paths: GuardianPaths }): Promise<readonly JournaledRecord<QuarantineItemRecordV1>[]> {
  const root = path.join(input.paths.journalDir, "items");
  await assertMetadataPath(input.paths, root);
  let directories: readonly import("node:fs").Dirent[];
  try {
    directories = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const items: JournaledRecord<QuarantineItemRecordV1>[] = [];
  for (const directoryEntry of [...directories].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!directoryEntry.isDirectory() || !/^[0-9a-f]{64}$/.test(directoryEntry.name)) throw journalError("invalid", `Malformed quarantine item directory: ${path.join(root, directoryEntry.name)}`);
    const directory = path.join(root, directoryEntry.name);
    await assertMetadataPath(input.paths, directory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const records: JournaledRecord<QuarantineItemRecordV1>[] = [];
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile()) throw journalError("invalid", `Quarantine journal contains a non-file record: ${path.join(directory, entry.name)}`);
      const target = path.join(directory, entry.name);
      await assertMetadataPath(input.paths, target);
      const relativePath = path.relative(input.paths.dir, target).split(path.sep).join("/");
      const journaled = asJournaledRecord(await fs.readFile(target, "utf8"), relativePath);
      if (journaled.record.kind !== "quarantine-item" || digest(journaled.record.quarantineId) !== directoryEntry.name || recordDirectory(input.paths, journaled.record) !== directory || recordFileName(journaled.record) !== entry.name) {
        throw journalError("identity", `Quarantine item record path identity mismatch: ${relativePath}`);
      }
      records.push({ ...journaled, record: journaled.record });
    }
    const terminal = terminalRecord(records, `item directory ${directoryEntry.name}`);
    if (terminal) items.push(terminal);
  }
  return items.sort((left, right) => left.record.quarantineId.localeCompare(right.record.quarantineId));
}
