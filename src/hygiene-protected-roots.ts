import path from "node:path";
import { compareCodeUnits } from "./code-unit-order.ts";
import { isSameOrInside } from "./filesystem-boundaries.ts";
import type { ProtectedInventorySeed } from "./hygiene-protected-inventory.ts";

export function createProtectedRootCollector(repoRoot: string, limit: number) {
  const roots = new Map<string, ProtectedInventorySeed>();
  let omittedAncestor: string | null = null;
  let greatestPath: string | null = null;
  const absolute = (value: string) => path.resolve(repoRoot, value);
  const recordOmitted = (candidate: string) => {
    if (omittedAncestor === null) omittedAncestor = candidate;
    while (omittedAncestor !== null && !isSameOrInside(candidate, omittedAncestor)) {
      const parent = path.dirname(omittedAncestor);
      if (parent === omittedAncestor) break;
      omittedAncestor = parent;
    }
  };
  const refreshGreatestPath = () => {
    greatestPath = null;
    for (const candidate of roots.keys()) {
      if (greatestPath === null || compareCodeUnits(candidate, greatestPath) > 0) greatestPath = candidate;
    }
  };
  return {
    add(seed: ProtectedInventorySeed): void {
      const candidate = absolute(seed.path);
      if (omittedAncestor !== null && isSameOrInside(omittedAncestor, candidate)) omittedAncestor = null;
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
      if (greatestPath !== null && compareCodeUnits(seed.path, greatestPath) < 0) {
        recordOmitted(absolute(greatestPath));
        roots.delete(greatestPath);
        roots.set(seed.path, seed);
        refreshGreatestPath();
      } else {
        recordOmitted(candidate);
      }
    },
    entries(): readonly ProtectedInventorySeed[] {
      return [...roots.values()].sort((left, right) => compareCodeUnits(left.path, right.path));
    },
    rootsTruncated(): boolean {
      return omittedAncestor !== null;
    },
  };
}
