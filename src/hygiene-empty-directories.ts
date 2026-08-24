import fs from "node:fs/promises";
import path from "node:path";

export type EmptyDirectoryScan = {
  readonly directories: readonly string[];
  readonly excluded: readonly { readonly path: string; readonly reason: string }[];
  readonly maximumDepth: number;
  readonly maximumEntries: number;
  readonly scannedEntryCount: number;
  readonly complete: boolean;
};

type EmptyDirectoryScanOptions = {
  readonly exclude: (relativePath: string) => string | null;
  readonly maximumDepth: number;
  readonly maximumEntries: number;
  readonly repoRoot: string;
};

export const DEFAULT_EMPTY_DIRECTORY_MAX_DEPTH = 12;
export const DEFAULT_EMPTY_DIRECTORY_MAX_ENTRIES = 10_000;

export async function scanEmptyDirectories(options: EmptyDirectoryScanOptions): Promise<EmptyDirectoryScan> {
  const directories: string[] = [];
  const excluded = new Map<string, string>();
  let complete = true;
  let scannedEntryCount = 0;

  async function visit(absolutePath: string, relativePath: string, depth: number): Promise<void> {
    const exclusion = relativePath.length > 0 ? options.exclude(relativePath) : null;
    if (exclusion) {
      excluded.set(relativePath, exclusion);
      return;
    }
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    if (relativePath.length > 0 && entries.length === 0) {
      directories.push(relativePath);
      return;
    }
    if (depth >= options.maximumDepth) {
      if (entries.some((entry) => entry.isDirectory())) complete = false;
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      scannedEntryCount += 1;
      if (scannedEntryCount > options.maximumEntries) {
        complete = false;
        return;
      }
      const childRelativePath = relativePath.length > 0 ? path.posix.join(relativePath, entry.name) : entry.name;
      await visit(path.join(absolutePath, entry.name), childRelativePath, depth + 1);
      if (!complete && scannedEntryCount > options.maximumEntries) return;
    }
  }

  await visit(options.repoRoot, "", 0);
  return {
    directories: directories.sort((left, right) => left.localeCompare(right)),
    excluded: [...excluded.entries()]
      .map(([excludedPath, reason]) => ({ path: excludedPath, reason }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    maximumDepth: options.maximumDepth,
    maximumEntries: options.maximumEntries,
    scannedEntryCount,
    complete,
  };
}
