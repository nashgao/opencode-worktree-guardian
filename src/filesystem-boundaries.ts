import fs from "node:fs/promises";
import path from "node:path";

export function isEnoent(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export function normalizeRelativePath(value: string) {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

export function relativePath(repoRoot: string, absolutePath: string) {
  return normalizeRelativePath(path.relative(repoRoot, absolutePath)) || ".";
}

export function isSameOrInside(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function samePath(left: string, right: string) {
  return path.resolve(left) === path.resolve(right);
}

export function parseNullSeparated(stdout: string) {
  return stdout.split("\0").map((entry) => entry.trim()).filter(Boolean);
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function stringArray(value: unknown) {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return typeof value === "string" && value.trim().length > 0 ? [value] : [];
}

export function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export async function lstatOrMissing(candidate: string) {
  try {
    return await fs.lstat(candidate);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}
