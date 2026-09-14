import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ArchivedPathProofError, archivedFileSHA256, fingerprintArchivedPath, verifyArchivedPathsFromPrivateCopy } from "./archived-paths.ts";
import type { ArchivedPathFingerprint, ArchivedPathProof } from "./archived-paths.ts";
import { assertNoSymlinkAncestors, lstatOrMissing } from "./filesystem-boundaries.ts";
import { ensureDurableDirectory, syncDirectory } from "./state-durable-file.ts";

type PrepareArchivedPathRemovalInput = {
  readonly worktreePath: string;
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly paths: readonly string[];
  readonly expectedEntries: readonly ArchivedPathFingerprint[];
};

export type ArchivedPathRemoval = {
  readonly operationRoot: string;
  readonly movedRoot: string;
  readonly privateArchivePath: string;
  readonly proof: ArchivedPathProof;
  readonly worktreePath: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameIdentity(left: Awaited<ReturnType<typeof fs.lstat>>, right: Awaited<ReturnType<typeof fs.lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

async function copyOpenFile(source: fs.FileHandle, destination: fs.FileHandle): Promise<void> {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (;;) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) return;
    let written = 0;
    while (written < bytesRead) {
      const result = await destination.write(buffer, written, bytesRead - written, null);
      written += result.bytesWritten;
    }
  }
}

async function copyArchiveToOperation(input: PrepareArchivedPathRemovalInput, operationRoot: string): Promise<string> {
  const requestedStat = await fs.lstat(input.archivePath);
  if (!requestedStat.isFile() || requestedStat.isSymbolicLink()) throw new ArchivedPathProofError("archivePath must resolve directly to a regular file");
  const archivePath = await fs.realpath(input.archivePath);
  const source = await fs.open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const privateArchivePath = path.join(operationRoot, "verified-archive.tar.gz");
  try {
    const openedStat = await source.stat();
    if (!openedStat.isFile() || !sameIdentity(requestedStat, openedStat)) throw new ArchivedPathProofError("archive identity changed before private copy");
    const destination = await fs.open(privateArchivePath, "wx", 0o400);
    try {
      await copyOpenFile(source, destination);
      await destination.sync();
    } finally {
      await destination.close();
    }
    const [finalOpenedStat, finalPathStat] = await Promise.all([source.stat(), fs.lstat(archivePath)]);
    if (!sameIdentity(openedStat, finalOpenedStat) || !sameIdentity(finalOpenedStat, finalPathStat)) {
      throw new ArchivedPathProofError("archive identity changed during private copy");
    }
  } finally {
    await source.close();
  }
  if (await archivedFileSHA256(privateArchivePath) !== input.archiveSha256) {
    throw new ArchivedPathProofError("archive SHA-256 does not match archiveSha256");
  }
  await syncDirectory(operationRoot);
  return privateArchivePath;
}

async function moveArchivedEntry(sourceRoot: string, destinationRoot: string, entry: ArchivedPathFingerprint): Promise<void> {
  const source = path.join(sourceRoot, entry.path);
  const destination = path.join(destinationRoot, entry.path);
  const destinationParent = path.dirname(destination);
  await ensureDurableDirectory(destinationParent);
  await assertNoSymlinkAncestors(path.dirname(source), "archive-backed removal source");
  await assertNoSymlinkAncestors(destinationParent, "archive-backed removal destination");
  const [sourceStat, destinationStat] = await Promise.all([fs.lstat(source), lstatOrMissing(destination)]);
  if (destinationStat) throw new ArchivedPathProofError(`archive-backed removal destination already exists: ${entry.path}`);
  if (sourceStat.dev !== (await fs.stat(destinationParent)).dev) throw new ArchivedPathProofError(`EXDEV risk for archive-backed path: ${entry.path}`);
  if (JSON.stringify(await fingerprintArchivedPath(sourceRoot, entry.path)) !== JSON.stringify(entry)) {
    throw new ArchivedPathProofError(`archive-backed path changed before quarantine: ${entry.path}`);
  }
  await assertNoSymlinkAncestors(path.dirname(source), "archive-backed removal source");
  await assertNoSymlinkAncestors(destinationParent, "archive-backed removal destination");
  if (await lstatOrMissing(destination)) throw new ArchivedPathProofError(`archive-backed removal destination appeared: ${entry.path}`);
  await fs.rename(source, destination);
  const [postSource, postDestination] = await Promise.all([lstatOrMissing(source), lstatOrMissing(destination)]);
  if (postSource || !postDestination) throw new ArchivedPathProofError(`archive-backed quarantine postcondition is ambiguous: ${entry.path}`);
  if (JSON.stringify(await fingerprintArchivedPath(destinationRoot, entry.path)) !== JSON.stringify(entry)) {
    throw new ArchivedPathProofError(`archive-backed quarantine fingerprint changed: ${entry.path}`);
  }
  await syncDirectory(path.dirname(source));
  if (path.dirname(source) !== destinationParent) await syncDirectory(destinationParent);
}

async function restoreMovedEntries(removal: ArchivedPathRemoval): Promise<void> {
  for (const entry of [...removal.proof.entries].reverse()) {
    if (await lstatOrMissing(path.join(removal.movedRoot, entry.path))) {
      await moveArchivedEntry(removal.movedRoot, removal.worktreePath, entry);
    }
  }
}

async function removeOperationRoot(removal: ArchivedPathRemoval): Promise<void> {
  await assertNoSymlinkAncestors(removal.operationRoot, "archive-backed operation root");
  await fs.rm(removal.operationRoot, { recursive: true, force: false });
  await syncDirectory(path.dirname(removal.operationRoot));
}

async function assertExternalArchiveStillMatches(removal: ArchivedPathRemoval): Promise<void> {
  const stat = await fs.lstat(removal.proof.archivePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ArchivedPathProofError(`external archive changed; private recovery retained at ${removal.privateArchivePath}`);
  if (await archivedFileSHA256(removal.proof.archivePath) !== removal.proof.archiveSha256) {
    throw new ArchivedPathProofError(`external archive changed; private recovery retained at ${removal.privateArchivePath}`);
  }
}

export async function prepareArchivedPathRemoval(input: PrepareArchivedPathRemovalInput): Promise<ArchivedPathRemoval> {
  const worktreePath = await fs.realpath(input.worktreePath);
  const operationRoot = await fs.mkdtemp(path.join(path.dirname(worktreePath), ".guardian-archive-quarantine-"));
  await fs.chmod(operationRoot, 0o700);
  const movedRoot = path.join(operationRoot, "moved");
  let removal: ArchivedPathRemoval | null = null;
  try {
    const privateArchivePath = await copyArchiveToOperation(input, operationRoot);
    const proof = await verifyArchivedPathsFromPrivateCopy({ ...input, worktreePath }, privateArchivePath);
    if (JSON.stringify(proof.entries) !== JSON.stringify(input.expectedEntries)) {
      throw new ArchivedPathProofError("archive-backed path proof changed at deletion boundary");
    }
    removal = { operationRoot, movedRoot, privateArchivePath, proof, worktreePath };
    for (const entry of proof.entries) await moveArchivedEntry(worktreePath, movedRoot, entry);
    return removal;
  } catch (error) {
    if (removal) {
      try {
        await restoreMovedEntries(removal);
      } catch (rollbackError) {
        throw new ArchivedPathProofError(`${errorMessage(error)}; rollback blocked: ${errorMessage(rollbackError)}; recovery retained at ${operationRoot}`);
      }
    }
    await fs.rm(operationRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function finalizeArchivedPathRemoval(removal: ArchivedPathRemoval): Promise<void> {
  await assertExternalArchiveStillMatches(removal);
  await removeOperationRoot(removal);
}

export async function rollbackArchivedPathRemoval(removal: ArchivedPathRemoval): Promise<void> {
  await restoreMovedEntries(removal);
  await removeOperationRoot(removal);
}
