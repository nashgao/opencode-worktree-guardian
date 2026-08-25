import fs from "node:fs/promises";
import path from "node:path";
import { compareCodeUnits } from "./code-unit-order.ts";
import { parseNullSeparated } from "./filesystem-boundaries.ts";
import { runGit } from "./git.ts";

const GLOB_META = /[*?\[\]{}]/;
const MAX_INTENTIONAL_PATHS = 128;
const MAX_INTENTIONAL_PATH_BYTES = 8_192;

export class GoalIntentionalPathsError extends Error {
  readonly code = "invalid_intentional_paths";
}

function normalizeIntentionalPath(value: string): string {
  const trimmed = value.trim().replaceAll("\\", "/");
  if (trimmed.length === 0) throw new GoalIntentionalPathsError("intentionalPaths entries must not be empty");
  if (Buffer.byteLength(trimmed, "utf8") > MAX_INTENTIONAL_PATH_BYTES) throw new GoalIntentionalPathsError("intentionalPaths entries are too long");
  if (trimmed.includes("\0")) throw new GoalIntentionalPathsError("intentionalPaths entries must not contain NUL bytes");
  if (trimmed.startsWith("/") || /^[A-Za-z]:\//.test(trimmed)) throw new GoalIntentionalPathsError("intentionalPaths entries must be repo-relative");
  if (GLOB_META.test(trimmed)) throw new GoalIntentionalPathsError("intentionalPaths entries must be exact paths, not globs");
  const parts = trimmed.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new GoalIntentionalPathsError("intentionalPaths entries must stay inside the repository");
  }
  return parts.join("/");
}

export function normalizeGoalIntentionalPaths(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new GoalIntentionalPathsError("intentionalPaths must be an array of repo-relative paths");
  if (value.length > MAX_INTENTIONAL_PATHS) throw new GoalIntentionalPathsError(`intentionalPaths accepts at most ${MAX_INTENTIONAL_PATHS} entries`);
  const normalized = value.map((entry) => {
    if (typeof entry !== "string") throw new GoalIntentionalPathsError("intentionalPaths entries must be strings");
    return normalizeIntentionalPath(entry);
  });
  return [...new Set(normalized)].sort(compareCodeUnits);
}

export async function validateGoalIntentionalPaths(cwd: string, intentionalPaths: readonly string[]): Promise<void> {
  for (const relative of intentionalPaths) {
    const absolute = path.resolve(cwd, relative);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(absolute);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new GoalIntentionalPathsError(`intentionalPaths must name current regular untracked files: ${relative}`);
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new GoalIntentionalPathsError(`intentionalPaths must name current regular untracked files: ${relative}`);
    }
    const tracked = parseNullSeparated((await runGit(cwd, ["ls-files", "-z", "--", relative])).stdout);
    if (tracked.length > 0) throw new GoalIntentionalPathsError(`intentionalPaths must not include tracked files: ${relative}`);
  }
}
