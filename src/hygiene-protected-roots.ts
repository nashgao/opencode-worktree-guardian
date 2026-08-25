import path from "node:path";
import { compareCodeUnits } from "./code-unit-order.ts";
import { isSameOrInside } from "./filesystem-boundaries.ts";
import type { ProtectedInventorySeed } from "./hygiene-protected-inventory.ts";

export function createProtectedRootCollector(repoRoot: string, limit: number) {
  const roots = new Map<string, ProtectedInventorySeed>();
  let rootsTruncated = false;
  let greatestPath: string | null = null;
  const absolute = (value: string) => path.resolve(repoRoot, value);
  const refreshGreatestPath = () => {
    greatestPath = null;
    for (const candidate of roots.keys()) {
      if (greatestPath === null || compareCodeUnits(candidate, greatestPath) > 0) greatestPath = candidate;
    }
  };
  return {
    add(seed: ProtectedInventorySeed): void {
      const candidate = absolute(seed.path);
      for (const existing of roots.values()) {
        if (isSameOrInside(candidate, absolute(existing.path))) return;
      }
      let removedDescendant = false;
      for (const existing of roots.values()) {
        if (isSameOrInside(absolute(existing.path), candidate)) {
          roots.delete(existing.path);
          removedDescendant = true;
        }
      }
      if (removedDescendant) refreshGreatestPath();
      if (roots.size < limit) {
        roots.set(seed.path, seed);
        if (greatestPath === null || compareCodeUnits(seed.path, greatestPath) > 0) greatestPath = seed.path;
        return;
      }
      rootsTruncated = true;
      if (greatestPath !== null && compareCodeUnits(seed.path, greatestPath) < 0) {
        roots.delete(greatestPath);
        roots.set(seed.path, seed);
        refreshGreatestPath();
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
