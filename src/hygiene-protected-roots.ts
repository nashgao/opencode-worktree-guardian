import path from "node:path";
import { compareCodeUnits } from "./code-unit-order.ts";
import { isSameOrInside } from "./filesystem-boundaries.ts";
import type { ProtectedInventorySeed } from "./hygiene-protected-inventory.ts";

function createProtectedRootCollector(repoRoot: string, limit: number) {
  const roots = new Map<string, ProtectedInventorySeed>();
  let omittedAncestor: string | null = null;
  let greatestPath: string | null = null;
  let replayRequired = false;
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
      const hadOmissions = omittedAncestor !== null;
      if (omittedAncestor !== null && isSameOrInside(omittedAncestor, candidate)) {
        omittedAncestor = null;
        replayRequired = true;
      }
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
      if (removedDescendant && hadOmissions) replayRequired = true;
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
    replayRequired(): boolean {
      return replayRequired;
    },
  };
}

export function collectProtectedRoots(repoRoot: string, limit: number, replay: () => Iterable<ProtectedInventorySeed>) {
  let primedRoots: readonly ProtectedInventorySeed[] = [];
  let previousResult: { entries: readonly ProtectedInventorySeed[]; rootsTruncated: boolean } | null = null;
  for (let iteration = 0; iteration <= limit; iteration += 1) {
    const collector = createProtectedRootCollector(repoRoot, limit);
    primedRoots.forEach((seed) => collector.add(seed));
    for (const seed of replay()) collector.add(seed);
    const result = { entries: collector.entries(), rootsTruncated: collector.rootsTruncated() };
    const stabilized = previousResult !== null
      && previousResult.rootsTruncated === result.rootsTruncated
      && previousResult.entries.length === result.entries.length
      && previousResult.entries.every((entry, index) => entry.path === result.entries[index]?.path && entry.reason === result.entries[index]?.reason);
    if (!collector.replayRequired() || stabilized) return result;
    previousResult = result;
    primedRoots = result.entries;
  }
  throw new Error("protected root collection did not stabilize within its bounded replay limit");
}
