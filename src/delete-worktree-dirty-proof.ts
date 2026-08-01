import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSafetyRef, createRef, fetchRemote, getRefCommit, runGit, runGitNullSeparated, snapshotWorktreeDirtCommit } from "./git.ts";
import { errorMessage } from "./delete-worktree-report.ts";
import type { RemoteAuthority } from "./git-authority.ts";

export type RedundantDirtyKind = "tracked-modified" | "tracked-deleted" | "untracked";

export type DirtyStatusEntry = {
  readonly status: string;
  readonly path: string;
  readonly sourcePath?: string;
};

export type RedundantDirtyProof = {
  readonly path: string;
  readonly status: string;
  readonly kind: RedundantDirtyKind;
  readonly baseRef: string;
  readonly baseRefOid: string;
  readonly matchesBase: boolean;
  readonly reason?: string;
};

export type RedundantDirtyProofResult =
  | {
      readonly ok: true;
      readonly proofs: readonly RedundantDirtyProof[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly proofs: readonly RedundantDirtyProof[];
      readonly failedPath?: string;
    };

export type RedundantDirtyBaseResult =
  | {
      readonly ok: true;
      readonly baseRef: string;
      readonly baseRefOid: string;
    }
  | {
      readonly ok: false;
      readonly baseRef: string;
      readonly reason: string;
      readonly error: string;
    };

export type DirtyCleanupResult = {
  readonly cleanedFiles: readonly string[];
  readonly remainingEntries: readonly DirtyStatusEntry[];
};

export type DirtySnapshotResult = {
  readonly dirtySnapshotCommit: string;
  readonly dirtySnapshotRef: string;
  readonly dirtySnapshotFiles: readonly string[];
};

function tempIndexPath(prefix: string) {
  return path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function scopedIndexEnv(tempIndex: string) {
  return {
    GIT_INDEX_FILE: tempIndex,
  };
}

function isPathInside(root: string, relativePath: string) {
  if (path.isAbsolute(relativePath)) return false;
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function classifyDirtyStatus(entry: DirtyStatusEntry): { readonly ok: true; readonly kind: RedundantDirtyKind } | { readonly ok: false; readonly reason: string } {
  if (entry.sourcePath) return { ok: false, reason: `unsupported dirty status ${entry.status} for ${entry.path}` };
  if (entry.status === " M") return { ok: true, kind: "tracked-modified" };
  if (entry.status === " D") return { ok: true, kind: "tracked-deleted" };
  if (entry.status === "??") return { ok: true, kind: "untracked" };
  return { ok: false, reason: `unsupported dirty status ${entry.status} for ${entry.path}` };
}

async function assertRegularWorktreePath(worktreePath: string, filePath: string): Promise<string | null> {
  if (!isPathInside(worktreePath, filePath)) return "unsupported dirty path outside target worktree";
  try {
    const stats = await fs.lstat(path.join(worktreePath, filePath));
    if (!stats.isFile()) return `unsupported dirty path ${filePath}`;
    return null;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return `unreadable dirty path ${filePath}: ${errorMessage(error)}`;
  }
}

async function basePathExists(worktreePath: string, baseAuthorityRef: string, filePath: string) {
  const result = await runGit(worktreePath, ["--literal-pathspecs", "ls-tree", "-z", baseAuthorityRef, "--", filePath]);
  return result.stdout.length > 0;
}

async function worktreePathMatchesBase(worktreePath: string, baseAuthorityRef: string, filePath: string) {
  const tempIndex = tempIndexPath("guardian-redundant-dirty-index");
  const env = scopedIndexEnv(tempIndex);
  try {
    await runGit(worktreePath, ["read-tree", baseAuthorityRef], { env });
    await runGit(worktreePath, ["--literal-pathspecs", "add", "--", filePath], { env });
    const tree = (await runGit(worktreePath, ["write-tree"], { env })).stdout;
    const diff = await runGit(worktreePath, ["--literal-pathspecs", "diff", "--name-only", "-z", baseAuthorityRef, tree, "--", filePath], { env });
    return diff.stdout.length === 0;
  } finally {
    await fs.rm(tempIndex, { force: true });
  }
}

export async function getRichDirtyStatus(repoPath: string): Promise<DirtyStatusEntry[]> {
  const rawEntries = await runGitNullSeparated(repoPath, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  const entries: DirtyStatusEntry[] = [];
  for (let index = 0; index < rawEntries.length; index += 1) {
    const rawEntry = rawEntries[index];
    if (!rawEntry || rawEntry.length < 4) continue;
    const statusCode = rawEntry.slice(0, 2);
    const filePath = rawEntry.slice(3);
    if (!filePath) continue;
    if (statusCode.includes("R") || statusCode.includes("C")) {
      const sourcePath = rawEntries[index + 1];
      entries.push({ status: statusCode, path: filePath, ...(sourcePath ? { sourcePath } : {}) });
      index += 1;
    } else {
      entries.push({ status: statusCode, path: filePath });
    }
  }
  return entries;
}

export async function resolveRedundantDirtyBase(repoRoot: string, authority: RemoteAuthority): Promise<RedundantDirtyBaseResult> {
  try {
    await fetchRemote(repoRoot, authority.remote);
    const baseRefOid = await getRefCommit(repoRoot, authority.authorityRef);
    return { ok: true, baseRef: authority.displayRef, baseRefOid };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return {
      ok: false,
      baseRef: authority.displayRef,
      reason: "base ref could not be resolved for redundant dirty proof",
      error: errorMessage(error),
    };
  }
}

export async function proveRedundantDirtyPaths(worktreePath: string, authority: RemoteAuthority, baseRefOid: string): Promise<RedundantDirtyProofResult> {
  const entries = await getRichDirtyStatus(worktreePath);
  const proofs: RedundantDirtyProof[] = [];
  for (const entry of entries) {
    const classified = classifyDirtyStatus(entry);
    if (!classified.ok) return { ok: false, reason: classified.reason, proofs, failedPath: entry.path };
    if (!isPathInside(worktreePath, entry.path)) return { ok: false, reason: `unsupported dirty path ${entry.path}`, proofs, failedPath: entry.path };

    if (classified.kind === "tracked-deleted") {
      const matchesBase = !(await basePathExists(worktreePath, authority.authorityRef, entry.path));
      const proof: RedundantDirtyProof = {
        path: entry.path,
        status: entry.status,
        kind: classified.kind,
        baseRef: authority.displayRef,
        baseRefOid,
        matchesBase,
        ...(matchesBase ? {} : { reason: "path still exists in base tree" }),
      };
      proofs.push(proof);
      if (!matchesBase) return { ok: false, reason: `redundant dirty proof failed for ${entry.path}`, proofs, failedPath: entry.path };
      continue;
    }

    const pathError = await assertRegularWorktreePath(worktreePath, entry.path);
    if (pathError) return { ok: false, reason: pathError, proofs, failedPath: entry.path };
    const matchesBase = await worktreePathMatchesBase(worktreePath, authority.authorityRef, entry.path);
    const proof: RedundantDirtyProof = {
      path: entry.path,
      status: entry.status,
      kind: classified.kind,
      baseRef: authority.displayRef,
      baseRefOid,
      matchesBase,
      ...(matchesBase ? {} : { reason: "worktree path differs from base tree" }),
    };
    proofs.push(proof);
    if (!matchesBase) return { ok: false, reason: `redundant dirty proof failed for ${entry.path}`, proofs, failedPath: entry.path };
  }
  return { ok: true, proofs };
}

export async function createDirtySnapshotRef(repoRoot: string, worktreePath: string, options: { readonly sessionId: string; readonly branch: string; readonly head: string; readonly paths: readonly string[]; readonly timestamp: unknown }): Promise<DirtySnapshotResult> {
  const dirtySnapshotFiles = [...options.paths].sort();
  const dirtySnapshotCommit = await snapshotWorktreeDirtCommit(worktreePath, {
    parentCommit: options.head,
    paths: dirtySnapshotFiles,
    message: `Snapshot redundant dirty paths before deleting ${options.branch}`,
  });
  const dirtySnapshotRef = buildSafetyRef(options.sessionId, `redundant-dirty/${options.branch}`, options.timestamp);
  await createRef(repoRoot, dirtySnapshotRef, dirtySnapshotCommit);
  return { dirtySnapshotCommit, dirtySnapshotRef, dirtySnapshotFiles };
}

export async function cleanRedundantDirtyPaths(worktreePath: string, proofs: readonly RedundantDirtyProof[]): Promise<DirtyCleanupResult> {
  const trackedPaths = proofs.filter((proof) => proof.kind !== "untracked").map((proof) => proof.path);
  const untrackedPaths = proofs.filter((proof) => proof.kind === "untracked").map((proof) => proof.path);
  if (trackedPaths.length > 0) await runGit(worktreePath, ["--literal-pathspecs", "restore", "--worktree", "--", ...trackedPaths]);
  for (const filePath of untrackedPaths) {
    const pathError = await assertRegularWorktreePath(worktreePath, filePath);
    if (pathError) continue;
    await fs.rm(path.join(worktreePath, filePath), { force: false });
  }
  return {
    cleanedFiles: [...proofs.map((proof) => proof.path)].sort(),
    remainingEntries: await getRichDirtyStatus(worktreePath),
  };
}
