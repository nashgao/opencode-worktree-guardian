import fs from "node:fs/promises";
import { collectQuarantineEvidence, nextOperationTransition, quarantineOperationPaths } from "./quarantine-evidence.ts";
import { listIncompleteQuarantineOperations, readQuarantineItem, reconcileQuarantineOperation, writeQuarantineItemTransition, writeQuarantineOperationTransition } from "./quarantine-journal.ts";
import type { JournaledRecord } from "./quarantine-journal.ts";
import { moveQuarantinePathCooperatively } from "./quarantine-move.ts";
import type { QuarantineItemRecordV1, QuarantineOperationRecordV1 } from "./quarantine-types.ts";
import type { GuardianPaths } from "./types.ts";

export type ResumeOutcome = { readonly operationId: string; readonly status: "resolved" | "blocked"; readonly reason?: string };

function itemTerminalState(action: QuarantineOperationRecordV1["action"]): QuarantineItemRecordV1["state"] {
  return action === "quarantine" ? "available" : action === "restore" ? "restored" : "purged";
}

function nextItemTransition(action: QuarantineOperationRecordV1["action"], current: JournaledRecord<QuarantineItemRecordV1> | undefined, operation: QuarantineOperationRecordV1) {
  const common = { quarantineId: operation.quarantineId, sessionId: operation.sessionId, lineageId: operation.lineageId, originalRelativePath: operation.originalRelativePath, originalWorktreePath: operation.originalWorktreePath, artifactPath: operation.artifactPath, fingerprint: operation.fingerprint, fingerprintDigest: operation.fingerprintDigest, manifestDigest: operation.manifestDigest, doneIntentDigest: operation.doneIntentDigest, guardianStateRevision: operation.guardianStateRevision, sessionRevision: operation.sessionRevision, deviceId: operation.deviceId, nonce: operation.nonce, createdAt: operation.createdAt };
  if (action === "quarantine") return { ...common, state: "available" as const };
  return { ...common, state: itemTerminalState(action), predecessorDigest: current?.digest ?? "" };
}

// A "prepared" operation with its file untouched needs two corrective steps to actually finish
// (move + renamed, then item + committed): each reconciliation call only advances one phase, so
// this must keep re-gathering evidence and re-reconciling until reconcileQuarantineOperation
// itself reports the operation complete. A hard iteration cap guards against any future logic
// defect turning into a real infinite loop instead of a visible, reportable failure.
const MAX_RESUME_STEPS_PER_OPERATION = 8;

// One incomplete operation's terminal journal record, reconciled to completion (or reported as
// blocked) by comparing it against live filesystem evidence. Never guesses: an ambiguous
// postcondition anywhere leaves the journal untouched and reports blocked for operator review.
async function resumeOperation(paths: GuardianPaths, initial: JournaledRecord<QuarantineOperationRecordV1>): Promise<ResumeOutcome> {
  const operationId = initial.record.operationId;
  let operation = initial;
  for (let step = 0; step < MAX_RESUME_STEPS_PER_OPERATION; step += 1) {
    const item = await readQuarantineItem({ paths, quarantineId: operation.record.quarantineId });
    let locations: ReturnType<typeof quarantineOperationPaths>;
    try {
      locations = quarantineOperationPaths(paths, operation.record);
    } catch (error) {
      return { operationId, status: "blocked", reason: error instanceof Error ? error.message : String(error) };
    }
    const [source, artifact, tombstone] = await Promise.all([
      collectQuarantineEvidence(locations.sourceRoot, locations.source),
      collectQuarantineEvidence(locations.artifactRoot, locations.artifact),
      locations.tombstone === undefined || locations.tombstoneRoot === undefined ? Promise.resolve(undefined) : collectQuarantineEvidence(locations.tombstoneRoot, locations.tombstone),
    ]);
    const reconciliation = reconcileQuarantineOperation({ item, operation, source, artifact, tombstone });
    if (reconciliation.status === "blocked") return { operationId, status: "blocked", reason: reconciliation.reason };
    if (reconciliation.status === "complete") return { operationId, status: "resolved" };
    try {
      if (reconciliation.status === "needs-rename") {
        const destination = operation.record.action === "purge" && locations.tombstone !== undefined ? locations.tombstone : locations.artifact;
        const destinationRoot = operation.record.action === "purge" && locations.tombstoneRoot !== undefined ? locations.tombstoneRoot : locations.artifactRoot;
        await moveQuarantinePathCooperatively({ sourcePath: locations.source, destinationPath: destination, sourceRoot: locations.sourceRoot, destinationRoot, expectedFingerprint: operation.record.fingerprint });
        operation = await writeQuarantineOperationTransition({ paths, record: nextOperationTransition(operation, operation.record.action === "purge" ? "tombstoned" : "renamed") });
        continue;
      }
      if (reconciliation.status === "needs-phase-advance") {
        operation = await writeQuarantineOperationTransition({ paths, record: nextOperationTransition(operation, reconciliation.phase) });
        continue;
      }
      if (reconciliation.status === "needs-removal") {
        if (locations.tombstone !== undefined) await fs.rm(locations.tombstone, { recursive: true, force: false });
        operation = await writeQuarantineOperationTransition({ paths, record: nextOperationTransition(operation, "removed") });
        continue;
      }
      // needs-commit: write the item transition only if it has not already survived a crash,
      // then always write the operation's own committed record.
      const alreadyTerminal = item?.record.state === itemTerminalState(operation.record.action);
      if (!alreadyTerminal) await writeQuarantineItemTransition({ paths, record: nextItemTransition(operation.record.action, item, operation.record) });
      operation = await writeQuarantineOperationTransition({ paths, record: nextOperationTransition(operation, "committed") });
      continue;
    } catch (error) {
      return { operationId, status: "blocked", reason: error instanceof Error ? error.message : String(error) };
    }
  }
  return { operationId, status: "blocked", reason: `reconciliation did not converge within ${MAX_RESUME_STEPS_PER_OPERATION} steps` };
}

export async function resumeIncompleteQuarantineOperations(paths: GuardianPaths): Promise<readonly ResumeOutcome[]> {
  const incomplete = await listIncompleteQuarantineOperations({ paths });
  const outcomes: ResumeOutcome[] = [];
  for (const operation of incomplete) outcomes.push(await resumeOperation(paths, operation));
  return outcomes;
}
