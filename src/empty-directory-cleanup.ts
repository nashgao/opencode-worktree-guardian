import fs from "node:fs/promises";
import path from "node:path";
import { assertNoSymlinkAncestors, isEnoent, isSameOrInside, lstatOrMissing } from "./filesystem-boundaries.ts";
import { syncDirectory } from "./state-durable-file.ts";

type EmptyAncestorCleanupInput = {
  readonly root: string;
  readonly removedPath: string;
};

function isNotEmpty(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "ENOTEMPTY" || error.code === "EEXIST";
}

export async function removeEmptyAncestorDirectories(input: EmptyAncestorCleanupInput): Promise<void> {
  const root = path.resolve(input.root);
  let current = path.dirname(path.resolve(input.removedPath));
  while (current !== root && isSameOrInside(current, root)) {
    const stat = await lstatOrMissing(current);
    if (!stat) {
      current = path.dirname(current);
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    await assertNoSymlinkAncestors(current, "empty-directory cleanup path");
    const parent = path.dirname(current);
    try {
      await fs.rmdir(current);
    } catch (error) {
      if (isEnoent(error)) {
        current = parent;
        continue;
      }
      if (isNotEmpty(error)) return;
      throw error;
    }
    await syncDirectory(parent);
    current = parent;
  }
}
