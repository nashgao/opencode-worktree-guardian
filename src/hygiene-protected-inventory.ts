import fs from "node:fs/promises";
import path from "node:path";
import { compareCodeUnits } from "./code-unit-order.ts";
import { isSameOrInside } from "./filesystem-boundaries.ts";
import { runProtectedInventoryWorker } from "./hygiene-protected-inventory-process.ts";
import {
  PROTECTED_INVENTORY_MAX_ROOTS,
  type ProtectedInventoryResult,
  type ProtectedInventorySeed,
  type ProtectedInventorySummary,
} from "./hygiene-protected-inventory-types.ts";

export {
  PROTECTED_INVENTORY_MAX_ENTRIES_PER_ROOT,
  PROTECTED_INVENTORY_MAX_ROOTS,
} from "./hygiene-protected-inventory-types.ts";
export type {
  ProtectedInventoryEntry,
  ProtectedInventorySeed,
  ProtectedInventorySummary,
} from "./hygiene-protected-inventory-types.ts";

type ProtectedInventoryOptions = {
  readonly rootsTruncated?: boolean;
  readonly coverageIncomplete?: boolean;
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

export async function buildProtectedInventory(repoRoot: string, seeds: readonly ProtectedInventorySeed[], options: ProtectedInventoryOptions = {}): Promise<ProtectedInventoryResult> {
  const canonicalRepoRoot = await fs.realpath(path.resolve(repoRoot));
  const orderedSeeds = [...seeds].sort((left, right) => compareCodeUnits(left.path, right.path));
  const collapsedSeeds: ProtectedInventorySeed[] = [];
  for (const seed of orderedSeeds) {
    const root = path.resolve(canonicalRepoRoot, seed.path);
    if (!isSameOrInside(root, canonicalRepoRoot)) throw new Error(`Protected inventory root escapes the repository: ${seed.path}`);
    if (!collapsedSeeds.some((existing) => isSameOrInside(root, path.resolve(canonicalRepoRoot, existing.path)))) collapsedSeeds.push(seed);
  }
  const selectedSeeds = collapsedSeeds.slice(0, PROTECTED_INVENTORY_MAX_ROOTS);
  const rootsTruncated = options.rootsTruncated === true || selectedSeeds.length < collapsedSeeds.length;
  const coverageIncomplete = options.coverageIncomplete === true;
  if (selectedSeeds.length === 0) {
    return {
      entries: [],
      summary: { ...EMPTY_PROTECTED_INVENTORY, rootsTruncated, bytesTruncated: rootsTruncated || coverageIncomplete },
    };
  }
  return runProtectedInventoryWorker({ repoRoot: canonicalRepoRoot, seeds: selectedSeeds, rootsTruncated, coverageIncomplete });
}
