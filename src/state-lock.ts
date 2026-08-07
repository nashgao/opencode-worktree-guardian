import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runGit } from "./git.ts";
import { ReferenceTransactionHookPolicyError } from "./git-process.ts";
import { assertNotSymlink, ensureDurableDirectory, removeDurable, syncDirectory, writeDurableCreate, writeDurableTemp } from "./state-durable-file.ts";
import { compareAndSwapLockRef, deriveNullObjectId, publishLockBlob } from "./state-lock-git.ts";
import type { GuardianPaths } from "./types.ts";

const lockRecordSchema = z.object({
  version: z.literal(1),
  pid: z.number().int().positive(),
  nonce: z.uuid(),
  generation: z.number().int().positive(),
  acquired_at: z.iso.datetime({ offset: true }),
}).strict();
const tombstoneSchema = z.object({ version: z.literal(1), old_oid: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/), record: lockRecordSchema }).strict();

type LockRecord = z.infer<typeof lockRecordSchema>;
type LockTombstone = z.infer<typeof tombstoneSchema>;
type ProcessStatus = "alive" | "dead" | "indeterminate";
type LockLease = { readonly objectId: string; readonly record: LockRecord };
const stateErrorKindByLockKind = {
  blocked: "lock_blocked",
  ownership_lost: "lock_ownership_lost",
  reentrant: "lock_reentrant",
  timeout: "lock_timeout",
} as const;

export type StateLockHooks = {
  readonly afterHashInputSynced?: (record: LockRecord) => Promise<void>;
  readonly afterBlobPublished?: (lease: LockLease) => Promise<void>;
  readonly afterCasAcquired?: (lease: LockLease) => Promise<void>;
  readonly afterCasReclaimed?: (lease: LockLease) => Promise<void>;
  readonly afterTempRemoved?: (record: LockRecord) => Promise<void>;
  readonly afterTombstoneSynced?: (tombstone: LockTombstone) => Promise<void>;
  readonly afterCasReleased?: (lease: LockLease) => Promise<void>;
};

export type StateLockOptions = { readonly timeoutMs?: number; readonly hooks?: StateLockHooks };
type StateLockErrorContext = { readonly cause?: unknown; readonly guardianPath?: string };

// Each acquire attempt/retry spawns several Git subprocesses (for-each-ref, cat-file,
// hash-object, update-ref), unlike the single fs.open("wx") the old file lock used. 5s was
// tuned for that cheaper lock and times out under real concurrent load; 30s matches the
// existing Git subprocess deadline elsewhere in this codebase.
export const DEFAULT_STATE_LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_BASE_MS = 25;
const LOCK_POLL_CAP_MS = 250;

// Capped exponential backoff with half-jitter, so many concurrent waiters spread out their
// polling instead of retrying in lockstep every 25ms.
function lockPollBackoffMs(attempt: number): number {
  const exponential = Math.min(LOCK_POLL_CAP_MS, LOCK_POLL_BASE_MS * 2 ** attempt);
  return Math.floor(exponential / 2 + Math.random() * (exponential / 2));
}

export class StateLockError extends Error {
  override readonly name = "StateLockError";
  readonly kind: "blocked" | "reentrant" | "timeout" | "ownership_lost";
  readonly stateErrorKind: "lock_blocked" | "lock_ownership_lost" | "lock_reentrant" | "lock_timeout";
  readonly guardianPath?: string;
  constructor(kind: "blocked" | "reentrant" | "timeout" | "ownership_lost", message: string, context: StateLockErrorContext = {}) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
    this.kind = kind;
    this.stateErrorKind = stateErrorKindByLockKind[kind];
    this.guardianPath = context.guardianPath;
  }
}

const activeTransaction = new AsyncLocalStorage<boolean>();

function processStatus(pid: number): ProcessStatus {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return "dead";
    return "indeterminate";
  }
}

async function currentLockObjectId(paths: GuardianPaths): Promise<string | null> {
  const output = (await runGit(paths.repoRoot, ["for-each-ref", "--count=1", "--format=%(objectname)%00%(symref)%00%(refname)", paths.lockRef])).stdout;
  if (output.length === 0) return null;
  const [objectId, symbolicTarget, refName] = output.split("\0");
  if (refName !== paths.lockRef) return null;
  if (symbolicTarget) throw new StateLockError("blocked", `Guardian lock ref is symbolic: ${paths.lockRef}`);
  if (!objectId) throw new StateLockError("blocked", `Guardian lock ref has no object id: ${paths.lockRef}`);
  return objectId;
}

async function readLockRecord(paths: GuardianPaths, objectId: string): Promise<LockRecord> {
  try {
    return lockRecordSchema.parse(JSON.parse((await runGit(paths.repoRoot, ["cat-file", "blob", objectId])).stdout));
  } catch (error) {
    throw new StateLockError("blocked", `Guardian lock ref points to malformed metadata: ${objectId}`, { cause: error });
  }
}

async function cleanupTemporaryInputs(paths: GuardianPaths): Promise<void> {
  await ensureDurableDirectory(paths.lockTmpDir);
  const entries = await fs.readdir(paths.lockTmpDir, { withFileTypes: true });
  let removed = false;
  for (const entry of entries) {
    const match = /^(?:lock|artifact)-(\d+)-/.exec(entry.name);
    if (!entry.isFile() || match === null) throw new StateLockError("blocked", `Malformed Guardian lock temporary metadata: ${path.join(paths.lockTmpDir, entry.name)}`);
    const pid = Number(match[1]);
    if (processStatus(pid) !== "dead") continue;
    await fs.unlink(path.join(paths.lockTmpDir, entry.name));
    removed = true;
  }
  if (removed) await syncDirectory(paths.lockTmpDir);
}

async function cas(paths: GuardianPaths, newObjectId: string, expectedObjectId: string): Promise<boolean> {
  try {
    await compareAndSwapLockRef({ repoRoot: paths.repoRoot, lockRef: paths.lockRef, newObjectId, expectedObjectId });
    return true;
  } catch (error) {
    // A reference-transaction-hook policy rejection means the ref update never ran at all: it is
    // a permanent block, not a lost race, so retrying would only spin until timeout. Surface it
    // immediately instead of falling into the CAS-mismatch retry path below.
    if (error instanceof ReferenceTransactionHookPolicyError) throw error;
    if (await currentLockObjectId(paths) !== expectedObjectId) return false;
    throw error;
  }
}

function sameGeneration(left: LockRecord, right: LockRecord): boolean {
  return left.pid === right.pid && left.nonce === right.nonce && left.generation === right.generation && left.acquired_at === right.acquired_at;
}

async function reconcileTombstones(paths: GuardianPaths, nullObjectId: string): Promise<void> {
  await ensureDurableDirectory(paths.lockTombstonesDir);
  const entries = await fs.readdir(paths.lockTombstonesDir, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const tombstonePath = path.join(paths.lockTombstonesDir, entry.name);
    if (!entry.isFile()) throw new StateLockError("blocked", `Malformed Guardian lock tombstone: ${tombstonePath}`);
    let tombstone: LockTombstone;
    try {
      tombstone = tombstoneSchema.parse(JSON.parse(await fs.readFile(tombstonePath, "utf8")));
    } catch (error) {
      throw new StateLockError("blocked", `Malformed Guardian lock tombstone: ${tombstonePath}`, { cause: error });
    }
    if (entry.name !== `release-${tombstone.record.nonce}-${tombstone.record.generation}.json`) throw new StateLockError("blocked", `Guardian lock tombstone identity mismatch: ${tombstonePath}`);
    const currentObjectId = await currentLockObjectId(paths);
    if (currentObjectId !== tombstone.old_oid) {
      await removeDurable(tombstonePath);
      continue;
    }
    const authoritative = await readLockRecord(paths, tombstone.old_oid);
    if (!sameGeneration(authoritative, tombstone.record)) throw new StateLockError("blocked", `Guardian lock tombstone generation mismatch: ${tombstonePath}`);
    if (processStatus(tombstone.record.pid) !== "dead") throw new StateLockError("blocked", `Guardian lock tombstone owner is not definitively dead: ${tombstonePath}`);
    if (await cas(paths, nullObjectId, tombstone.old_oid)) {
      if (await currentLockObjectId(paths) !== null) throw new StateLockError("ownership_lost", "Guardian tombstone release verification failed");
      await removeDurable(tombstonePath);
    } else if (await currentLockObjectId(paths) !== tombstone.old_oid) {
      await removeDurable(tombstonePath);
    }
  }
}

async function publishCandidate(paths: GuardianPaths, record: LockRecord, hooks: StateLockHooks): Promise<LockLease> {
  const input = `${JSON.stringify(record)}\n`;
  const temporaryPath = await writeDurableTemp(paths.lockTmpDir, `lock-${record.pid}-${record.generation}-${record.nonce}.json`, input);
  await hooks.afterHashInputSynced?.(record);
  try {
    const objectId = await publishLockBlob(paths.repoRoot, await fs.readFile(temporaryPath, "utf8"));
    const lease = { objectId, record };
    await hooks.afterBlobPublished?.(lease);
    return lease;
  } finally {
    await removeDurable(temporaryPath);
    await hooks.afterTempRemoved?.(record);
  }
}

async function acquire(paths: GuardianPaths, options: StateLockOptions): Promise<{ readonly lease: LockLease; readonly nullObjectId: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STATE_LOCK_TIMEOUT_MS;
  const hooks = options.hooks ?? {};
  const started = Date.now();
  await assertNotSymlink(paths.lockPath, "legacy lock");
  try {
    await fs.access(paths.lockPath);
    throw new StateLockError("blocked", `Legacy Guardian path lock blocks Git-ref lock acquisition: ${paths.lockPath}`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await ensureDurableDirectory(paths.dir);
  await ensureDurableDirectory(paths.lockTmpDir);
  await ensureDurableDirectory(paths.lockTombstonesDir);
  const nullObjectId = await deriveNullObjectId(paths.repoRoot);
  await reconcileTombstones(paths, nullObjectId);
  await cleanupTemporaryInputs(paths);
  let pollAttempt = 0;
  // Keyed by the last observed object id: since Git object ids are content hashes, an unchanged
  // id guarantees unchanged record content, so a repeat observation can reuse it without another
  // cat-file round trip. processStatus is still re-checked fresh on every iteration.
  let cachedObjectId: string | null = null;
  let cachedRecord: LockRecord | null = null;
  while (true) {
    const observedObjectId = await currentLockObjectId(paths);
    let generation = 1;
    let reclaimed = false;
    if (observedObjectId !== null) {
      const observed: LockRecord = observedObjectId === cachedObjectId && cachedRecord !== null ? cachedRecord : await readLockRecord(paths, observedObjectId);
      cachedObjectId = observedObjectId;
      cachedRecord = observed;
      if (processStatus(observed.pid) !== "dead") {
        if (Date.now() - started >= timeoutMs) throw new StateLockError("timeout", `Timed out acquiring Guardian state lock at ${paths.lockRef}`, { guardianPath: paths.lockRef });
        await new Promise((resolve) => setTimeout(resolve, lockPollBackoffMs(pollAttempt)));
        pollAttempt += 1;
        continue;
      }
      generation = observed.generation + 1;
      reclaimed = true;
    }
    const record = { version: 1, pid: process.pid, nonce: crypto.randomUUID(), generation, acquired_at: new Date().toISOString() } satisfies LockRecord;
    const lease = await publishCandidate(paths, record, hooks);
    if (await cas(paths, lease.objectId, observedObjectId ?? nullObjectId)) {
      if (await currentLockObjectId(paths) !== lease.objectId) throw new StateLockError("ownership_lost", "Guardian lock acquisition verification failed");
      await (reclaimed ? hooks.afterCasReclaimed?.(lease) : hooks.afterCasAcquired?.(lease));
      return { lease, nullObjectId };
    }
    cachedObjectId = null;
    cachedRecord = null;
    if (Date.now() - started >= timeoutMs) throw new StateLockError("timeout", `Timed out acquiring Guardian state lock at ${paths.lockRef}`, { guardianPath: paths.lockRef });
    await new Promise((resolve) => setTimeout(resolve, lockPollBackoffMs(pollAttempt)));
    pollAttempt += 1;
  }
}

async function release(paths: GuardianPaths, lease: LockLease, nullObjectId: string, hooks: StateLockHooks): Promise<void> {
  const tombstone = { version: 1, old_oid: lease.objectId, record: lease.record } satisfies LockTombstone;
  const tombstonePath = path.join(paths.lockTombstonesDir, `release-${lease.record.nonce}-${lease.record.generation}.json`);
  await writeDurableCreate(tombstonePath, paths.lockTmpDir, `${JSON.stringify(tombstone)}\n`);
  await hooks.afterTombstoneSynced?.(tombstone);
  if (!await cas(paths, nullObjectId, lease.objectId)) {
    if (await currentLockObjectId(paths) !== lease.objectId) await removeDurable(tombstonePath);
    throw new StateLockError("ownership_lost", "Guardian state lock changed before release");
  }
  if (await currentLockObjectId(paths) !== null) throw new StateLockError("ownership_lost", "Guardian lock release verification failed");
  await hooks.afterCasReleased?.(lease);
  await removeDurable(tombstonePath);
}

export async function withStateLock<T>(paths: GuardianPaths, options: StateLockOptions, operation: () => Promise<T>): Promise<T> {
  if (activeTransaction.getStore() === true) throw new StateLockError("reentrant", "Guardian state transactions are non-reentrant", { guardianPath: paths.lockRef });
  const { lease, nullObjectId } = await acquire(paths, options);
  try {
    return await activeTransaction.run(true, operation);
  } finally {
    await release(paths, lease, nullObjectId, options.hooks ?? {});
  }
}
