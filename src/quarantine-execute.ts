import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { collectQuarantineEvidence, nextOperationTransition, normalizeQuarantineFingerprint, quarantineOperationPaths } from "./quarantine-evidence.ts";
import { removeEmptyAncestorDirectories } from "./empty-directory-cleanup.ts";
import { readQuarantineItem, writeQuarantineItemTransition, writeQuarantineOperationTransition, writeQuarantineOperationTransitionLocked } from "./quarantine-journal.ts";
import { moveQuarantinePathCooperatively } from "./quarantine-move.ts";
import { buildQuarantinePathPreflight } from "./quarantine-path-preflight.ts";
import { readState, withStateTransaction } from "./state.ts";
import type { GuardianConfig, GuardianPaths, GuardianSession } from "./types.ts";

export type ExecuteQuarantineInput = {
  readonly paths: GuardianPaths;
  readonly repoRoot: string;
  readonly config: GuardianConfig;
  readonly session: GuardianSession;
  readonly relativePath: string;
  readonly manifestDigest: string;
  readonly doneIntentDigest: string;
};

export type ExecuteQuarantineResult = { readonly quarantineId: string; readonly operationId: string; readonly artifactPath: string };

// Full prepared -> [move] -> renamed -> [item available + operation committed] sequence for one
// candidate. The provenance/state-revision recheck immediately before the "prepared" write closes
// the gap between when this path was classified and when it is actually moved (two-pass proof);
// everything before that point is read-only planning, everything from "prepared" onward is
// durably journaled so a crash at any point is exactly what resumeIncompleteQuarantineOperations
// is built to reconcile.
export async function executeQuarantine(input: ExecuteQuarantineInput): Promise<ExecuteQuarantineResult> {
  const { paths, repoRoot, config, session, relativePath } = input;
  const sessionId = session.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("quarantine execution requires a session id");
  const lineageId = session.lineage_id;
  if (typeof lineageId !== "string" || lineageId.length === 0) throw new Error("quarantine execution requires a captured session lineage id");
  const worktreePath = session.worktree_path;
  if (typeof worktreePath !== "string" || worktreePath.length === 0) throw new Error("quarantine execution requires a session worktree");

  const quarantineId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const locations = quarantineOperationPaths(paths, { action: "quarantine", quarantineId, operationId, originalWorktreePath: worktreePath, originalRelativePath: relativePath });
  const artifactRelativePath = path.relative(paths.quarantineDir, locations.artifact);

  const preflight = await buildQuarantinePathPreflight({ action: "quarantine", artifactRelativePath, config, metadataRoot: paths.quarantineDir, repoRoot, session, sourcePath: locations.source });
  if (!preflight.ok) throw new Error(`quarantine preflight blocked: ${preflight.blockers.map((blocker) => blocker.reason).join("; ")}`);
  if (preflight.facts.source.relativePath !== relativePath) throw new Error("quarantine preflight resolved an unexpected relative path");
  const fingerprint = normalizeQuarantineFingerprint(preflight.facts.source.fingerprint);
  const fingerprintDigest = crypto.createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
  const deviceId = preflight.facts.source.deviceId;
  if (deviceId === null || deviceId !== preflight.facts.destination.deviceId) throw new Error("quarantine device identity is unavailable or crosses devices");

  const prepared = await withStateTransaction(paths, async () => {
    const state = await readState(paths, { repoRoot, config });
    const live = state.sessions[sessionId];
    if (!live || live.lineage_id !== lineageId || live.provenance?.manifest?.digest !== input.manifestDigest) throw new Error("session provenance drifted before quarantine could be prepared");
    if (typeof state.state_version !== "number" || typeof live.state_version !== "number") throw new Error("guardian state revision is unavailable");
    return writeQuarantineOperationTransitionLocked({
      paths,
      record: {
        version: 1, kind: "quarantine-operation",
        quarantineId, operationId, action: "quarantine", phase: "prepared",
        sessionId, lineageId, originalRelativePath: relativePath, originalWorktreePath: worktreePath,
        artifactPath: locations.artifact, fingerprint, fingerprintDigest,
        manifestDigest: input.manifestDigest, doneIntentDigest: input.doneIntentDigest,
        guardianStateRevision: state.state_version, sessionRevision: live.state_version,
        deviceId, nonce, createdAt: new Date().toISOString(),
      },
    });
  });

  await moveQuarantinePathCooperatively({ sourcePath: locations.source, destinationPath: locations.artifact, sourceRoot: locations.sourceRoot, destinationRoot: locations.artifactRoot, expectedFingerprint: fingerprint });

  const renamed = await writeQuarantineOperationTransition({ paths, record: nextOperationTransition(prepared, "renamed") });

  await writeQuarantineItemTransition({
    paths,
    record: {
      quarantineId, sessionId, lineageId, originalRelativePath: relativePath, originalWorktreePath: worktreePath,
      artifactPath: locations.artifact, fingerprint, fingerprintDigest,
      manifestDigest: input.manifestDigest, doneIntentDigest: input.doneIntentDigest,
      guardianStateRevision: prepared.record.guardianStateRevision, sessionRevision: prepared.record.sessionRevision,
      deviceId, nonce, createdAt: prepared.record.createdAt,
      state: "available",
    },
  });

  await writeQuarantineOperationTransition({ paths, record: nextOperationTransition(renamed, "committed") });
  await removeEmptyAncestorDirectories({ root: worktreePath, removedPath: locations.source });

  return { quarantineId, operationId, artifactPath: locations.artifact };
}

export type ExecuteRestoreInput = {
  readonly paths: GuardianPaths;
  readonly repoRoot: string;
  readonly config: GuardianConfig;
  readonly session: GuardianSession;
  readonly quarantineId: string;
  readonly targetWorktreePath: string;
};

export type ExecuteRestoreResult = { readonly operationId: string; readonly restoredPath: string };

// The item's already-recorded identity fields (artifactPath, fingerprint, deviceId, nonce,
// createdAt, and the rest of the shared "common" journal shape) travel onto the operation record
// UNCHANGED, and back onto the item's terminal transition unchanged again: quarantine-journal.ts's
// itemTransitionAllowed requires exact identity between an "available" item and its terminal
// transition, and quarantine-resume.ts's crash-recovery path rebuilds that same terminal
// transition from the operation record alone. Minting fresh values here (a plausible-looking
// "current" deviceId/nonce/createdAt) would pass this function's own happy path but desync from
// both of those, breaking either the immediate commit or a future crash-recovered resume. Only
// the operation's own event fields (operationId, phase, targetWorktreePath) and the real move
// destination (locations.artifact, derived separately by quarantineOperationPaths) are new; the
// preflight/evidence-derived fingerprint and device values are live sanity checks only, never
// written to the record.
export async function executeRestore(input: ExecuteRestoreInput): Promise<ExecuteRestoreResult> {
  const { paths, repoRoot, config, session, quarantineId, targetWorktreePath } = input;
  const item = await readQuarantineItem({ paths, quarantineId });
  if (!item || item.record.state !== "available") throw new Error("restore requires an available quarantine item");
  const identity = item.record;

  const operationId = crypto.randomUUID();
  const artifactRelativePath = path.relative(paths.quarantineDir, identity.artifactPath);

  const preflight = await buildQuarantinePathPreflight({
    action: "restore", artifactRelativePath, config, metadataRoot: paths.quarantineDir, repoRoot, session,
    originalRelativePath: identity.originalRelativePath, originalWorktreePath: identity.originalWorktreePath, targetWorktreePath,
  });
  if (!preflight.ok) throw new Error(`restore preflight blocked: ${preflight.blockers.map((blocker) => blocker.reason).join("; ")}`);
  const worktreePath = preflight.facts.worktreePath;
  if (!worktreePath) throw new Error("restore preflight did not resolve a target worktree");
  if (preflight.facts.source.deviceId === null || preflight.facts.source.deviceId !== preflight.facts.destination.deviceId) throw new Error("restore device identity is unavailable or crosses devices");

  const locations = quarantineOperationPaths(paths, {
    action: "restore", quarantineId, operationId,
    originalWorktreePath: identity.originalWorktreePath, originalRelativePath: identity.originalRelativePath, targetWorktreePath: worktreePath,
  });

  const evidence = await collectQuarantineEvidence(locations.sourceRoot, locations.source);
  if (evidence.kind !== "present" || JSON.stringify(evidence.fingerprint) !== JSON.stringify(identity.fingerprint)) throw new Error("quarantine artifact fingerprint drift; refusing restore");

  const prepared = await withStateTransaction(paths, async () => {
    const fresh = await readQuarantineItem({ paths, quarantineId });
    if (!fresh || fresh.digest !== item.digest) throw new Error("quarantine item changed before restore could be prepared");
    return writeQuarantineOperationTransitionLocked({
      paths,
      record: {
        version: 1, kind: "quarantine-operation",
        quarantineId, operationId, action: "restore", phase: "prepared",
        sessionId: identity.sessionId, lineageId: identity.lineageId,
        originalRelativePath: identity.originalRelativePath, originalWorktreePath: identity.originalWorktreePath,
        artifactPath: identity.artifactPath, fingerprint: identity.fingerprint, fingerprintDigest: identity.fingerprintDigest,
        manifestDigest: identity.manifestDigest, doneIntentDigest: identity.doneIntentDigest,
        guardianStateRevision: identity.guardianStateRevision, sessionRevision: identity.sessionRevision,
        deviceId: identity.deviceId, nonce: identity.nonce, createdAt: identity.createdAt,
        targetWorktreePath: worktreePath,
      },
    });
  });

  await moveQuarantinePathCooperatively({ sourcePath: locations.source, destinationPath: locations.artifact, sourceRoot: locations.sourceRoot, destinationRoot: locations.artifactRoot, expectedFingerprint: identity.fingerprint });

  const renamed = await writeQuarantineOperationTransition({ paths, record: nextOperationTransition(prepared, "renamed") });

  const preCommitItem = await readQuarantineItem({ paths, quarantineId });
  await writeQuarantineItemTransition({
    paths,
    record: {
      quarantineId, sessionId: identity.sessionId, lineageId: identity.lineageId,
      originalRelativePath: identity.originalRelativePath, originalWorktreePath: identity.originalWorktreePath,
      artifactPath: identity.artifactPath, fingerprint: identity.fingerprint, fingerprintDigest: identity.fingerprintDigest,
      manifestDigest: identity.manifestDigest, doneIntentDigest: identity.doneIntentDigest,
      guardianStateRevision: identity.guardianStateRevision, sessionRevision: identity.sessionRevision,
      deviceId: identity.deviceId, nonce: identity.nonce, createdAt: identity.createdAt,
      state: "restored", predecessorDigest: preCommitItem?.digest ?? item.digest,
    },
  });

  await writeQuarantineOperationTransition({ paths, record: nextOperationTransition(renamed, "committed") });

  return { operationId, restoredPath: locations.artifact };
}

export type ExecutePurgeInput = { readonly paths: GuardianPaths; readonly quarantineId: string };
export type ExecutePurgeResult = { readonly operationId: string; readonly tombstonePath: string };

// Purge never touches a worktree or session binding -- it is entirely internal to quarantine
// metadata (item payload -> tombstone -> deleted), so it does not go through
// buildQuarantinePathPreflight (which is worktree/session-shaped). Its operation/item identity
// fields follow the same frozen-identity rule as executeRestore above: copied verbatim from
// item.record, never freshly minted, so sameIdentity checks and crash-recovery both stay
// consistent. moveQuarantinePathCooperatively still independently re-verifies the fingerprint and
// EXDEV device match immediately before its own rename; this function's own pre-move check exists
// only to fail with a clearer error, not as the last line of defense.
export async function executePurge(input: ExecutePurgeInput): Promise<ExecutePurgeResult> {
  const { paths, quarantineId } = input;
  const item = await readQuarantineItem({ paths, quarantineId });
  if (!item || item.record.state !== "available") throw new Error("purge requires an available quarantine item");
  const identity = item.record;

  const operationId = crypto.randomUUID();
  const tombstoneRoot = path.join(paths.quarantineDir, "tombstones", operationId, "payload");
  const tombstonePath = path.join(tombstoneRoot, identity.originalRelativePath);
  const locations = quarantineOperationPaths(paths, {
    action: "purge", quarantineId, operationId,
    originalWorktreePath: identity.originalWorktreePath, originalRelativePath: identity.originalRelativePath, tombstonePath,
  });

  const evidence = await collectQuarantineEvidence(locations.artifactRoot, locations.artifact);
  if (evidence.kind !== "present" || JSON.stringify(evidence.fingerprint) !== JSON.stringify(identity.fingerprint)) {
    throw new Error("quarantine artifact fingerprint drift; refusing purge");
  }

  const prepared = await withStateTransaction(paths, async () => {
    const fresh = await readQuarantineItem({ paths, quarantineId });
    if (!fresh || fresh.digest !== item.digest) throw new Error("quarantine item changed before purge could be prepared");
    return writeQuarantineOperationTransitionLocked({
      paths,
      record: {
        version: 1, kind: "quarantine-operation",
        quarantineId, operationId, action: "purge", phase: "prepared",
        sessionId: identity.sessionId, lineageId: identity.lineageId,
        originalRelativePath: identity.originalRelativePath, originalWorktreePath: identity.originalWorktreePath,
        artifactPath: identity.artifactPath, fingerprint: identity.fingerprint, fingerprintDigest: identity.fingerprintDigest,
        manifestDigest: identity.manifestDigest, doneIntentDigest: identity.doneIntentDigest,
        guardianStateRevision: identity.guardianStateRevision, sessionRevision: identity.sessionRevision,
        deviceId: identity.deviceId, nonce: identity.nonce, createdAt: identity.createdAt,
        tombstonePath,
      },
    });
  });

  await moveQuarantinePathCooperatively({ sourcePath: locations.artifact, destinationPath: tombstonePath, sourceRoot: locations.artifactRoot, destinationRoot: tombstoneRoot, expectedFingerprint: identity.fingerprint });

  const tombstoned = await writeQuarantineOperationTransition({ paths, record: nextOperationTransition(prepared, "tombstoned") });

  await fs.rm(tombstonePath, { recursive: true, force: false });

  const removed = await writeQuarantineOperationTransition({ paths, record: nextOperationTransition(tombstoned, "removed") });

  const preCommitItem = await readQuarantineItem({ paths, quarantineId });
  await writeQuarantineItemTransition({
    paths,
    record: {
      quarantineId, sessionId: identity.sessionId, lineageId: identity.lineageId,
      originalRelativePath: identity.originalRelativePath, originalWorktreePath: identity.originalWorktreePath,
      artifactPath: identity.artifactPath, fingerprint: identity.fingerprint, fingerprintDigest: identity.fingerprintDigest,
      manifestDigest: identity.manifestDigest, doneIntentDigest: identity.doneIntentDigest,
      guardianStateRevision: identity.guardianStateRevision, sessionRevision: identity.sessionRevision,
      deviceId: identity.deviceId, nonce: identity.nonce, createdAt: identity.createdAt,
      state: "purged", predecessorDigest: preCommitItem?.digest ?? item.digest,
    },
  });

  await writeQuarantineOperationTransition({ paths, record: nextOperationTransition(removed, "committed") });

  return { operationId, tombstonePath };
}
