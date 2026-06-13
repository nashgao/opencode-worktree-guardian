import fs from "node:fs";
import path from "node:path";

export function normalizeForCompare(value: string, cwd: string): string {
  const resolved = path.resolve(cwd, value);
  return path.normalize(resolved);
}

export function realpathForCompare(value: string, cwd: string): string {
  const normalized = normalizeForCompare(value, cwd);
  try {
    return path.normalize(fs.realpathSync.native(normalized));
  } catch {
    return normalized;
  }
}

export function isSameOrInside(candidate: string, knownPath: string): boolean {
  const relative = path.relative(knownPath, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function pathSameOrInside(candidate: string, target: string, cwd: string): boolean {
  return isSameOrInside(realpathForCompare(candidate, cwd), realpathForCompare(target, cwd));
}

export function matchesKnownWorktreePath(candidate: string, knownWorktreePaths: readonly string[], cwd: string): boolean {
  if (!candidate || candidate.startsWith("-")) return false;
  const resolvedCandidate = normalizeForCompare(candidate, cwd);
  return knownWorktreePaths.some((knownPath) => isSameOrInside(resolvedCandidate, normalizeForCompare(knownPath, cwd)));
}
