import { constants, type Dir, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { compareCodeUnits } from "./code-unit-order.ts";
import { isSameOrInside } from "./filesystem-boundaries.ts";
import { liveFileDescriptors } from "./live-file-descriptors.ts";

export const PROTECTED_INVENTORY_MAX_ROOTS = 128;
export const PROTECTED_INVENTORY_MAX_ENTRIES_PER_ROOT = 10_000;
const MAX_ENTRIES_TOTAL = 100_000;
const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

export type ProtectedInventorySeed = {
  readonly path: string;
  readonly reason: string;
};

export type ProtectedInventoryEntry = ProtectedInventorySeed & {
  readonly assessment: "not-assessed";
  readonly cleanupAuthorized: false;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly bytes: number;
  readonly bytesTruncated: boolean;
};

export type ProtectedInventorySummary = {
  readonly rootCount: number;
  readonly rootsTruncated: boolean;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly totalBytes: number;
  readonly bytesTruncated: boolean;
  readonly assessment: "not-assessed";
  readonly cleanupAuthorized: false;
};

type ProtectedInventoryIo = {
  readonly lstat: (candidate: string) => Promise<Stats>;
  readonly realpath: (candidate: string) => Promise<string>;
  readonly open: (candidate: string, flags: number) => Promise<FileHandle>;
  readonly opendir: (candidate: string) => Promise<Dir>;
};

type ProtectedInventoryOptions = {
  readonly rootsTruncated?: boolean;
  readonly io?: ProtectedInventoryIo;
};

const DEFAULT_IO: ProtectedInventoryIo = {
  lstat: fs.lstat,
  realpath: fs.realpath,
  open: fs.open,
  opendir: fs.opendir,
};

export const EMPTY_PROTECTED_INVENTORY: ProtectedInventorySummary = {
  rootCount: 0,
  rootsTruncated: false,
  fileCount: 0,
  directoryCount: 0,
  totalBytes: 0,
  bytesTruncated: false,
  assessment: "not-assessed",
  cleanupAuthorized: false,
};

function sameDirectoryNode(left: Stats, right: Stats): boolean {
  return left.isDirectory() && right.isDirectory() && left.dev === right.dev && left.ino === right.ino;
}

function sameDirectory(left: Stats, right: Stats): boolean {
  return sameDirectoryNode(left, right) && left.ctimeMs === right.ctimeMs;
}

function directoryDescriptorCount(descriptors: Awaited<ReturnType<typeof liveFileDescriptors>>, expected: Stats): number {
  return descriptors.filter((descriptor) => sameDirectoryNode(descriptor.stat, expected)).length;
}

function totalDirectoryDescriptorCount(descriptors: Awaited<ReturnType<typeof liveFileDescriptors>>): number {
  return descriptors.filter((descriptor) => descriptor.stat.isDirectory()).length;
}

async function assertDirectoryIdentity(io: ProtectedInventoryIo, candidate: string, expected: Stats): Promise<void> {
  const current = await io.lstat(candidate);
  if (!sameDirectory(current, expected)) throw new Error(`Protected inventory directory identity changed during scan: ${candidate}`);
}

async function boundedChildNames(io: ProtectedInventoryIo, candidate: string, expected: Stats, limit: number): Promise<{ readonly names: readonly string[]; readonly truncated: boolean }> {
  const descriptorsBefore = await liveFileDescriptors();
  const guard = await io.open(candidate, DIRECTORY_OPEN_FLAGS);
  let directory: Dir | undefined;
  try {
    const guarded = await guard.stat();
    if (!sameDirectory(guarded, expected)) throw new Error(`Protected inventory directory identity changed before scan: ${candidate}`);
    directory = await io.opendir(candidate);
    const descriptorsAfter = await liveFileDescriptors();
    if (totalDirectoryDescriptorCount(descriptorsAfter) !== totalDirectoryDescriptorCount(descriptorsBefore) + 2
      || directoryDescriptorCount(descriptorsAfter, guarded) !== directoryDescriptorCount(descriptorsBefore, expected) + 2) {
      throw new Error(`Protected inventory directory descriptor did not bind to the guarded path: ${candidate}`);
    }
    await assertDirectoryIdentity(io, candidate, guarded);
    const names: string[] = [];
    let complete = false;
    while (names.length < limit) {
      const entry = await directory.read();
      if (!entry) {
        complete = true;
        break;
      }
      names.push(entry.name);
    }
    if (!complete) complete = await directory.read() === null;
    await assertDirectoryIdentity(io, candidate, guarded);
    const guardedAfter = await guard.stat();
    if (!sameDirectory(guardedAfter, guarded)) throw new Error(`Protected inventory directory generation changed during scan: ${candidate}`);
    return { names: names.sort(compareCodeUnits), truncated: !complete };
  } finally {
    if (directory) await directory.close();
    await guard.close();
  }
}

export async function buildProtectedInventory(repoRoot: string, seeds: readonly ProtectedInventorySeed[], options: ProtectedInventoryOptions = {}): Promise<{
  readonly entries: readonly ProtectedInventoryEntry[];
  readonly summary: ProtectedInventorySummary;
}> {
  const io = options.io ?? DEFAULT_IO;
  const canonicalRepoRoot = await io.realpath(path.resolve(repoRoot));
  const repoStat = await io.lstat(canonicalRepoRoot);
  const orderedSeeds = [...seeds].sort((left, right) => compareCodeUnits(left.path, right.path));
  const collapsedSeeds: ProtectedInventorySeed[] = [];
  for (const seed of orderedSeeds) {
    const root = path.resolve(canonicalRepoRoot, seed.path);
    if (!isSameOrInside(root, canonicalRepoRoot)) throw new Error(`Protected inventory root escapes the repository: ${seed.path}`);
    if (!collapsedSeeds.some((existing) => isSameOrInside(root, path.resolve(canonicalRepoRoot, existing.path)))) collapsedSeeds.push(seed);
  }
  const selectedSeeds = collapsedSeeds.slice(0, PROTECTED_INVENTORY_MAX_ROOTS);
  const rootsTruncated = options.rootsTruncated === true || selectedSeeds.length < collapsedSeeds.length;
  let remainingEntries = MAX_ENTRIES_TOTAL;
  const entries: ProtectedInventoryEntry[] = [];
  for (const seed of selectedSeeds) {
    const root = path.resolve(canonicalRepoRoot, seed.path);
    const limit = Math.min(PROTECTED_INVENTORY_MAX_ENTRIES_PER_ROOT, remainingEntries);
    let visited = 0;
    let fileCount = 0;
    let directoryCount = 0;
    let bytes = 0;
    let bytesTruncated = false;
    async function visit(current: string): Promise<void> {
      if (visited >= limit) {
        bytesTruncated = true;
        return;
      }
      const stat = await io.lstat(current);
      visited += 1;
      if (stat.dev !== repoStat.dev) {
        if (stat.isDirectory()) directoryCount += 1;
        else fileCount += 1;
        bytesTruncated = true;
        return;
      }
      if (!stat.isDirectory()) {
        fileCount += 1;
        bytes += stat.size;
        return;
      }
      const canonicalCurrent = await io.realpath(current);
      if (canonicalCurrent !== path.resolve(current) || !isSameOrInside(canonicalCurrent, canonicalRepoRoot)) {
        throw new Error(`Protected inventory directory resolves outside its stable repository path: ${current}`);
      }
      directoryCount += 1;
      const children = await boundedChildNames(io, current, stat, Math.max(0, limit - visited));
      if (children.truncated) bytesTruncated = true;
      for (const child of children.names) {
        await visit(path.join(current, child));
        if (visited >= limit) break;
      }
      await assertDirectoryIdentity(io, current, stat);
    }
    await visit(root);
    remainingEntries = Math.max(0, remainingEntries - visited);
    entries.push({ ...seed, assessment: "not-assessed", cleanupAuthorized: false, fileCount, directoryCount, bytes, bytesTruncated });
  }
  return {
    entries,
    summary: {
      rootCount: entries.length,
      rootsTruncated,
      fileCount: entries.reduce((total, entry) => total + entry.fileCount, 0),
      directoryCount: entries.reduce((total, entry) => total + entry.directoryCount, 0),
      totalBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
      bytesTruncated: rootsTruncated || entries.some((entry) => entry.bytesTruncated),
      assessment: "not-assessed",
      cleanupAuthorized: false,
    },
  };
}
