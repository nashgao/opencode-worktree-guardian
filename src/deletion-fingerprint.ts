import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isEnoent, relativePath } from "./filesystem-boundaries.ts";

export type DeletionFingerprintEntry = Record<string, string | number>;

type DeletionFingerprintTestHook = {
  readonly beforeLstat?: (absolutePath: string) => void | Promise<void>;
  readonly afterLstat?: (absolutePath: string) => void | Promise<void>;
  readonly afterDirectoryRead?: (absoluteDirectory: string) => void | Promise<void>;
};

let deletionFingerprintTestHook: DeletionFingerprintTestHook | undefined;

export function setDeletionFingerprintTestHookForTesting(hook: DeletionFingerprintTestHook | undefined) {
  deletionFingerprintTestHook = hook;
}

async function collectFilesystemFingerprint(repoRoot: string, absolutePath: string) {
  async function visit(currentAbsolute: string): Promise<DeletionFingerprintEntry[] | null> {
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    await deletionFingerprintTestHook?.beforeLstat?.(currentAbsolute);
    try {
      stat = await fs.lstat(currentAbsolute);
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
    await deletionFingerprintTestHook?.afterLstat?.(currentAbsolute);
    const currentRelative = relativePath(repoRoot, currentAbsolute);
    if (stat.isSymbolicLink()) {
      try {
        return [{ path: currentRelative, kind: "symlink", target: await fs.readlink(currentAbsolute) }];
      } catch (error) {
        if (isEnoent(error)) return null;
        throw error;
      }
    }
    if (stat.isDirectory()) {
      let children: string[];
      try {
        children = await fs.readdir(currentAbsolute);
      } catch (error) {
        if (isEnoent(error)) return null;
        throw error;
      }
      await deletionFingerprintTestHook?.afterDirectoryRead?.(currentAbsolute);
      const entries: DeletionFingerprintEntry[] = [{ path: currentRelative, kind: "directory" }];
      for (const child of children.sort((left, right) => left.localeCompare(right))) {
        const childEntries = await visit(path.join(currentAbsolute, child));
        if (childEntries) entries.push(...childEntries);
      }
      return entries;
    }
    if (stat.isFile()) {
      try {
        const content = await fs.readFile(currentAbsolute);
        return [{ path: currentRelative, kind: "file", size: stat.size, sha256: crypto.createHash("sha256").update(content).digest("hex") }];
      } catch (error) {
        if (isEnoent(error)) return null;
        throw error;
      }
    }
    return [{ path: currentRelative, kind: "other", size: stat.size }];
  }
  return await visit(absolutePath) ?? [];
}

export function collectCleanupFingerprint(repoRoot: string, absolutePath: string) {
  return collectFilesystemFingerprint(repoRoot, absolutePath);
}

export function collectDeleteFingerprint(repoRoot: string, absolutePath: string) {
  return collectFilesystemFingerprint(repoRoot, absolutePath);
}

export async function collectIgnoredFileFingerprint(worktreePath: string, ignoredFiles: readonly string[]) {
  const entries: DeletionFingerprintEntry[] = [];
  for (const ignoredFile of [...ignoredFiles].sort((left, right) => left.localeCompare(right))) {
    entries.push(...await collectFilesystemFingerprint(worktreePath, path.resolve(worktreePath, ignoredFile)));
  }
  return entries.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
