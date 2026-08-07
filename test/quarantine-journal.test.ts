import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import test from "node:test";
import { getGuardianPaths, withStateTransaction } from "../src/state.ts";
import { reconcileQuarantineOperation, readQuarantineItem, readQuarantineOperation, writeQuarantineItemTransition, writeQuarantineOperationTransition } from "../src/quarantine-journal.ts";
import { createRepo } from "./helpers.ts";

const journalModuleUrl = new URL("../src/quarantine-journal.ts", import.meta.url).href;
const stateModuleUrl = new URL("../src/state.ts", import.meta.url).href;

async function crashAfterRecordDurable(repo: string, record: Record<string, unknown>): Promise<void> {
  const script = `
    import { writeQuarantineOperationTransition } from ${JSON.stringify(journalModuleUrl)};
    import { getGuardianPaths } from ${JSON.stringify(stateModuleUrl)};
    await writeQuarantineOperationTransition({
      paths: await getGuardianPaths(${JSON.stringify(repo)}),
      record: ${JSON.stringify(record)},
      hooks: { afterRecordDurable: async () => process.kill(process.pid, "SIGKILL") },
    });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), stdio: "ignore" });
  const [, signal] = await once(child, "exit");
  assert.equal(signal, "SIGKILL");
}

test("Given an absent quarantine item, when its available transition is journaled, then a digest-verified immutable record is durable", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  const record = await writeQuarantineItemTransition({
    paths,
    record: {
      quarantineId: "item-1",
      sessionId: "ses-journal",
      lineageId: "lineage-journal",
      state: "available",
      originalRelativePath: "residue/output.txt",
      originalWorktreePath: repo,
      artifactPath: `${paths.quarantineDir}/item-1`,
      fingerprint: [{ path: "residue/output.txt", kind: "file", size: 9, sha256: "a".repeat(64) }],
      fingerprintDigest: "b".repeat(64),
      manifestDigest: "c".repeat(64),
      doneIntentDigest: "d".repeat(64),
      guardianStateRevision: 3,
      sessionRevision: 2,
      deviceId: 1,
      nonce: "123e4567-e89b-12d3-a456-426614174000",
      createdAt: "2026-08-05T00:00:00.000Z",
    },
  });

  assert.match(record.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(await readQuarantineItem({ paths, quarantineId: "item-1" }), record);
  assert.equal((await fs.readdir(paths.journalDir, { recursive: true })).length > 0, true);
});

test("Given an available item, when it transitions to restored or purged, then only one forward terminal transition is accepted", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  const base = {
    quarantineId: "item-forward",
    sessionId: "ses-journal",
    lineageId: "lineage-journal",
    originalRelativePath: "residue/output.txt",
    originalWorktreePath: repo,
    artifactPath: `${paths.quarantineDir}/item-forward`,
    fingerprint: [{ path: "residue/output.txt", kind: "file" as const, size: 9, sha256: "a".repeat(64) }],
    fingerprintDigest: "b".repeat(64),
    manifestDigest: "c".repeat(64),
    doneIntentDigest: "d".repeat(64),
    guardianStateRevision: 3,
    sessionRevision: 2,
    deviceId: 1,
    nonce: "123e4567-e89b-12d3-a456-426614174001",
    createdAt: "2026-08-05T00:00:00.000Z",
  };
  const available = await writeQuarantineItemTransition({ paths, record: { ...base, state: "available" } });
  const restored = await writeQuarantineItemTransition({ paths, record: { ...base, state: "restored", predecessorDigest: available.digest } });

  assert.equal((await readQuarantineItem({ paths, quarantineId: base.quarantineId }))?.digest, restored.digest);
  await assert.rejects(() => writeQuarantineItemTransition({ paths, record: { ...base, state: "purged", predecessorDigest: available.digest } }), /terminal/);
  await assert.rejects(() => writeQuarantineItemTransition({ paths, record: { ...base, state: "available" } }), /terminal/);
});

test("Given an operation journal, when it progresses through a legal phase graph, then backward or non-contiguous phases are rejected", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  const base = {
    operationId: "operation-forward",
    quarantineId: "item-operation",
    sessionId: "ses-journal",
    lineageId: "lineage-journal",
    originalRelativePath: "residue/output.txt",
    originalWorktreePath: repo,
    artifactPath: `${paths.quarantineDir}/item-operation`,
    fingerprint: [{ path: "residue/output.txt", kind: "file" as const, size: 9, sha256: "a".repeat(64) }],
    fingerprintDigest: "b".repeat(64),
    manifestDigest: "c".repeat(64),
    doneIntentDigest: "d".repeat(64),
    guardianStateRevision: 3,
    sessionRevision: 2,
    deviceId: 1,
    nonce: "123e4567-e89b-12d3-a456-426614174002",
    createdAt: "2026-08-05T00:00:00.000Z",
    action: "quarantine" as const,
  };
  const prepared = await writeQuarantineOperationTransition({ paths, record: { ...base, phase: "prepared" } });
  assert.equal(reconcileQuarantineOperation({ operation: prepared, source: { kind: "missing" }, artifact: { kind: "missing" } }).status, "blocked");
  assert.equal(reconcileQuarantineOperation({ operation: prepared, source: { kind: "present", fingerprint: base.fingerprint }, artifact: { kind: "missing" } }).status, "needs-rename");
  await assert.rejects(() => writeQuarantineOperationTransition({ paths, record: { ...base, phase: "committed", predecessorDigest: prepared.digest } }), /immediate successor/);
  const renamed = await writeQuarantineOperationTransition({ paths, record: { ...base, phase: "renamed", predecessorDigest: prepared.digest } });
  assert.equal(reconcileQuarantineOperation({ operation: renamed, source: { kind: "missing" }, artifact: { kind: "missing" } }).status, "blocked");
  assert.equal(reconcileQuarantineOperation({ operation: renamed, source: { kind: "missing" }, artifact: { kind: "present", fingerprint: base.fingerprint } }).status, "needs-commit");
  const committed = await writeQuarantineOperationTransition({ paths, record: { ...base, phase: "committed", predecessorDigest: renamed.digest } });

  assert.equal(reconcileQuarantineOperation({ operation: committed, source: { kind: "missing" }, artifact: { kind: "missing" } }).status, "blocked");
  const item = await writeQuarantineItemTransition({
    paths,
    record: {
      quarantineId: base.quarantineId, sessionId: base.sessionId, lineageId: base.lineageId, state: "available", originalRelativePath: base.originalRelativePath,
      originalWorktreePath: base.originalWorktreePath, artifactPath: base.artifactPath, fingerprint: base.fingerprint, fingerprintDigest: base.fingerprintDigest,
      manifestDigest: base.manifestDigest, doneIntentDigest: base.doneIntentDigest, guardianStateRevision: base.guardianStateRevision, sessionRevision: base.sessionRevision,
      deviceId: base.deviceId, nonce: base.nonce, createdAt: base.createdAt,
    },
  });
  assert.equal(reconcileQuarantineOperation({ item, operation: committed, source: { kind: "missing" }, artifact: { kind: "present", fingerprint: base.fingerprint } }).status, "complete");
  await assert.rejects(() => writeQuarantineOperationTransition({ paths, record: { ...base, phase: "renamed", predecessorDigest: committed.digest } }), /terminal/);
});

test("Given a committed restore, when terminal state or post-rename evidence is missing, then reconciliation blocks", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  const itemBase = {
    quarantineId: "item-restore", sessionId: "ses-journal", lineageId: "lineage-journal", originalRelativePath: "residue.txt", originalWorktreePath: repo,
    artifactPath: `${paths.quarantineDir}/item-restore`, fingerprint: [{ path: "residue.txt", kind: "file" as const, size: 9, sha256: "a".repeat(64) }],
    fingerprintDigest: "b".repeat(64), manifestDigest: "c".repeat(64), doneIntentDigest: "d".repeat(64), guardianStateRevision: 3, sessionRevision: 2,
    deviceId: 1, nonce: "123e4567-e89b-12d3-a456-426614174007", createdAt: "2026-08-05T00:00:00.000Z",
  };
  const available = await writeQuarantineItemTransition({ paths, record: { ...itemBase, state: "available" } });
  const operationBase = { ...itemBase, operationId: "operation-restore", action: "restore" as const, targetWorktreePath: repo };
  const prepared = await writeQuarantineOperationTransition({ paths, record: { ...operationBase, phase: "prepared" } });
  const renamed = await writeQuarantineOperationTransition({ paths, record: { ...operationBase, phase: "renamed", predecessorDigest: prepared.digest } });
  const committed = await writeQuarantineOperationTransition({ paths, record: { ...operationBase, phase: "committed", predecessorDigest: renamed.digest } });

  assert.equal(reconcileQuarantineOperation({ item: available, operation: committed, source: { kind: "missing" }, artifact: { kind: "present", fingerprint: itemBase.fingerprint } }).status, "blocked");
  const restored = await writeQuarantineItemTransition({ paths, record: { ...itemBase, state: "restored", predecessorDigest: available.digest } });
  assert.equal(reconcileQuarantineOperation({ item: restored, operation: committed, source: { kind: "missing" }, artifact: { kind: "missing" } }).status, "blocked");
  assert.equal(reconcileQuarantineOperation({ item: restored, operation: committed, source: { kind: "missing" }, artifact: { kind: "present", fingerprint: itemBase.fingerprint } }).status, "complete");
});

test("Given a deterministic record path, when a create-only replay collides, then only identical bytes are accepted", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  const record = {
    quarantineId: "item-collision",
    sessionId: "ses-journal",
    lineageId: "lineage-journal",
    state: "available" as const,
    originalRelativePath: "residue/output.txt",
    originalWorktreePath: repo,
    artifactPath: `${paths.quarantineDir}/item-collision`,
    fingerprint: [{ path: "residue/output.txt", kind: "file" as const, size: 9, sha256: "a".repeat(64) }],
    fingerprintDigest: "b".repeat(64),
    manifestDigest: "c".repeat(64),
    doneIntentDigest: "d".repeat(64),
    guardianStateRevision: 3,
    sessionRevision: 2,
    deviceId: 1,
    nonce: "123e4567-e89b-12d3-a456-426614174003",
    createdAt: "2026-08-05T00:00:00.000Z",
  };
  const first = await writeQuarantineItemTransition({ paths, record });
  const replay = await writeQuarantineItemTransition({ paths, record });

  assert.equal(replay.digest, first.digest);
  await assert.rejects(() => writeQuarantineItemTransition({ paths, record: { ...record, manifestDigest: "e".repeat(64) } }), /overwrite/);
});

test("Given a purge tombstone journal phase, when only an unchanged ordered fingerprint subset remains, then reconciliation requests removal without mutating artifacts", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  const source = `${repo}/residue.txt`;
  await fs.writeFile(source, "artifact\n");
  const fingerprint = [
    { path: "residue", kind: "directory" as const },
    { path: "residue/output.txt", kind: "file" as const, size: 9, sha256: "a".repeat(64) },
  ];
  const itemBase = {
    quarantineId: "item-purge",
    sessionId: "ses-journal",
    lineageId: "lineage-journal",
    originalRelativePath: "residue/output.txt",
    originalWorktreePath: repo,
    artifactPath: `${paths.quarantineDir}/item-purge`,
    fingerprint,
    fingerprintDigest: "b".repeat(64),
    manifestDigest: "c".repeat(64),
    doneIntentDigest: "d".repeat(64),
    guardianStateRevision: 3,
    sessionRevision: 2,
    deviceId: 1,
    nonce: "123e4567-e89b-12d3-a456-426614174004",
    createdAt: "2026-08-05T00:00:00.000Z",
  };
  const item = await writeQuarantineItemTransition({ paths, record: { ...itemBase, state: "available" } });
  const operationBase = { ...itemBase, operationId: "operation-purge", action: "purge" as const, tombstonePath: `${paths.quarantineDir}/tombstone-purge` };
  const prepared = await writeQuarantineOperationTransition({ paths, record: { ...operationBase, phase: "prepared" } });
  const tombstoned = await writeQuarantineOperationTransition({ paths, record: { ...operationBase, phase: "tombstoned", predecessorDigest: prepared.digest } });

  assert.equal(reconcileQuarantineOperation({ item, operation: prepared, source: { kind: "missing" }, artifact: { kind: "present", fingerprint }, tombstone: { kind: "missing" } }).status, "blocked");
  assert.equal(reconcileQuarantineOperation({ item, operation: prepared, source: { kind: "present", fingerprint }, artifact: { kind: "present", fingerprint }, tombstone: { kind: "missing" } }).status, "needs-rename");
  assert.deepEqual(reconcileQuarantineOperation({ item, operation: tombstoned, source: { kind: "missing" }, artifact: { kind: "missing" }, tombstone: { kind: "partial", fingerprint: [fingerprint[1]] } }), { status: "needs-removal", operation: tombstoned });
  assert.equal(reconcileQuarantineOperation({ item, operation: tombstoned, source: { kind: "missing" }, artifact: { kind: "missing" }, tombstone: { kind: "missing" } }).status, "blocked");
  const removed = await writeQuarantineOperationTransition({ paths, record: { ...operationBase, phase: "removed", predecessorDigest: tombstoned.digest } });
  assert.equal(reconcileQuarantineOperation({ item, operation: removed, source: { kind: "missing" }, artifact: { kind: "missing" }, tombstone: { kind: "missing" } }).status, "needs-commit");
  const committed = await writeQuarantineOperationTransition({ paths, record: { ...operationBase, phase: "committed", predecessorDigest: removed.digest } });
  assert.equal(reconcileQuarantineOperation({ item, operation: committed, source: { kind: "missing" }, artifact: { kind: "missing" }, tombstone: { kind: "missing" } }).status, "blocked");
  const purged = await writeQuarantineItemTransition({ paths, record: { ...itemBase, state: "purged", predecessorDigest: item.digest } });
  assert.equal(reconcileQuarantineOperation({ item: purged, operation: committed, source: { kind: "missing" }, artifact: { kind: "missing" }, tombstone: { kind: "missing" } }).status, "complete");
  assert.equal(await fs.readFile(source, "utf8"), "artifact\n");
  await assert.rejects(fs.access(itemBase.artifactPath));
});

test("Given the T3 lock is already held, when a public journal writer is called, then it rejects reentrant acquisition", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  await withStateTransaction(paths, async () => {
    await assert.rejects(() => writeQuarantineItemTransition({
      paths,
      record: {
        quarantineId: "item-reentrant", sessionId: "ses-journal", lineageId: "lineage-journal", state: "available", originalRelativePath: "residue.txt",
        originalWorktreePath: repo, artifactPath: `${paths.quarantineDir}/item-reentrant`, fingerprint: [{ path: "residue.txt", kind: "file", size: 9, sha256: "a".repeat(64) }],
        fingerprintDigest: "b".repeat(64), manifestDigest: "c".repeat(64), doneIntentDigest: "d".repeat(64), guardianStateRevision: 3, sessionRevision: 2, deviceId: 1,
        nonce: "123e4567-e89b-12d3-a456-426614174005", createdAt: "2026-08-05T00:00:00.000Z",
      },
    }), /non-reentrant/);
  });
});

test("Given a process crashes after each durable operation phase record, when a new process replays the exact phase, then recovery is lossless and source ambiguity blocks", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  const item = await writeQuarantineItemTransition({
    paths,
    record: {
      quarantineId: "item-crash", sessionId: "ses-journal", lineageId: "lineage-journal", state: "available", originalRelativePath: "residue.txt", originalWorktreePath: repo,
      artifactPath: `${paths.quarantineDir}/item-crash`, fingerprint: [{ path: "residue.txt", kind: "file", size: 9, sha256: "a".repeat(64) }], fingerprintDigest: "b".repeat(64),
      manifestDigest: "c".repeat(64), doneIntentDigest: "d".repeat(64), guardianStateRevision: 3, sessionRevision: 2, deviceId: 1, nonce: "123e4567-e89b-12d3-a456-426614174006", createdAt: "2026-08-05T00:00:00.000Z",
    },
  });
  const base = {
    operationId: "operation-crash", quarantineId: item.record.quarantineId, sessionId: item.record.sessionId, lineageId: item.record.lineageId,
    originalRelativePath: item.record.originalRelativePath, originalWorktreePath: item.record.originalWorktreePath, artifactPath: item.record.artifactPath, fingerprint: item.record.fingerprint,
    fingerprintDigest: item.record.fingerprintDigest, manifestDigest: item.record.manifestDigest, doneIntentDigest: item.record.doneIntentDigest, guardianStateRevision: item.record.guardianStateRevision,
    sessionRevision: item.record.sessionRevision, deviceId: item.record.deviceId, nonce: item.record.nonce, createdAt: item.record.createdAt, action: "restore" as const, targetWorktreePath: repo,
  };
  const preparedRecord = { ...base, phase: "prepared" as const };
  await crashAfterRecordDurable(repo, preparedRecord);
  const prepared = await writeQuarantineOperationTransition({ paths, record: preparedRecord });
  const renamedRecord = { ...base, phase: "renamed" as const, predecessorDigest: prepared.digest };
  await crashAfterRecordDurable(repo, renamedRecord);
  const renamed = await writeQuarantineOperationTransition({ paths, record: renamedRecord });
  const committedRecord = { ...base, phase: "committed" as const, predecessorDigest: renamed.digest };
  await crashAfterRecordDurable(repo, committedRecord);
  const committed = await writeQuarantineOperationTransition({ paths, record: committedRecord });

  assert.equal(reconcileQuarantineOperation({ item, operation: committed, source: { kind: "ambiguous", reason: "live writer" }, artifact: { kind: "missing" } }).status, "blocked");
  assert.equal((await readQuarantineOperation({ paths, operationId: base.operationId }))?.digest, committed.digest);
});
