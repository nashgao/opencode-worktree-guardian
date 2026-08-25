import path from "node:path";
import { compareCodeUnits } from "./code-unit-order.ts";
import { isSameOrInside } from "./filesystem-boundaries.ts";
import type { ProtectedInventorySeed } from "./hygiene-protected-inventory.ts";

export function createProtectedSeedCollector() {
  const seeds = new Map<string, ProtectedInventorySeed>();
  return {
    add(seed: ProtectedInventorySeed): void {
      if (!seeds.has(seed.path)) seeds.set(seed.path, seed);
    },
    entries(): readonly ProtectedInventorySeed[] {
      return [...seeds.values()].sort((left, right) => compareCodeUnits(left.path, right.path));
    },
  };
}

export function createProtectedRootCollector(repoRoot: string, limit: number) {
  const roots = new Map<string, ProtectedInventorySeed>();
  let rootsTruncated = false;
  const absolute = (value: string) => path.resolve(repoRoot, value);
  return {
    add(seed: ProtectedInventorySeed): void {
      const candidate = absolute(seed.path);
      for (const existing of roots.values()) {
        if (isSameOrInside(candidate, absolute(existing.path))) return;
      }
      for (const existing of roots.values()) {
        if (isSameOrInside(absolute(existing.path), candidate)) roots.delete(existing.path);
      }
      if (roots.size < limit) {
        roots.set(seed.path, seed);
        return;
      }
      rootsTruncated = true;
      const largestPath = [...roots.keys()].sort(compareCodeUnits).at(-1);
      if (largestPath !== undefined && compareCodeUnits(seed.path, largestPath) < 0) {
        roots.delete(largestPath);
        roots.set(seed.path, seed);
      }
    },
    entries(): readonly ProtectedInventorySeed[] {
      return [...roots.values()].sort((left, right) => compareCodeUnits(left.path, right.path));
    },
    rootsTruncated(): boolean {
      return rootsTruncated;
    },
  };
}
