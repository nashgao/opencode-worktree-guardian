import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { getGuardianPaths, readState, updateState, withStateTransaction } from "../src/state.ts";
import { createRepo, createTempDir, git } from "./helpers.ts";

const stateModuleUrl = new URL("../src/state.ts", import.meta.url).href;
const configModuleUrl = new URL("../src/config.ts", import.meta.url).href;
const lockRef = "refs/opencode-guardian/locks/state";

type LockRecordFixture = {
  readonly version: 1;
  readonly pid: number;
  readonly nonce: string;
  readonly generation: number;
  readonly acquired_at: string;
};

async function waitForLine(child: ReturnType<typeof spawn>, expected: string): Promise<void> {
  if (child.stdout === null) throw new TypeError("child stdout must be piped");
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  return new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const onData = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes(expected)) finish(resolve);
    };
    const onStderr = (chunk: Buffer) => { stderr += chunk.toString("utf8"); };
    const onExit = () => finish(() => reject(new Error(`child exited before writing ${expected}: ${stderr}`)));
    const finish = (complete: () => void) => {
      stdoutStream.off("data", onData);
      stderrStream?.off("data", onStderr);
      child.off("exit", onExit);
      complete();
    };
    stdoutStream.on("data", onData);
    stderrStream?.on("data", onStderr);
    child.on("exit", onExit);
  });
}

async function runFaultingChild(repo: string, hookName: string): Promise<void> {
  const childScript = `
    import { getGuardianPaths, withStateTransaction } from ${JSON.stringify(stateModuleUrl)};
    const paths = await getGuardianPaths(${JSON.stringify(repo)});
    await withStateTransaction(paths, async () => {}, {
      hooks: { [${JSON.stringify(hookName)}]: async () => process.kill(process.pid, "SIGKILL") },
    });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [, signal] = await once(child, "exit");
  assert.equal(signal, "SIGKILL");
}

async function lockObjectId(repo: string): Promise<string | null> {
  const result = await git(repo, ["for-each-ref", "--format=%(objectname)", lockRef]);
  return result.stdout || null;
}

async function writeBlob(repo: string, value: unknown): Promise<string> {
  const fixturePath = path.join(repo, `.lock-fixture-${crypto.randomUUID()}.json`);
  await fs.writeFile(fixturePath, `${JSON.stringify(value)}\n`, "utf8");
  try {
    return (await git(repo, ["hash-object", "-w", fixturePath])).stdout;
  } finally {
    await fs.rm(fixturePath);
  }
}

function lockRecord(pid: number, generation = 1): LockRecordFixture {
  return { version: 1, pid, nonce: crypto.randomUUID(), generation, acquired_at: new Date().toISOString() };
}

async function installLock(repo: string, record: unknown): Promise<string> {
  const objectId = await writeBlob(repo, record);
  await git(repo, ["update-ref", "--no-deref", lockRef, objectId]);
  return objectId;
}

async function readLockRecord(repo: string, objectId: string): Promise<LockRecordFixture> {
  const value: unknown = JSON.parse((await git(repo, ["cat-file", "blob", objectId])).stdout);
  if (typeof value !== "object" || value === null || !("version" in value) || !("pid" in value) || !("nonce" in value) || !("generation" in value) || !("acquired_at" in value)) {
    throw new TypeError("lock blob must contain the complete lock record");
  }
  if (value.version !== 1 || typeof value.pid !== "number" || typeof value.nonce !== "string" || typeof value.generation !== "number" || typeof value.acquired_at !== "string") {
    throw new TypeError("lock blob fields must have the expected types");
  }
  return { version: value.version, pid: value.pid, nonce: value.nonce, generation: value.generation, acquired_at: value.acquired_at };
}

async function completeTransaction(repo: string): Promise<void> {
  const paths = await getGuardianPaths(repo);
  await withStateTransaction(paths, async () => {});
  assert.equal(await lockObjectId(repo), null);
  assert.deepEqual(await fs.readdir(paths.lockTmpDir), []);
  assert.deepEqual(await fs.readdir(paths.lockTombstonesDir), []);
}

test("Given a lock owner killed during a state transaction, when another process updates state, then the dead generation is reclaimed", async () => {
  const repo = await createRepo();
  const childScript = `
    import { updateState } from ${JSON.stringify(stateModuleUrl)};
    import { DEFAULT_CONFIG } from ${JSON.stringify(configModuleUrl)};
    await updateState(${JSON.stringify(repo)}, DEFAULT_CONFIG, async (state) => {
      process.stdout.write("locked\\n");
      await new Promise(() => {});
      return state;
    });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  await waitForLine(child, "locked");
  assert.equal(child.kill("SIGKILL"), true);
  await once(child, "exit");

  await updateState(repo, { ...DEFAULT_CONFIG, lockTimeoutMs: 200 }, (state) => {
    state.reclaimed_after_crash = true;
    return state;
  });

  const state = await readState(await getGuardianPaths(repo), { repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(state.reclaimed_after_crash, true);
});

test("Given a process killed after syncing hash input, when the next transaction starts, then dead temporary input is removed", async () => {
  const repo = await createRepo();
  await runFaultingChild(repo, "afterHashInputSynced");
  const paths = await getGuardianPaths(repo);
  assert.equal((await fs.readdir(paths.lockTmpDir)).length, 1);
  await completeTransaction(repo);
});

test("Given a process killed after blob publication, when the next transaction starts, then the orphan input is removed and no ref is guessed", async () => {
  const repo = await createRepo();
  await runFaultingChild(repo, "afterBlobPublished");
  assert.equal(await lockObjectId(repo), null);
  await completeTransaction(repo);
});

test("Given a process killed after acquire CAS, when the next transaction starts, then the exact dead generation is replaced and released", async () => {
  const repo = await createRepo();
  await runFaultingChild(repo, "afterCasAcquired");
  const deadObjectId = await lockObjectId(repo);
  if (deadObjectId === null) throw new TypeError("crashed owner must leave an authoritative lock blob");
  const record = await readLockRecord(repo, deadObjectId);
  assert.equal(record.version, 1);
  assert.equal(record.generation, 1);
  assert.equal(record.pid > 0, true);
  assert.equal(record.nonce.length > 0, true);
  assert.equal(Number.isNaN(Date.parse(record.acquired_at)), false);
  await completeTransaction(repo);
});

test("Given a process killed after reclaim CAS, when another process starts, then only the newly dead generation is reclaimed", async () => {
  const repo = await createRepo();
  await runFaultingChild(repo, "afterCasAcquired");
  const firstObjectId = await lockObjectId(repo);
  await runFaultingChild(repo, "afterCasReclaimed");
  const secondObjectId = await lockObjectId(repo);
  assert.notEqual(secondObjectId, firstObjectId);
  if (secondObjectId === null) throw new TypeError("reclaimer crash must leave an authoritative lock blob");
  assert.equal((await readLockRecord(repo, secondObjectId)).generation, 2);
  await completeTransaction(repo);
});

test("Given a process killed after writing its release tombstone, when the next process starts, then the dead authoritative generation is CAS-released", async () => {
  const repo = await createRepo();
  await runFaultingChild(repo, "afterTombstoneSynced");
  const paths = await getGuardianPaths(repo);
  assert.equal((await fs.readdir(paths.lockTombstonesDir)).length, 1);
  assert.equal(typeof await lockObjectId(repo), "string");
  await completeTransaction(repo);
});

test("Given a process killed after release CAS, when the next process starts, then the non-authoritative tombstone is removed", async () => {
  const repo = await createRepo();
  await runFaultingChild(repo, "afterCasReleased");
  const paths = await getGuardianPaths(repo);
  assert.equal(await lockObjectId(repo), null);
  assert.equal((await fs.readdir(paths.lockTombstonesDir)).length, 1);
  await completeTransaction(repo);
});

test("Given a live authoritative lock, when a contender times out, then the ref remains unchanged", async () => {
  const repo = await createRepo();
  const objectId = await installLock(repo, lockRecord(process.pid));
  const paths = await getGuardianPaths(repo);
  await assert.rejects(() => withStateTransaction(paths, async () => {}, { timeoutMs: 75 }), /Timed out acquiring/);
  assert.equal(await lockObjectId(repo), objectId);
});

test("Given malformed authoritative lock metadata, when a contender starts, then acquisition blocks without changing the ref", async () => {
  const repo = await createRepo();
  const objectId = await installLock(repo, { version: 1, pid: "not-a-pid" });
  const paths = await getGuardianPaths(repo);
  await assert.rejects(() => withStateTransaction(paths, async () => {}), /malformed metadata/);
  assert.equal(await lockObjectId(repo), objectId);
});

test("Given a symbolic authoritative lock ref, when a contender starts, then acquisition blocks without dereferencing it", async () => {
  const repo = await createRepo();
  await git(repo, ["symbolic-ref", lockRef, "refs/heads/main"]);
  const paths = await getGuardianPaths(repo);
  await assert.rejects(() => withStateTransaction(paths, async () => {}), /symbolic/);
  assert.equal((await git(repo, ["symbolic-ref", lockRef])).stdout, "refs/heads/main");
});

test("Given a malformed release tombstone, when a contender starts, then acquisition blocks without deleting it", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  await fs.mkdir(paths.lockTombstonesDir, { recursive: true });
  const tombstonePath = path.join(paths.lockTombstonesDir, "release-malformed-1.json");
  await fs.writeFile(tombstonePath, "{}\n", "utf8");
  await assert.rejects(() => withStateTransaction(paths, async () => {}), /Malformed Guardian lock tombstone/);
  assert.equal(await fs.readFile(tombstonePath, "utf8"), "{}\n");
});

test("Given a valid tombstone whose old OID is no longer authoritative, when a contender starts, then only the stale tombstone is removed", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  const record = lockRecord(999_999_999);
  const oldObjectId = await writeBlob(repo, record);
  await fs.mkdir(paths.lockTombstonesDir, { recursive: true });
  const tombstonePath = path.join(paths.lockTombstonesDir, `release-${record.nonce}-${record.generation}.json`);
  await fs.writeFile(tombstonePath, `${JSON.stringify({ version: 1, old_oid: oldObjectId, record })}\n`, "utf8");
  await completeTransaction(repo);
  await assert.rejects(fs.access(tombstonePath));
});

test("Given lock ownership is replaced before release, when the holder exits, then release refuses to delete the competing generation", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  const competing = lockRecord(process.pid, 99);
  const competingObjectId = await writeBlob(repo, competing);
  await assert.rejects(() => withStateTransaction(paths, async () => {
    const heldObjectId = await lockObjectId(repo);
    if (heldObjectId === null) throw new Error("fixture expected an authoritative lock");
    await git(repo, ["update-ref", "--no-deref", lockRef, competingObjectId, heldObjectId]);
  }), /changed before release/);
  assert.equal(await lockObjectId(repo), competingObjectId);
});

test("Given two contenders publish replacements for the same dead generation, when both CAS, then exactly one transaction owns the ref", async () => {
  const repo = await createRepo();
  await installLock(repo, lockRecord(999_999_999));
  const paths = await getGuardianPaths(repo);
  let publishedCount = 0;
  let releasePublished: (() => void) | undefined;
  const publishedGate = new Promise<void>((resolve) => { releasePublished = resolve; });
  let releaseOwner: (() => void) | undefined;
  const ownerGate = new Promise<void>((resolve) => { releaseOwner = resolve; });
  let ownerIndex = -1;
  let ownerReady: ((index: number) => void) | undefined;
  const acquired = new Promise<number>((resolve) => { ownerReady = resolve; });
  const contender = (index: number) => withStateTransaction(paths, async () => {
    ownerIndex = index;
    ownerReady?.(index);
    await ownerGate;
  }, {
    timeoutMs: 150,
    hooks: {
      afterBlobPublished: async () => {
        publishedCount += 1;
        if (publishedCount === 2) releasePublished?.();
        await publishedGate;
      },
    },
  });
  const contenders = [contender(0), contender(1)] as const;

  await acquired;
  const losingIndex = ownerIndex === 0 ? 1 : 0;
  await assert.rejects(contenders[losingIndex], /Timed out acquiring/);
  releaseOwner?.();
  await contenders[ownerIndex === 0 ? 0 : 1];

  assert.equal(publishedCount, 2);
  assert.equal(await lockObjectId(repo), null);
});

test("Given two child processes race the same dead generation, when their publication barriers open, then only the CAS winner becomes authoritative", async () => {
  const repo = await createRepo();
  await installLock(repo, lockRecord(999_999_999));
  const childScript = `
    import { getGuardianPaths, withStateTransaction } from ${JSON.stringify(stateModuleUrl)};
    const paths = await getGuardianPaths(${JSON.stringify(repo)});
    await withStateTransaction(paths, async () => {
      process.stdout.write("owned\\n");
      await new Promise(() => {});
    }, {
      timeoutMs: 1000,
      hooks: { afterBlobPublished: async () => {
        process.stdout.write("published\\n");
        await new Promise((resolve) => process.stdin.once("data", resolve));
      } },
    });
  `;
  const spawnContender = () => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const contenders = [spawnContender(), spawnContender()] as const;
  const exits = [once(contenders[0], "exit"), once(contenders[1], "exit")] as const;
  await Promise.all(contenders.map((child) => waitForLine(child, "published")));
  const ownerWaits = contenders.map((child, index) => waitForLine(child, "owned").then(() => index));
  for (const child of contenders) child.stdin?.write("go\n");
  const winnerIndex = await Promise.any(ownerWaits);
  const loserIndex = winnerIndex === 0 ? 1 : 0;
  const [loserCode, loserSignal] = await exits[loserIndex];
  assert.notEqual(loserCode, 0);
  assert.equal(loserSignal, null);
  const winnerPid = contenders[winnerIndex].pid;
  if (winnerPid === undefined) throw new TypeError("winning child must have a PID");
  const authoritativeObjectId = await lockObjectId(repo);
  if (authoritativeObjectId === null) throw new TypeError("winning child must own the authoritative ref");
  assert.equal((await readLockRecord(repo, authoritativeObjectId)).pid, winnerPid);
  assert.equal(contenders[winnerIndex].kill("SIGKILL"), true);
  await exits[winnerIndex];
  await completeTransaction(repo);
});

test("Given an indeterminate PID owner, when a contender starts, then it never reclaims the authoritative generation", async (t) => {
  try {
    process.kill(1, 0);
    t.skip("PID 1 is signal-visible in this environment");
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EPERM")) {
      t.skip("environment does not expose an EPERM PID probe");
      return;
    }
  }
  const repo = await createRepo();
  const objectId = await installLock(repo, lockRecord(1));
  const paths = await getGuardianPaths(repo);
  await assert.rejects(() => withStateTransaction(paths, async () => {}, { timeoutMs: 75 }), /Timed out acquiring/);
  assert.equal(await lockObjectId(repo), objectId);
});

test("Given a live authoritative tombstone, when a contender starts, then it blocks without releasing or removing metadata", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  const record = lockRecord(process.pid);
  const oldObjectId = await installLock(repo, record);
  await fs.mkdir(paths.lockTombstonesDir, { recursive: true });
  const tombstonePath = path.join(paths.lockTombstonesDir, `release-${record.nonce}-${record.generation}.json`);
  await fs.writeFile(tombstonePath, `${JSON.stringify({ version: 1, old_oid: oldObjectId, record })}\n`, "utf8");
  await assert.rejects(() => withStateTransaction(paths, async () => {}), /not definitively dead/);
  assert.equal(await lockObjectId(repo), oldObjectId);
  assert.equal((await fs.readFile(tombstonePath, "utf8")).length > 0, true);
});

test("Given an indeterminate authoritative tombstone, when a contender starts, then it blocks without reclaiming the generation", async (t) => {
  try {
    process.kill(1, 0);
    t.skip("PID 1 is signal-visible in this environment");
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EPERM")) {
      t.skip("environment does not expose an EPERM PID probe");
      return;
    }
  }
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  const record = lockRecord(1);
  const oldObjectId = await installLock(repo, record);
  await fs.mkdir(paths.lockTombstonesDir, { recursive: true });
  const tombstonePath = path.join(paths.lockTombstonesDir, `release-${record.nonce}-${record.generation}.json`);
  await fs.writeFile(tombstonePath, `${JSON.stringify({ version: 1, old_oid: oldObjectId, record })}\n`, "utf8");
  await assert.rejects(() => withStateTransaction(paths, async () => {}), /not definitively dead/);
  assert.equal(await lockObjectId(repo), oldObjectId);
  assert.equal((await fs.readFile(tombstonePath, "utf8")).length > 0, true);
});

test("Given symlink tombstone metadata, when a contender starts, then acquisition blocks without following it", { skip: process.platform === "win32" }, async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  await fs.mkdir(paths.lockTombstonesDir, { recursive: true });
  const target = path.join(paths.dir, "outside-tombstone.json");
  const symlink = path.join(paths.lockTombstonesDir, "release-symlink-1.json");
  await fs.writeFile(target, "{}\n", "utf8");
  await fs.symlink(target, symlink);
  await assert.rejects(() => withStateTransaction(paths, async () => {}), /Malformed Guardian lock tombstone/);
  assert.equal(await fs.readFile(target, "utf8"), "{}\n");
});

test("Given legacy path lock metadata, when a contender starts, then Git-ref acquisition blocks without altering the path", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(paths.lockPath, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
  await assert.rejects(() => withStateTransaction(paths, async () => {}), /Legacy Guardian path lock blocks/);
  assert.equal(await lockObjectId(repo), null);
  assert.equal((await fs.readFile(paths.lockPath, "utf8")).length > 0, true);
});

test("Given a SHA-256 repository, when a transaction acquires and releases, then CAS uses the repository object width", async () => {
  const repo = await createTempDir("guardian-sha256-");
  await git(repo, ["init", "--object-format=sha256", "-b", "main", "."]);
  let acquiredObjectId = "";
  await withStateTransaction(await getGuardianPaths(repo), async () => {}, {
    hooks: { afterCasAcquired: async (lease) => { acquiredObjectId = lease.objectId; } },
  });
  assert.equal(acquiredObjectId.length, 64);
  assert.equal(await lockObjectId(repo), null);
});

test("Given a crash immediately after a durable state replacement, when the process dies, then the synced state remains readable", async () => {
  const repo = await createRepo();
  const childScript = `
    import { createEmptyState, getGuardianPaths, withStateTransaction, writeStateAtomic } from ${JSON.stringify(stateModuleUrl)};
    import { DEFAULT_CONFIG } from ${JSON.stringify(configModuleUrl)};
    const paths = await getGuardianPaths(${JSON.stringify(repo)});
    await withStateTransaction(paths, async () => {
      const state = createEmptyState({ repoRoot: ${JSON.stringify(repo)}, config: DEFAULT_CONFIG });
      state.durable_before_crash = true;
      await writeStateAtomic(paths, state);
      process.kill(process.pid, "SIGKILL");
    });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  const [, signal] = await once(child, "exit");
  assert.equal(signal, "SIGKILL");
  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(state.durable_before_crash, true);
  await completeTransaction(repo);
});

test("Given a delegated real Git executable, when lock commands run, then every blob publication and CAS carries command-local fsync policy", async () => {
  const repo = await createRepo();
  const tools = path.join(repo, "git-tools");
  const logPath = path.join(repo, "git-args.log");
  await fs.mkdir(tools);
  await fs.writeFile(path.join(tools, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$GUARDIAN_GIT_LOG"\nexec "$GUARDIAN_REAL_GIT" "$@"\n`, "utf8");
  await fs.chmod(path.join(tools, "git"), 0o755);
  const childScript = `
    import { getGuardianPaths, withStateTransaction } from ${JSON.stringify(stateModuleUrl)};
    await withStateTransaction(await getGuardianPaths(${JSON.stringify(repo)}), async () => {});
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: `${tools}${path.delimiter}${process.env.PATH ?? ""}`, GUARDIAN_GIT_LOG: logPath, GUARDIAN_REAL_GIT: "/usr/bin/git" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  const relevant = (await fs.readFile(logPath, "utf8")).trim().split("\n").filter((line) => line.includes("hash-object") || line.includes("update-ref"));
  assert.equal(relevant.length >= 4, true);
  for (const line of relevant) assert.match(line, /-c core\.fsync=all -c core\.fsyncMethod=fsync (?:hash-object|update-ref)/);
});

test("Given lock lifecycle hooks, when one transaction completes, then synced files, verified blobs, CAS, and parent-synced cleanup occur in order", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  const observed: string[] = [];
  await withStateTransaction(paths, async () => { observed.push("operation"); }, {
    hooks: {
      afterHashInputSynced: async () => {
        assert.equal((await fs.readdir(paths.lockTmpDir)).some((name) => name.startsWith("lock-")), true);
        observed.push("hash-input");
      },
      afterBlobPublished: async (lease) => {
        assert.equal((await git(repo, ["cat-file", "-t", lease.objectId])).stdout, "blob");
        observed.push("blob");
      },
      afterTempRemoved: async () => {
        assert.deepEqual(await fs.readdir(paths.lockTmpDir), []);
        observed.push("temp-removed");
      },
      afterCasAcquired: async (lease) => {
        assert.equal(await lockObjectId(repo), lease.objectId);
        observed.push("cas-acquire");
      },
      afterTombstoneSynced: async () => {
        assert.equal((await fs.readdir(paths.lockTombstonesDir)).length, 1);
        const authoritativeObjectId = await lockObjectId(repo);
        assert.equal(typeof authoritativeObjectId, "string");
        observed.push("tombstone");
      },
      afterCasReleased: async () => {
        assert.equal(await lockObjectId(repo), null);
        assert.equal((await fs.readdir(paths.lockTombstonesDir)).length, 1);
        observed.push("cas-release");
      },
    },
  });
  assert.deepEqual(observed, ["hash-input", "blob", "temp-removed", "cas-acquire", "operation", "tombstone", "cas-release"]);
  assert.deepEqual(await fs.readdir(paths.lockTombstonesDir), []);
});
