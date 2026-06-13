import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { relativePath } from "./filesystem-boundaries.ts";

export type DeletionFingerprintEntry = Record<string, string | number>;

async function collectFilesystemFingerprint(repoRoot: string, absolutePath: string) {
  const entries: DeletionFingerprintEntry[] = [];
  async function visit(currentAbsolute: string) {
    const stat = await fs.lstat(currentAbsolute);
    const currentRelative = relativePath(repoRoot, currentAbsolute);
    if (stat.isSymbolicLink()) {
      entries.push({ path: currentRelative, kind: "symlink", target: await fs.readlink(currentAbsolute) });
      return;
    }
    if (stat.isDirectory()) {
      entries.push({ path: currentRelative, kind: "directory" });
      const children = await fs.readdir(currentAbsolute);
      for (const child of children.sort((left, right) => left.localeCompare(right))) await visit(path.join(currentAbsolute, child));
      return;
    }
    if (stat.isFile()) {
      const content = await fs.readFile(currentAbsolute);
      entries.push({ path: currentRelative, kind: "file", size: stat.size, sha256: crypto.createHash("sha256").update(content).digest("hex") });
      return;
    }
    entries.push({ path: currentRelative, kind: "other", size: stat.size });
  }
  await visit(absolutePath);
  return entries;
}

export function collectCleanupFingerprint(repoRoot: string, absolutePath: string) {
  return collectFilesystemFingerprint(repoRoot, absolutePath);
}

export function collectDeleteFingerprint(repoRoot: string, absolutePath: string) {
  return collectFilesystemFingerprint(repoRoot, absolutePath);
}

export async function collectIgnoredFileFingerprint(worktreePath: string, ignoredFiles: string[]) {
  const entries = new Set<string>();
  async function addEntry(relativePath: string) {
    const normalized = relativePath.replace(/\/+/g, "/");
    entries.add(normalized);
    if (!normalized.endsWith("/")) return;
    const absoluteDir = path.join(worktreePath, normalized);
    let children: string[] = [];
    try {
      children = await fs.readdir(absoluteDir);
    } catch {
      return;
    }
    for (const child of children) await addEntry(`${normalized}${child}${(await fs.stat(path.join(absoluteDir, child))).isDirectory() ? "/" : ""}`);
  }
  for (const ignoredFile of ignoredFiles) await addEntry(ignoredFile);
  return [...entries].sort();
}
