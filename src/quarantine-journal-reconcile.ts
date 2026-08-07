import type { JournaledRecord } from "./quarantine-journal.ts";
import type { QuarantineFingerprintEntry, QuarantineItemRecordV1, QuarantineOperationRecordV1 } from "./quarantine-types.ts";

export type QuarantineEvidence =
  | { readonly kind: "present"; readonly fingerprint: readonly QuarantineFingerprintEntry[] }
  | { readonly kind: "partial"; readonly fingerprint: readonly QuarantineFingerprintEntry[] }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous"; readonly reason: string };
export type QuarantineReconciliation =
  | { readonly status: "needs-rename"; readonly operation: JournaledRecord<QuarantineOperationRecordV1> }
  // The physical move/removal already happened (a crash landed between the filesystem action and
  // its own journal write); only the journal transition to `phase` remains, no filesystem action.
  | { readonly status: "needs-phase-advance"; readonly phase: "renamed" | "tombstoned" | "removed"; readonly operation: JournaledRecord<QuarantineOperationRecordV1> }
  | { readonly status: "needs-removal"; readonly operation: JournaledRecord<QuarantineOperationRecordV1> }
  | { readonly status: "needs-commit"; readonly operation: JournaledRecord<QuarantineOperationRecordV1> }
  | { readonly status: "complete"; readonly operation: JournaledRecord<QuarantineOperationRecordV1> }
  | { readonly status: "blocked"; readonly reason: string };

function orderedSubset(recorded: readonly QuarantineFingerprintEntry[], observed: readonly QuarantineFingerprintEntry[]): boolean {
  let index = 0;
  for (const entry of observed) {
    while (index < recorded.length && JSON.stringify(recorded[index]) !== JSON.stringify(entry)) index += 1;
    if (index === recorded.length) return false;
    index += 1;
  }
  return true;
}

function hasExactFingerprint(evidence: QuarantineEvidence, fingerprint: readonly QuarantineFingerprintEntry[]): boolean {
  return evidence.kind === "present" && JSON.stringify(evidence.fingerprint) === JSON.stringify(fingerprint);
}

// State alone is not enough to prove an item belongs to this operation: a crash between the
// item's terminal transition and the operation's own committed record must still be told apart
// from an unrelated item that merely happens to share a state. Compare full identity.
function matchesItemOperation(item: JournaledRecord<QuarantineItemRecordV1> | undefined, operation: JournaledRecord<QuarantineOperationRecordV1>): boolean {
  const left = item?.record;
  const right = operation.record;
  return left !== undefined
    && left.quarantineId === right.quarantineId && left.sessionId === right.sessionId && left.lineageId === right.lineageId
    && left.originalRelativePath === right.originalRelativePath && left.originalWorktreePath === right.originalWorktreePath && left.artifactPath === right.artifactPath
    && JSON.stringify(left.fingerprint) === JSON.stringify(right.fingerprint) && left.fingerprintDigest === right.fingerprintDigest && left.manifestDigest === right.manifestDigest
    && left.doneIntentDigest === right.doneIntentDigest && left.guardianStateRevision === right.guardianStateRevision && left.sessionRevision === right.sessionRevision
    && left.deviceId === right.deviceId && left.nonce === right.nonce && left.createdAt === right.createdAt;
}

function hasItemState(item: JournaledRecord<QuarantineItemRecordV1> | undefined, operation: JournaledRecord<QuarantineOperationRecordV1>, state: QuarantineItemRecordV1["state"]): boolean {
  return matchesItemOperation(item, operation) && item?.record.state === state;
}

function moveReconciliation(input: { readonly item?: JournaledRecord<QuarantineItemRecordV1>; readonly operation: JournaledRecord<QuarantineOperationRecordV1>; readonly source: QuarantineEvidence; readonly artifact: QuarantineEvidence }, expectedItemState: QuarantineItemRecordV1["state"], preCommitItemState: QuarantineItemRecordV1["state"] | undefined): QuarantineReconciliation {
  const { item, operation, source, artifact } = input;
  const hasPreCommitItem = preCommitItemState === undefined ? item === undefined : hasItemState(item, operation, preCommitItemState);
  const hasTerminalItem = hasItemState(item, operation, expectedItemState);
  switch (operation.record.phase) {
    case "prepared":
      if (hasPreCommitItem && hasExactFingerprint(source, operation.record.fingerprint) && artifact.kind === "missing") return { status: "needs-rename", operation };
      // The rename already ran (only a fresh, quarantineId-scoped artifact path could hold this
      // exact content) and only a crash before the "renamed" journal write remains to resolve.
      if (hasPreCommitItem && source.kind === "missing" && hasExactFingerprint(artifact, operation.record.fingerprint)) return { status: "needs-phase-advance", phase: "renamed", operation };
      return { status: "blocked", reason: "Prepared move requires an exact source fingerprint and an absent destination" };
    case "renamed":
      // Either the item transition is still pending, or it already survived a crash and only
      // this operation's own committed record remains to be written.
      if ((hasPreCommitItem || hasTerminalItem) && source.kind === "missing" && hasExactFingerprint(artifact, operation.record.fingerprint)) return { status: "needs-commit", operation };
      return { status: "blocked", reason: "Renamed move requires an absent source and exact destination fingerprint" };
    case "committed":
      if (hasTerminalItem && source.kind === "missing" && hasExactFingerprint(artifact, operation.record.fingerprint)) return { status: "complete", operation };
      return { status: "blocked", reason: "Committed move requires its terminal item state and exact post-rename evidence" };
    default: return { status: "blocked", reason: "Move operation has an invalid phase" };
  }
}

export function reconcileQuarantineOperation(input: { readonly item?: JournaledRecord<QuarantineItemRecordV1>; readonly operation: JournaledRecord<QuarantineOperationRecordV1>; readonly source: QuarantineEvidence; readonly artifact: QuarantineEvidence; readonly tombstone?: QuarantineEvidence }): QuarantineReconciliation {
  const { operation } = input;
  if (input.source.kind === "ambiguous" || input.artifact.kind === "ambiguous" || input.tombstone?.kind === "ambiguous") return { status: "blocked", reason: "Live source or artifact evidence is ambiguous" };
  switch (operation.record.action) {
    case "quarantine": return moveReconciliation(input, "available", undefined);
    case "restore": return moveReconciliation(input, "restored", "available");
    case "purge":
      switch (operation.record.phase) {
        case "prepared":
          if (hasItemState(input.item, operation, "available") && hasExactFingerprint(input.source, operation.record.fingerprint) && hasExactFingerprint(input.artifact, operation.record.fingerprint) && input.tombstone?.kind === "missing") return { status: "needs-rename", operation };
          return { status: "blocked", reason: "Prepared purge requires an available item, exact artifact evidence, and an absent tombstone" };
        case "tombstoned": {
          const tombstone = input.tombstone;
          // Unlike the artifact-side rename above, a missing tombstone here is pure absence of
          // evidence: it cannot be distinguished from external interference the way an exact
          // fingerprint match can, so this stays a hard block rather than an assumed advance.
          if (!tombstone || tombstone.kind === "missing") return { status: "blocked", reason: "Missing tombstone is not completion evidence" };
          if (!hasItemState(input.item, operation, "available") || input.source.kind !== "missing" || input.artifact.kind !== "missing") return { status: "blocked", reason: "Tombstoned purge requires an available item and absent source/artifact" };
          if (hasExactFingerprint(tombstone, operation.record.fingerprint)) return { status: "needs-removal", operation };
          if (tombstone.kind === "partial" && tombstone.fingerprint.length > 0 && orderedSubset(operation.record.fingerprint, tombstone.fingerprint)) return { status: "needs-removal", operation };
          return { status: "blocked", reason: "Tombstone fingerprint does not match the recorded ordered subset" };
        }
        case "removed":
          // Either the item's purged transition is still pending, or it already survived a crash
          // and only this operation's own committed record remains to be written.
          if ((hasItemState(input.item, operation, "available") || hasItemState(input.item, operation, "purged")) && input.source.kind === "missing" && input.artifact.kind === "missing" && input.tombstone?.kind === "missing") return { status: "needs-commit", operation };
          return { status: "blocked", reason: "Removed purge requires an available or purged item and absent artifact/tombstone evidence" };
        case "committed":
          if (hasItemState(input.item, operation, "purged") && input.source.kind === "missing" && input.artifact.kind === "missing" && input.tombstone?.kind === "missing") return { status: "complete", operation };
          return { status: "blocked", reason: "Committed purge requires a purged item and absent artifact/tombstone evidence" };
        default: return { status: "blocked", reason: "Purge operation has an invalid phase" };
      }
  }
}
