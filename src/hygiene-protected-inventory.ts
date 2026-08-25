import fs from "node:fs/promises";
import path from "node:path";
import { compareCodeUnits } from "./code-unit-order.ts";

const MAX_ENTRIES_PER_ROOT = 10_000;
const MAX_ENTRIES_TOTAL = 100_000;

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
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly totalBytes: number;
  readonly bytesTruncated: boolean;
  readonly assessment: "not-assessed";
  readonly cleanupAuthorized: false;
};

export const EMPTY_PROTECTED_INVENTORY: ProtectedInventorySummary = {
  rootCount: 0,
  fileCount: 0,
  directoryCount: 0,
  totalBytes: 0,
  bytesTruncated: false,
  assessment: "not-assessed",
  cleanupAuthorized: false,
};

export async function buildProtectedInventory(repoRoot: string, seeds: readonly ProtectedInventorySeed[]): Promise<{
  readonly entries: readonly ProtectedInventoryEntry[];
  readonly summary: ProtectedInventorySummary;
}> {
  let remainingEntries = MAX_ENTRIES_TOTAL;
  const entries: ProtectedInventoryEntry[] = [];
  const orderedSeeds = [...seeds].sort((left, right) => compareCodeUnits(left.path, right.path));
  for (const seed of orderedSeeds) {
    const limit = Math.min(MAX_ENTRIES_PER_ROOT, remainingEntries);
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
      visited += 1;
      const stat = await fs.lstat(current);
      if (!stat.isDirectory()) {
        fileCount += 1;
        bytes += stat.size;
        return;
      }
      directoryCount += 1;
      const children = (await fs.readdir(current)).sort(compareCodeUnits);
      for (const child of children) {
        await visit(path.join(current, child));
        if (bytesTruncated) break;
      }
    }
    await visit(path.resolve(repoRoot, seed.path));
    remainingEntries = Math.max(0, remainingEntries - visited);
    entries.push({ ...seed, assessment: "not-assessed", cleanupAuthorized: false, fileCount, directoryCount, bytes, bytesTruncated });
  }
  return {
    entries,
    summary: {
      rootCount: entries.length,
      fileCount: entries.reduce((total, entry) => total + entry.fileCount, 0),
      directoryCount: entries.reduce((total, entry) => total + entry.directoryCount, 0),
      totalBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
      bytesTruncated: entries.some((entry) => entry.bytesTruncated),
      assessment: "not-assessed",
      cleanupAuthorized: false,
    },
  };
}
