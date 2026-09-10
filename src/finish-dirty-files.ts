import path from "node:path";
import { expandWorktreeRoot } from "./config.ts";
import { getDirtyFiles, listWorktrees } from "./git.ts";
import type { MutableRecord } from "./types.ts";

export function normalizeDirtyPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`${source}$`);
}

export function matchesAllowedDirtyPath(filePath: string, pattern: string): boolean {
  const file = normalizeDirtyPath(filePath);
  const allowed = normalizeDirtyPath(pattern);
  if (!allowed) return false;
  if (allowed.endsWith("/**")) {
    const prefix = allowed.slice(0, -3).replace(/\/$/, "");
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  if (!allowed.includes("*")) return file === allowed;
  return globToRegExp(allowed).test(file);
}

export function classifyDirtyFiles(dirtyFiles: readonly string[], allowDirtyPaths: unknown): { readonly allowedDirtyFiles: string[]; readonly blockingDirtyFiles: string[] } {
  const patterns = Array.isArray(allowDirtyPaths) ? allowDirtyPaths.filter((value): value is string => typeof value === "string" && value.length > 0) : [];
  const allowedDirtyFiles = dirtyFiles.filter((file) => patterns.some((pattern) => matchesAllowedDirtyPath(file, pattern)));
  const blockingDirtyFiles = dirtyFiles.filter((file) => !allowedDirtyFiles.includes(file));
  return { allowedDirtyFiles, blockingDirtyFiles };
}

export function splitPrimaryDirtyFiles(dirtyFiles: readonly string[], repoRoot: string, config: MutableRecord, registeredPaths: readonly string[] = []): { readonly ignoredDirtyFiles: string[]; readonly blockingDirtyFiles: string[] } {
  const configuredRoot = typeof config.worktreeRoot === "string" ? config.worktreeRoot : ".worktrees/$REPO";
  const guardianRoot = normalizeDirtyPath(expandWorktreeRoot(configuredRoot, repoRoot)).replace(/\/$/, "");
  const guardianRootPrefix = `${guardianRoot}/`;
  const ignoredDirtyFiles = dirtyFiles.filter((file) => {
    const normalized = normalizeDirtyPath(file).replace(/\/$/, "");
    return normalized.startsWith(guardianRootPrefix) || registeredPaths.some((root) => normalized === root || normalized.startsWith(`${root}/`));
  });
  const blockingDirtyFiles = dirtyFiles.filter((file) => !ignoredDirtyFiles.includes(file));
  return { ignoredDirtyFiles, blockingDirtyFiles };
}

export async function readPrimaryDirtyFiles(repoRoot: string, config: MutableRecord) {
  const registeredPaths = (await listWorktrees(repoRoot)).map((entry) => normalizeDirtyPath(path.relative(repoRoot, entry.path)))
    .filter((relative) => relative !== "" && relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative));
  return { ...splitPrimaryDirtyFiles(await getDirtyFiles(repoRoot), repoRoot, config, registeredPaths), registeredPaths };
}
