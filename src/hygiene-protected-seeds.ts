import path from "node:path";
import { isSameOrInside, relativePath } from "./filesystem-boundaries.ts";
import type { ReviewableCandidateInput } from "./hygiene-candidates.ts";
import type { ProtectedInventorySeed } from "./hygiene-protected-inventory.ts";
import { protectedPathMatch } from "./protected-paths.ts";

const PROTECTED_DIR_NAMES = new Set([
  "node_modules", "vendor", "target", "dist", "build", "coverage",
  ".cache", ".next", ".turbo", ".vite", ".parcel-cache", ".pnpm-store",
  "out", "tmp", "temp",
]);

const METADATA_REASONS = new Set(["git metadata", "git worktree metadata", "nested Git metadata"]);

export function protectedDirReason(relative: string, protectedPaths: readonly string[] = []) {
  const parts = relative.split("/").filter(Boolean);
  if (parts[0] === ".git") {
    return relative === ".git/worktrees" || relative.startsWith(".git/worktrees/") ? "git worktree metadata" : "git metadata";
  }
  if (parts.includes(".git")) return "nested Git metadata";
  const protectedPath = protectedPathMatch(relative, protectedPaths);
  if (protectedPath) return protectedPath.reason;
  const protectedPart = parts.find((part) => PROTECTED_DIR_NAMES.has(part));
  return protectedPart ? `protected ${protectedPart} directory` : null;
}

function protectedDirExclusionPath(relative: string) {
  const parts = relative.split("/").filter(Boolean);
  return parts.slice(0, parts.findIndex((part) => PROTECTED_DIR_NAMES.has(part)) + 1).join("/") || parts[0] || relative;
}

export function protectedSeedForRelative(input: { repoRoot: string; relative: string; protectedPaths: readonly string[]; protectedRoots: readonly string[] }): ProtectedInventorySeed | null {
  const seeds: ProtectedInventorySeed[] = [];
  const configured = protectedPathMatch(input.relative, input.protectedPaths);
  if (configured) seeds.push({ path: configured.path, reason: configured.reason });
  const absolutePath = path.resolve(input.repoRoot, input.relative);
  const worktreeRoot = input.protectedRoots.find((root) => isSameOrInside(absolutePath, root));
  if (worktreeRoot) seeds.push({ path: relativePath(input.repoRoot, worktreeRoot), reason: "configured or registered Git worktree path" });
  const reason = protectedDirReason(input.relative);
  if (reason) seeds.push({ path: protectedDirExclusionPath(input.relative), reason });
  return seeds.reduce<ProtectedInventorySeed | null>((outer, seed) => {
    if (!outer) return seed;
    return outer.path !== seed.path && isSameOrInside(path.resolve(input.repoRoot, outer.path), path.resolve(input.repoRoot, seed.path)) ? seed : outer;
  }, null);
}

export function* replayProtectedSeeds(input: {
  repoRoot: string;
  protectedPaths: readonly string[];
  protectedRoots: readonly string[];
  candidates: readonly ReviewableCandidateInput[];
  exclusions: readonly { path: string; reason: string }[];
  existingProtectedPaths: readonly string[];
  existingProtectedRoots: readonly string[];
}): Generator<ProtectedInventorySeed> {
  const seed = (relative: string) => protectedSeedForRelative({ repoRoot: input.repoRoot, relative, protectedPaths: input.protectedPaths, protectedRoots: input.protectedRoots });
  for (const candidate of input.candidates) {
    const protectedSeed = seed(relativePath(input.repoRoot, path.resolve(input.repoRoot, candidate.path)));
    if (protectedSeed) yield protectedSeed;
  }
  for (const exclusion of input.exclusions) {
    const protectedSeed = seed(exclusion.path);
    if (protectedSeed && !METADATA_REASONS.has(exclusion.reason)) yield protectedSeed;
  }
  for (const protectedPath of input.existingProtectedPaths) {
    const protectedSeed = seed(protectedPath);
    if (protectedSeed) yield protectedSeed;
  }
  for (const protectedRoot of input.existingProtectedRoots) {
    const protectedSeed = seed(protectedRoot);
    if (protectedSeed) yield protectedSeed;
  }
}
