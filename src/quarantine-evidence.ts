import path from "node:path";
import type { DeletionFingerprintEntry } from "./deletion-fingerprint.ts";
import { collectCleanupFingerprint } from "./deletion-fingerprint.ts";
import { lstatOrMissing } from "./filesystem-boundaries.ts";
import type { JournaledRecord, QuarantineOperationTransition } from "./quarantine-journal.ts";
import type { QuarantineEvidence } from "./quarantine-journal-reconcile.ts";
import type { QuarantineFingerprintEntry, QuarantineOperationRecordV1 } from "./quarantine-types.ts";
import type { GuardianPaths } from "./types.ts";

// Prior full record has `version`/`kind`; the writer's transition input type omits both. Excess
// properties on a spread source are not flagged by TypeScript's literal excess-property check,
// but destructuring them out explicitly keeps every call site provably correct rather than
// relying on that non-obvious spread exemption. Shared by the executor and the resume driver so
// both produce identically-shaped next-phase transitions from the same prior record.
export function nextOperationTransition(operation: JournaledRecord<QuarantineOperationRecordV1>, phase: QuarantineOperationRecordV1["phase"]): QuarantineOperationTransition {
  const { version: _version, kind: _kind, ...rest } = operation.record;
  return { ...rest, phase, predecessorDigest: operation.digest } as QuarantineOperationTransition;
}

export function normalizeQuarantineFingerprint(entries: readonly DeletionFingerprintEntry[]): QuarantineFingerprintEntry[] {
  const fingerprint: QuarantineFingerprintEntry[] = [];
  for (const entry of entries) {
    const relativePath = entry["path"];
    const kind = entry["kind"];
    if (typeof relativePath !== "string") throw new Error("fingerprint entry is missing a path");
    if (kind === "directory") {
      fingerprint.push({ path: relativePath, kind: "directory" });
      continue;
    }
    if (kind === "file") {
      const size = entry["size"];
      const sha256 = entry["sha256"];
      if (typeof size !== "number" || typeof sha256 !== "string") throw new Error(`malformed file fingerprint entry: ${relativePath}`);
      fingerprint.push({ path: relativePath, kind: "file", size, sha256 });
      continue;
    }
    if (kind === "symlink") {
      const target = entry["target"];
      if (typeof target !== "string") throw new Error(`malformed symlink fingerprint entry: ${relativePath}`);
      fingerprint.push({ path: relativePath, kind: "symlink", target });
      continue;
    }
    throw new Error(`unsupported fingerprint entry kind at ${relativePath}: ${String(kind)}`);
  }
  return fingerprint;
}

// Reports what is actually on disk right now, independent of what any journal record expects.
// A non-exact-but-non-empty result is reported as "partial" rather than pre-judged against an
// expected fingerprint; reconcileQuarantineOperation owns the authoritative exact-match and
// ordered-subset comparisons so that logic exists in exactly one place.
export async function collectQuarantineEvidence(root: string, targetPath: string): Promise<QuarantineEvidence> {
  const stat = await lstatOrMissing(targetPath);
  if (!stat) return { kind: "missing" };
  let fingerprint: QuarantineFingerprintEntry[];
  try {
    fingerprint = normalizeQuarantineFingerprint(await collectCleanupFingerprint(root, targetPath));
  } catch (error) {
    return { kind: "ambiguous", reason: error instanceof Error ? error.message : String(error) };
  }
  return fingerprint.length > 0 ? { kind: "present", fingerprint } : { kind: "missing" };
}

export type QuarantineOperationLocations = {
  readonly source: string;
  readonly sourceRoot: string;
  readonly artifact: string;
  readonly artifactRoot: string;
  readonly tombstone?: string;
  readonly tombstoneRoot?: string;
};

type QuarantineOperationPathInput = {
  readonly action: "quarantine" | "restore" | "purge";
  readonly quarantineId: string;
  readonly operationId: string;
  readonly originalWorktreePath: string;
  readonly originalRelativePath: string;
  readonly targetWorktreePath?: string;
  readonly tombstonePath?: string;
};

// Every quarantined artifact lives at <quarantineDir>/items/<quarantineId>/payload/<relativePath>
// and every purge tombstone at <quarantineDir>/tombstones/<operationId>/payload/<relativePath>: the
// original relative path is preserved exactly, so fingerprints computed relative to either root
// always share the same entry paths as the original worktree-relative fingerprint. quarantineId
// and operationId are already fields on every journal record, so resume recomputes these roots
// directly by the same formula execute used -- never by storing or reverse-deriving them.
export function quarantineOperationPaths(paths: GuardianPaths, record: QuarantineOperationPathInput): QuarantineOperationLocations {
  const artifactRoot = path.join(paths.quarantineDir, "items", record.quarantineId, "payload");
  const artifact = path.join(artifactRoot, record.originalRelativePath);
  switch (record.action) {
    case "quarantine":
      return { source: path.join(record.originalWorktreePath, record.originalRelativePath), sourceRoot: record.originalWorktreePath, artifact, artifactRoot };
    case "restore": {
      if (typeof record.targetWorktreePath !== "string") throw new Error("restore operation record is missing its target worktree path");
      return { source: artifact, sourceRoot: artifactRoot, artifact: path.join(record.targetWorktreePath, record.originalRelativePath), artifactRoot: record.targetWorktreePath };
    }
    case "purge": {
      if (typeof record.tombstonePath !== "string") throw new Error("purge operation record is missing its tombstone path");
      const tombstoneRoot = path.join(paths.quarantineDir, "tombstones", record.operationId, "payload");
      return { source: artifact, sourceRoot: artifactRoot, artifact, artifactRoot, tombstone: record.tombstonePath, tombstoneRoot };
    }
  }
}
