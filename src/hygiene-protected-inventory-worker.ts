import fs from "node:fs";
import path from "node:path";
import { isSameOrInside } from "./filesystem-boundaries.ts";
import { WasiDirectoryReader, WASI_DIRECTORY_FILE_TYPE, type WasiFileStat } from "./hygiene-protected-wasi.ts";
import {
  PROTECTED_INVENTORY_MAX_ENTRIES_PER_ROOT,
  PROTECTED_INVENTORY_MAX_ENTRIES_TOTAL,
  protectedInventoryWorkerInputSchema,
  type ProtectedInventoryEntry,
  type ProtectedInventoryResult,
  type ProtectedInventorySeed,
  type ProtectedInventoryWorkerInput,
} from "./hygiene-protected-inventory-types.ts";

type PathBinding = {
  readonly parentFd: number;
  readonly name: string;
  readonly stat: WasiFileStat;
};

type OpenRoot = {
  readonly fd: number | null;
  readonly stat: WasiFileStat;
  readonly bindings: readonly PathBinding[];
  readonly ownedFds: readonly number[];
};

function sameNode(left: WasiFileStat, right: WasiFileStat): boolean {
  return left.device === right.device && left.inode === right.inode && left.fileType === right.fileType;
}

function sameGeneration(left: WasiFileStat, right: WasiFileStat): boolean {
  return sameNode(left, right) && left.size === right.size && left.modifiedNs === right.modifiedNs && left.changedNs === right.changedNs;
}

function assertSameNode(left: WasiFileStat, right: WasiFileStat, label: string): void {
  if (!sameNode(left, right)) throw new Error(`Protected inventory identity changed: ${label}`);
}

function assertSameGeneration(left: WasiFileStat, right: WasiFileStat, label: string): void {
  if (!sameGeneration(left, right)) throw new Error(`Protected inventory generation changed: ${label}`);
}

function openRoot(reader: WasiDirectoryReader, repoRoot: string, seed: ProtectedInventorySeed): OpenRoot {
  const root = path.resolve(repoRoot, seed.path);
  if (!isSameOrInside(root, repoRoot)) throw new Error(`Protected inventory root escapes the repository: ${seed.path}`);
  const relative = path.relative(repoRoot, root);
  const components = relative === "" ? [] : relative.split(path.sep);
  if (components.length === 0) return { fd: reader.rootFd(), stat: reader.stat(reader.rootFd()), bindings: [], ownedFds: [] };

  let parentFd = reader.rootFd();
  const bindings: PathBinding[] = [];
  const ownedFds: number[] = [];
  for (let index = 0; index < components.length; index += 1) {
    const name = components[index];
    if (!name) throw new Error(`Protected inventory path contains an empty component: ${seed.path}`);
    const stat = reader.statAt(parentFd, name);
    const isLast = index === components.length - 1;
    if (stat.fileType !== WASI_DIRECTORY_FILE_TYPE) {
      if (!isLast) throw new Error(`Protected inventory path crosses a non-directory component: ${seed.path}`);
      bindings.push({ parentFd, name, stat });
      return { fd: null, stat, bindings, ownedFds };
    }
    const fd = reader.openDirectoryAt(parentFd, name);
    try {
      assertSameNode(reader.stat(fd), stat, seed.path);
    } catch (error) {
      reader.close(fd);
      throw error;
    }
    bindings.push({ parentFd, name, stat });
    ownedFds.push(fd);
    parentFd = fd;
  }
  return { fd: parentFd, stat: reader.stat(parentFd), bindings, ownedFds };
}

function validateBindings(reader: WasiDirectoryReader, bindings: readonly PathBinding[], label: string): void {
  for (const binding of bindings) assertSameNode(reader.statAt(binding.parentFd, binding.name), binding.stat, label);
}

function scanRoot(input: {
  reader: WasiDirectoryReader;
  repoRoot: string;
  repoDevice: bigint;
  seed: ProtectedInventorySeed;
  limit: number;
}): ProtectedInventoryEntry {
  const { reader, repoRoot, repoDevice, seed, limit } = input;
  const opened = openRoot(reader, repoRoot, seed);
  let visited = 0;
  let fileCount = 0;
  let directoryCount = 0;
  let bytes = 0;
  let bytesTruncated = false;

  function countLeaf(parentFd: number, name: string, stat: WasiFileStat): void {
    fileCount += 1;
    bytes += stat.size;
    assertSameGeneration(reader.statAt(parentFd, name), stat, `${seed.path}/${name}`);
  }

  function scanDirectory(fd: number, stat: WasiFileStat): void {
    directoryCount += 1;
    if (stat.device !== repoDevice) {
      bytesTruncated = true;
      return;
    }
    const before = reader.stat(fd);
    assertSameGeneration(before, stat, seed.path);
    const childLimit = Math.max(0, limit - visited);
    const listing = reader.readDirectory(fd, childLimit);
    if (listing.truncated) {
      bytesTruncated = true;
      const repeated = reader.readDirectory(fd, childLimit);
      if (!reader.sameListing(listing, repeated)) throw new Error(`Protected inventory directory changed during enumeration: ${seed.path}`);
      assertSameGeneration(reader.stat(fd), before, seed.path);
      return;
    }
    for (const child of listing.entries) {
      if (visited >= limit) {
        bytesTruncated = true;
        break;
      }
      const childStat = reader.statAt(fd, child.name);
      if (child.inode !== 0n && child.inode !== childStat.inode) throw new Error(`Protected inventory entry identity changed: ${seed.path}/${child.name}`);
      visited += 1;
      if (childStat.fileType !== WASI_DIRECTORY_FILE_TYPE) {
        countLeaf(fd, child.name, childStat);
        continue;
      }
      if (childStat.device !== repoDevice) {
        directoryCount += 1;
        bytesTruncated = true;
        continue;
      }
      const childFd = reader.openDirectoryAt(fd, child.name);
      try {
        const openedStat = reader.stat(childFd);
        assertSameNode(openedStat, childStat, `${seed.path}/${child.name}`);
        scanDirectory(childFd, openedStat);
        assertSameNode(reader.statAt(fd, child.name), openedStat, `${seed.path}/${child.name}`);
      } finally {
        reader.close(childFd);
      }
    }
    const repeated = reader.readDirectory(fd, childLimit);
    if (!reader.sameListing(listing, repeated)) throw new Error(`Protected inventory directory changed during enumeration: ${seed.path}`);
    assertSameGeneration(reader.stat(fd), before, seed.path);
  }

  try {
    if (limit === 0) {
      bytesTruncated = true;
    } else {
      visited = 1;
      if (opened.fd === null) {
        const binding = opened.bindings.at(-1);
        if (!binding) throw new Error(`Protected inventory leaf binding is missing: ${seed.path}`);
        countLeaf(binding.parentFd, binding.name, opened.stat);
      } else {
        scanDirectory(opened.fd, opened.stat);
      }
      validateBindings(reader, opened.bindings, seed.path);
    }
  } finally {
    for (const fd of [...opened.ownedFds].reverse()) reader.close(fd);
  }
  return { ...seed, assessment: "not-assessed", cleanupAuthorized: false, fileCount, directoryCount, bytes, bytesTruncated };
}

function scanProtectedInventory(input: ProtectedInventoryWorkerInput): ProtectedInventoryResult {
  const canonicalRepoRoot = fs.realpathSync.native(path.resolve(input.repoRoot));
  if (canonicalRepoRoot !== input.repoRoot) throw new Error("Protected inventory worker repository path is not canonical");
  const repoPathStat = fs.lstatSync(canonicalRepoRoot);
  const inheritedRepoStat = fs.fstatSync(3);
  const expectedDevice = BigInt(input.repoDevice);
  const expectedInode = BigInt(input.repoInode);
  if (!repoPathStat.isDirectory() || !inheritedRepoStat.isDirectory() || BigInt(inheritedRepoStat.dev) !== expectedDevice || BigInt(inheritedRepoStat.ino) !== expectedInode) {
    throw new Error("Protected inventory inherited repository identity is invalid");
  }
  const reader = new WasiDirectoryReader(canonicalRepoRoot);
  const repoStat = reader.stat(reader.rootFd());
  if (repoStat.device !== expectedDevice || repoStat.inode !== expectedInode || repoStat.device !== BigInt(repoPathStat.dev) || repoStat.inode !== BigInt(repoPathStat.ino)) {
    throw new Error("Protected inventory preopen did not bind to the inherited repository root");
  }
  let remainingEntries = PROTECTED_INVENTORY_MAX_ENTRIES_TOTAL;
  const entries = input.seeds.map((seed) => {
    const limit = Math.min(PROTECTED_INVENTORY_MAX_ENTRIES_PER_ROOT, remainingEntries);
    const entry = scanRoot({ reader, repoRoot: canonicalRepoRoot, repoDevice: repoStat.device, seed, limit });
    const consumedBudget = entry.bytesTruncated ? limit : entry.fileCount + entry.directoryCount;
    remainingEntries = Math.max(0, remainingEntries - consumedBudget);
    return entry;
  });
  const repoAfter = fs.lstatSync(canonicalRepoRoot);
  const inheritedRepoAfter = fs.fstatSync(3);
  if (repoStat.device !== BigInt(repoAfter.dev) || repoStat.inode !== BigInt(repoAfter.ino) || repoStat.device !== BigInt(inheritedRepoAfter.dev) || repoStat.inode !== BigInt(inheritedRepoAfter.ino)) {
    throw new Error("Protected inventory repository root changed during scan");
  }
  return {
    entries,
    summary: {
      rootCount: entries.length,
      rootsTruncated: input.rootsTruncated,
      fileCount: entries.reduce((total, entry) => total + entry.fileCount, 0),
      directoryCount: entries.reduce((total, entry) => total + entry.directoryCount, 0),
      totalBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
      bytesTruncated: input.rootsTruncated || input.coverageIncomplete || entries.some((entry) => entry.bytesTruncated),
      assessment: "not-assessed",
      cleanupAuthorized: false,
    },
  };
}

const rawInput: unknown = JSON.parse(fs.readFileSync(0, "utf8"));
const input = protectedInventoryWorkerInputSchema.parse(rawInput);
process.stdout.write(JSON.stringify(scanProtectedInventory(input)));
