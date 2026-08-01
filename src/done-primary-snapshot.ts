import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expandWorktreeRoot } from "./config.ts";
import { runGitNullSeparated } from "./git.ts";
import { runGitNullSeparatedInArtifactSandbox } from "./git.ts";
import type { RecordLike } from "./types.ts";
import type { GitArtifactSandbox } from "./git.ts";
import { errorCode } from "./types.ts";

export type StatusEntry = { readonly status: string; readonly path: string; readonly sourcePath?: string };

export type FileFingerprint = {
  readonly path: string;
  readonly kind: "file" | "directory" | "other" | "missing";
  readonly size: number | null;
  readonly hash: string | null;
};

export type DirtySnapshot = {
  readonly entries: readonly StatusEntry[];
  readonly paths: readonly string[];
  readonly fingerprints: readonly FileFingerprint[];
};

function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isGuardianWorktreeStatusPath(repoRoot: string, config: RecordLike, statusPath: string): boolean {
  const guardianRoot = path.resolve(repoRoot, expandWorktreeRoot(String(config.worktreeRoot), repoRoot));
  const absoluteStatusPath = path.resolve(repoRoot, statusPath.replace(/\/$/, ""));
  return isInside(absoluteStatusPath, guardianRoot);
}

type StatusEntriesOptions = {
  readonly includeIgnored?: boolean;
  readonly artifactSandbox?: GitArtifactSandbox;
  readonly optionalLocksDisabled?: boolean;
};

export async function statusEntries(repoRoot: string, options: StatusEntriesOptions = {}): Promise<StatusEntry[]> {
  const statusArgs = options.includeIgnored === true
    ? ["status", "--porcelain=v1", "--untracked-files=all", "--ignored", "-z"]
    : ["status", "--porcelain=v1", "--untracked-files=all", "-z"];
  const rawEntries = options.artifactSandbox
    ? await runGitNullSeparatedInArtifactSandbox(repoRoot, statusArgs, options.artifactSandbox)
    : await runGitNullSeparated(repoRoot, statusArgs, options.optionalLocksDisabled ? { env: { GIT_OPTIONAL_LOCKS: "0" } } : {});
  const entries: StatusEntry[] = [];
  for (let index = 0; index < rawEntries.length; index += 1) {
    const entry = rawEntries[index];
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (!filePath) continue;
    if (status.includes("R") || status.includes("C")) {
      const sourcePath = rawEntries[index + 1];
      entries.push({ status, path: filePath, sourcePath });
      index += 1;
    } else {
      entries.push({ status, path: filePath });
    }
  }
  return entries;
}

export async function fileFingerprint(repoRoot: string, relativePath: string): Promise<FileFingerprint> {
  const absolutePath = path.join(repoRoot, relativePath);
  try {
    const stat = await fs.lstat(absolutePath);
    if (!stat.isFile()) return { path: relativePath, kind: stat.isDirectory() ? "directory" : "other", size: stat.size, hash: null };
    const content = await fs.readFile(absolutePath);
    return { path: relativePath, kind: "file", size: stat.size, hash: crypto.createHash("sha256").update(content).digest("hex") };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { path: relativePath, kind: "missing", size: null, hash: null };
    throw error;
  }
}

export async function dirtySnapshotFromEntries(repoRoot: string, allEntries: readonly StatusEntry[], config?: RecordLike): Promise<DirtySnapshot> {
  const entries = config ? allEntries.filter((entry) => !isGuardianWorktreeStatusPath(repoRoot, config, entry.path)) : allEntries;
  const paths = [...new Set(entries.flatMap((entry) => [entry.path, entry.sourcePath].filter((value): value is string => typeof value === "string" && value.length > 0)))].sort((left, right) => left.localeCompare(right));
  const fingerprints = [];
  for (const filePath of paths) fingerprints.push(await fileFingerprint(repoRoot, filePath));
  return { entries, paths, fingerprints };
}

export async function dirtySnapshot(repoRoot: string, config?: RecordLike, options: Pick<StatusEntriesOptions, "optionalLocksDisabled"> = {}): Promise<DirtySnapshot> {
  return dirtySnapshotFromEntries(repoRoot, await statusEntries(repoRoot, options), config);
}
