import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { collectIgnoredFileFingerprint } from "./deletion-fingerprint.ts";
import { isEnoent, isSameOrInside } from "./filesystem-boundaries.ts";
import { getCommonGitDir, getHeadCommit, runGitNullSeparated } from "./git.ts";
import { getGuardianPaths } from "./guardian-paths.ts";
import { parseProvenanceRecord } from "./quarantine-types.ts";
import { ensureDurableDirectory, writeDurableCreate } from "./state-durable-file.ts";
import type { DeletionFingerprintEntry } from "./deletion-fingerprint.ts";
import type { ExternalRecordReference, GuardianPaths, ProvenanceInventoryEntry, ProvenanceRecordV1 } from "./types.ts";
import { errorCode } from "./types.ts";

export type ProvenanceErrorKind = "collision" | "digest" | "identity" | "invalid" | "symlink";

export class ProvenanceError extends Error {
  override readonly name = "ProvenanceError";
  readonly kind: ProvenanceErrorKind;
  constructor(kind: ProvenanceErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

type ProvenanceIdentityInput = {
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly sessionId: string;
  readonly lineageId: string;
};

export type CaptureProvenanceManifestInput = ProvenanceIdentityInput & {
  readonly enabled: boolean;
  readonly createdAt?: string;
};

export type ReadProvenanceManifestInput = ProvenanceIdentityInput & {
  readonly reference: ExternalRecordReference;
};

type CanonicalIdentity = {
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly commonGitDir: string;
  readonly deviceId: number;
};

function digest(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function provenanceError(kind: ProvenanceErrorKind, message: string): ProvenanceError {
  return new ProvenanceError(kind, message);
}

function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes("\0") || path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return normalized !== "." && normalized !== ".." && !normalized.startsWith(`..${path.sep}`);
}

function manifestFileName(sessionId: string): string {
  return `${digest(sessionId)}.json`;
}

export function provenanceManifestRelativePath(sessionId: string): string {
  return path.posix.join("provenance", manifestFileName(sessionId));
}

async function canonicalIdentity(input: ProvenanceIdentityInput): Promise<CanonicalIdentity> {
  const repoRoot = await fs.realpath(input.repoRoot);
  const worktreePath = await fs.realpath(input.worktreePath);
  const [repoCommonGitDir, worktreeCommonGitDir] = await Promise.all([getCommonGitDir(repoRoot), getCommonGitDir(worktreePath)]);
  const [commonGitDir, worktreeGitDir] = await Promise.all([fs.realpath(repoCommonGitDir), fs.realpath(worktreeCommonGitDir)]);
  if (commonGitDir !== worktreeGitDir) throw provenanceError("identity", "Provenance worktree belongs to a different common Git directory");
  return { repoRoot, worktreePath, commonGitDir, deviceId: (await fs.stat(commonGitDir)).dev };
}

async function assertMetadataPath(paths: GuardianPaths, target: string): Promise<void> {
  if (!isSameOrInside(target, paths.gitDir)) throw provenanceError("invalid", `Provenance metadata escapes common Git directory: ${target}`);
  const relative = path.relative(paths.gitDir, target);
  const parts = relative ? relative.split(path.sep) : [];
  let current = paths.gitDir;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw provenanceError("symlink", `Refusing provenance metadata symlink: ${current}`);
      const real = await fs.realpath(current);
      if (!isSameOrInside(real, paths.gitDir)) throw provenanceError("symlink", `Provenance metadata ancestor escapes common Git directory: ${current}`);
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
  }
}

async function prepareMetadata(paths: GuardianPaths, target: string): Promise<void> {
  await assertMetadataPath(paths, target);
  await ensureDurableDirectory(paths.dir);
  await ensureDurableDirectory(paths.provenanceDir);
  await ensureDurableDirectory(paths.lockTmpDir);
  await assertMetadataPath(paths, target);
  await assertMetadataPath(paths, paths.lockTmpDir);
}

function inventoryEntry(entry: DeletionFingerprintEntry): ProvenanceInventoryEntry {
  const relativePath = entry["path"];
  const kind = entry["kind"];
  if (typeof relativePath !== "string" || !isSafeRelativePath(relativePath)) throw provenanceError("invalid", "Provenance inventory contains an unsafe relative path");
  if (kind !== "file" && kind !== "directory" && kind !== "symlink") throw provenanceError("invalid", `Provenance inventory contains unsupported kind: ${String(kind)}`);
  return { relativePath, kind, fingerprint: digest(JSON.stringify(entry)) };
}

async function collectInventory(worktreePath: string): Promise<readonly ProvenanceInventoryEntry[]> {
  const [untracked, ignored] = await Promise.all([
    runGitNullSeparated(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]),
    runGitNullSeparated(worktreePath, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]),
  ]);
  const candidates = new Set<string>();
  for (const candidate of [...untracked, ...ignored]) {
    let current = path.normalize(candidate);
    candidates.add(current);
    while (path.dirname(current) !== ".") {
      current = path.dirname(current);
      candidates.add(current);
    }
  }
  const orderedCandidates = [...candidates].sort(compareText);
  for (const candidate of orderedCandidates) {
    if (!isSafeRelativePath(candidate) || !isSameOrInside(path.resolve(worktreePath, candidate), worktreePath)) {
      throw provenanceError("invalid", `Provenance inventory candidate escapes worktree: ${candidate}`);
    }
  }
  const fingerprints = await collectIgnoredFileFingerprint(worktreePath, orderedCandidates);
  const uniqueFingerprints = new Map<string, DeletionFingerprintEntry>();
  for (const fingerprint of fingerprints) uniqueFingerprints.set(JSON.stringify(fingerprint), fingerprint);
  const inventory = [...uniqueFingerprints.values()].map(inventoryEntry).sort((left, right) => {
    const pathOrder = compareText(left.relativePath, right.relativePath);
    return pathOrder === 0 ? compareText(left.kind, right.kind) : pathOrder;
  });
  for (let index = 1; index < inventory.length; index += 1) {
    const previous = inventory[index - 1];
    const current = inventory[index];
    if (previous && current && previous.relativePath === current.relativePath && previous.kind === current.kind) {
      throw provenanceError("invalid", `Provenance inventory contains duplicate entry: ${current.relativePath}`);
    }
  }
  return inventory;
}

function validateInventory(inventory: readonly ProvenanceInventoryEntry[]): void {
  for (let index = 0; index < inventory.length; index += 1) {
    const entry = inventory[index];
    if (!entry || !isSafeRelativePath(entry.relativePath) || !/^[0-9a-f]{64}$/.test(entry.fingerprint)) {
      throw provenanceError("invalid", "Provenance record contains malformed inventory");
    }
    const previous = inventory[index - 1];
    if (previous && (compareText(previous.relativePath, entry.relativePath) > 0 || (previous.relativePath === entry.relativePath && compareText(previous.kind, entry.kind) >= 0))) {
      throw provenanceError("invalid", "Provenance record inventory is not deterministically ordered");
    }
  }
}

function verifyIdentity(record: ProvenanceRecordV1, identity: CanonicalIdentity, input: ProvenanceIdentityInput): void {
  if (record.repoRoot !== identity.repoRoot || record.worktreePath !== identity.worktreePath || record.commonGitDir !== identity.commonGitDir || record.deviceId !== identity.deviceId || record.sessionId !== input.sessionId || record.lineageId !== input.lineageId) {
    throw provenanceError("identity", "Provenance record identity does not match the current session binding");
  }
}

function manifestPath(paths: GuardianPaths, reference: ExternalRecordReference): string {
  if (!isSafeRelativePath(reference.relativePath)) throw provenanceError("invalid", "Provenance reference path is invalid");
  const target = path.resolve(paths.dir, reference.relativePath);
  if (!isSameOrInside(target, paths.provenanceDir)) throw provenanceError("invalid", "Provenance reference escapes provenance directory");
  return target;
}

export async function captureProvenanceManifest(input: CaptureProvenanceManifestInput): Promise<ExternalRecordReference | undefined> {
  if (!input.enabled) return undefined;
  const identity = await canonicalIdentity(input);
  const paths = await getGuardianPaths(identity.repoRoot);
  const relativePath = provenanceManifestRelativePath(input.sessionId);
  const target = manifestPath(paths, { relativePath, digest: "" });
  const record = parseProvenanceRecord({
    version: 1,
    kind: "provenance",
    sessionId: input.sessionId,
    lineageId: input.lineageId,
    repoRoot: identity.repoRoot,
    worktreePath: identity.worktreePath,
    commonGitDir: identity.commonGitDir,
    deviceId: identity.deviceId,
    headCommit: await getHeadCommit(identity.worktreePath),
    createdAt: input.createdAt ?? new Date().toISOString(),
    inventory: await collectInventory(identity.worktreePath),
  });
  const content = `${JSON.stringify(record)}\n`;
  const reference = { relativePath, digest: digest(content) };
  await prepareMetadata(paths, target);
  try {
    await writeDurableCreate(target, paths.lockTmpDir, content);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    await assertMetadataPath(paths, target);
    const existing = await fs.readFile(target, "utf8");
    if (digest(existing) === reference.digest) return reference;
    throw provenanceError("collision", `Refusing to overwrite provenance manifest: ${target}`);
  }
  return reference;
}

export async function readProvenanceManifest(input: ReadProvenanceManifestInput): Promise<ProvenanceRecordV1> {
  const identity = await canonicalIdentity(input);
  const paths = await getGuardianPaths(identity.repoRoot);
  const target = manifestPath(paths, input.reference);
  await assertMetadataPath(paths, target);
  const content = await fs.readFile(target, "utf8");
  if (digest(content) !== input.reference.digest) throw provenanceError("digest", "Provenance manifest digest does not match its state reference");
  let record: ProvenanceRecordV1;
  try {
    record = parseProvenanceRecord(JSON.parse(content));
  } catch (error) {
    throw provenanceError("invalid", "Provenance manifest is malformed or has an unsupported version");
  }
  validateInventory(record.inventory);
  verifyIdentity(record, identity, input);
  return record;
}
