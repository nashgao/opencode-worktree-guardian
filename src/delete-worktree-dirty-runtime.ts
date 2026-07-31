import path from "node:path";
import { blocked, errorMessage } from "./delete-worktree-report.ts";
import { cleanRedundantDirtyPaths, createDirtySnapshotRef, proveRedundantDirtyPaths, resolveRedundantDirtyBase } from "./delete-worktree-dirty-proof.ts";
import type { DirtySnapshotResult, RedundantDirtyProof } from "./delete-worktree-dirty-proof.ts";
import type { GuardianSession, WorktreeEntry } from "./types.ts";
import { resolveRemoteAuthority } from "./git-authority.ts";
import type { RemoteAuthority } from "./git-authority.ts";

type DirtyPreflightContext = {
  readonly input: Record<string, unknown>;
  readonly config: Record<string, unknown>;
  readonly preflight: Record<string, unknown>;
  readonly entry: WorktreeEntry;
};

type DirtyCleanupContext = {
  readonly input: Record<string, unknown>;
  readonly preflight: Record<string, unknown>;
  readonly entry: WorktreeEntry;
};

type DirtySnapshotContext = {
  readonly safetySessionId: string;
  readonly branch: string;
  readonly head: string;
};

function isRedundantDirtyKind(value: unknown): value is RedundantDirtyProof["kind"] {
  return value === "tracked-modified" || value === "tracked-deleted" || value === "untracked";
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRedundantDirtyProof(value: unknown): value is RedundantDirtyProof {
  return isUnknownRecord(value) && typeof value.path === "string" && typeof value.status === "string" && isRedundantDirtyKind(value.kind) && typeof value.baseRef === "string" && typeof value.baseRefOid === "string" && typeof value.matchesBase === "boolean";
}

function getRedundantDirtyProofs(preflight: Record<string, unknown>): readonly RedundantDirtyProof[] {
  const proofs = preflight.redundantDirtyProofs;
  if (!Array.isArray(proofs)) return [];
  return proofs.filter(isRedundantDirtyProof);
}

export function sessionSafetyRefs(session: GuardianSession, safetyRef: string, preflight: Record<string, unknown>) {
  return [...new Set([
    ...(session.safety_refs ?? []),
    safetyRef,
    ...(typeof preflight.dirtySnapshotRef === "string" ? [preflight.dirtySnapshotRef] : []),
  ])];
}

export function dirtyResultFields(preflight: Record<string, unknown>) {
  return {
    dirtySnapshotCommit: preflight.dirtySnapshotCommit ?? null,
    dirtySnapshotRef: preflight.dirtySnapshotRef ?? null,
    dirtySnapshotFileCount: preflight.dirtySnapshotFileCount ?? 0,
    dirtySnapshotFiles: preflight.dirtySnapshotFiles ?? [],
    cleanedDirtyFiles: preflight.cleanedDirtyFiles ?? [],
    cleanedDirtyFileCount: preflight.cleanedDirtyFileCount ?? 0,
    redundantDirtyProofs: preflight.redundantDirtyProofs ?? [],
    redundantDirtyFileCount: preflight.redundantDirtyFileCount ?? 0,
  };
}

export async function validateRedundantDirtyPreflight(context: DirtyPreflightContext, session: GuardianSession | undefined, dirtyFiles: readonly string[]) {
  const { input, config, preflight, entry } = context;
  if (dirtyFiles.length === 0) return null;
  if (input.allowRedundantDirtyPaths !== true) return blocked("worktree has uncommitted changes", { dirtyFiles, targetPath: entry.path }, preflight);
  const repoRoot = String(preflight.repoRoot);
  const baseRef = typeof input.ancestryBaseRef === "string" ? input.ancestryBaseRef : session?.base_ref ?? `${String(config.remote)}/${String(config.baseBranch)}`;
  let authority: RemoteAuthority;
  try {
    authority = resolveRemoteAuthority(baseRef, config);
    preflight.baseRef = authority.displayRef;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return blocked("base ref is malformed or untrusted for redundant dirty proof", { baseRef, error: errorMessage(error) }, preflight);
  }
  const base = await resolveRedundantDirtyBase(repoRoot, authority);
  if (!base.ok) {
    preflight.baseRefResolutionError = base.error;
    return blocked(base.reason, { baseRef, error: base.error }, preflight);
  }
  preflight.baseRefOid = base.baseRefOid;
  const proof = await proveRedundantDirtyPaths(entry.path, authority, base.baseRefOid);
  preflight.redundantDirtyProofs = proof.proofs;
  preflight.redundantDirtyFileCount = proof.proofs.length;
  if (!proof.ok) return blocked(proof.reason, { dirtyFiles, failedPath: proof.failedPath, redundantDirtyProofs: proof.proofs, targetPath: entry.path }, preflight);
  return null;
}

export async function applyRedundantDirtyCleanup(context: DirtyCleanupContext, snapshot: DirtySnapshotContext) {
  const { input, preflight, entry } = context;
  const repoRoot = String(preflight.repoRoot);
  const redundantDirtyProofs = getRedundantDirtyProofs(preflight);
  if (redundantDirtyProofs.length === 0) return null;
  let dirtySnapshot: DirtySnapshotResult;
  try {
    dirtySnapshot = await createDirtySnapshotRef(repoRoot, entry.path, {
      sessionId: snapshot.safetySessionId,
      branch: snapshot.branch,
      head: snapshot.head,
      paths: redundantDirtyProofs.map((proof) => proof.path),
      timestamp: input.timestamp,
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return blocked("dirty snapshot ref could not be created; refusing to remove worktree", { targetPath: path.resolve(entry.path), error: errorMessage(error) }, preflight);
  }
  preflight.dirtySnapshotCommit = dirtySnapshot.dirtySnapshotCommit;
  preflight.dirtySnapshotRef = dirtySnapshot.dirtySnapshotRef;
  preflight.dirtySnapshotFiles = dirtySnapshot.dirtySnapshotFiles;
  preflight.dirtySnapshotFileCount = dirtySnapshot.dirtySnapshotFiles.length;
  const cleanup = await cleanRedundantDirtyPaths(entry.path, redundantDirtyProofs);
  preflight.cleanedDirtyFiles = cleanup.cleanedFiles;
  preflight.cleanedDirtyFileCount = cleanup.cleanedFiles.length;
  if (cleanup.remainingEntries.length === 0) return null;
  preflight.remainingDirtyFiles = cleanup.remainingEntries.map((remaining) => remaining.path);
  return blocked("redundant dirty cleanup left uncommitted changes", { targetPath: path.resolve(entry.path), dirtySnapshotCommit: dirtySnapshot.dirtySnapshotCommit, dirtySnapshotRef: dirtySnapshot.dirtySnapshotRef, remainingDirtyFiles: preflight.remainingDirtyFiles }, preflight);
}
