import { finalizeArchivedPathRemoval, prepareArchivedPathRemoval, rollbackArchivedPathRemoval } from "./archived-path-removal.ts";
import { parseArchivedPathFingerprints, verifyArchivedPaths } from "./archived-paths.ts";
import { getRichDirtyStatus } from "./delete-worktree-dirty-proof.ts";
import { blocked, errorMessage } from "./delete-worktree-report.ts";
import { getDirtyFiles, getIgnoredFiles } from "./git.ts";
import type { WorktreeEntry } from "./types.ts";

type ArchiveRuntimeContext = {
  readonly input: Record<string, unknown>;
  readonly preflight: Record<string, unknown>;
  readonly entry: WorktreeEntry;
  readonly afterArchivedPathsQuarantined?: () => Promise<void>;
};

function archivedPaths(preflight: Record<string, unknown>): string[] {
  const value = preflight.archivedPaths;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function archiveInput(input: Record<string, unknown>): { readonly archivePath: string; readonly archiveSha256: string } | null {
  const archivePath = input.archivePath;
  const archiveSha256 = input.archiveSha256;
  if (archivePath === undefined && archiveSha256 === undefined) return null;
  if (typeof archivePath !== "string" || typeof archiveSha256 !== "string") {
    throw new TypeError("archivePath and archiveSha256 must both be exact strings");
  }
  return { archivePath, archiveSha256 };
}

export async function validateArchivedPathsPreflight(
  context: ArchiveRuntimeContext,
  ignoredFiles: readonly string[],
): Promise<{ readonly handled: boolean; readonly blocker: Record<string, unknown> | null }> {
  const { input, preflight, entry } = context;
  let archive: ReturnType<typeof archiveInput>;
  try {
    archive = archiveInput(input);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { handled: true, blocker: blocked(error.message, {}, preflight) };
  }
  if (!archive) return { handled: false, blocker: null };
  const dirtyEntries = await getRichDirtyStatus(entry.path);
  const unsupportedEntry = dirtyEntries.find((dirtyEntry) => dirtyEntry.status !== "??" || dirtyEntry.sourcePath !== undefined);
  if (unsupportedEntry) {
    return {
      handled: true,
      blocker: blocked("archive-backed worktree cleanup supports only untracked and ignored paths", {
        dirtyPath: unsupportedEntry.path,
        dirtyStatus: unsupportedEntry.status,
        targetPath: entry.path,
      }, preflight),
    };
  }
  const paths = [...new Set([...dirtyEntries.map((dirtyEntry) => dirtyEntry.path), ...ignoredFiles])].sort();
  try {
    const proof = await verifyArchivedPaths({ worktreePath: entry.path, ...archive, paths });
    preflight.archivePath = proof.archivePath;
    preflight.archiveSha256 = proof.archiveSha256;
    preflight.archivedPaths = proof.entries.map((entryProof) => entryProof.path);
    preflight.archivedPathProofs = proof.entries;
    preflight.archivedPathCount = proof.entries.length;
    return { handled: true, blocker: null };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { handled: true, blocker: blocked(errorMessage(error), { targetPath: entry.path }, preflight) };
  }
}

export async function applyArchivedPathsCleanup(context: ArchiveRuntimeContext): Promise<Record<string, unknown> | null> {
  const { input, preflight, entry } = context;
  const paths = archivedPaths(preflight);
  if (paths.length === 0) return null;
  let archive: ReturnType<typeof archiveInput>;
  try {
    archive = archiveInput(input);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return blocked(error.message, {}, preflight);
  }
  if (!archive) return blocked("archive-backed cleanup lost its archive input", {}, preflight);
  const expectedEntries = parseArchivedPathFingerprints(preflight.archivedPathProofs) ?? [];
  if (expectedEntries.length !== paths.length) return blocked("archive-backed cleanup lost its planned path proofs", {}, preflight);
  try {
    const dirtyEntries = await getRichDirtyStatus(entry.path);
    const unsupportedEntry = dirtyEntries.find((dirtyEntry) => dirtyEntry.status !== "??" || dirtyEntry.sourcePath !== undefined);
    if (unsupportedEntry) {
      return blocked("archive-backed worktree status changed outside the untracked and ignored evidence boundary", {
        dirtyPath: unsupportedEntry.path,
        dirtyStatus: unsupportedEntry.status,
        targetPath: entry.path,
      }, preflight);
    }
    const removal = await prepareArchivedPathRemoval({ worktreePath: entry.path, ...archive, paths, expectedEntries });
    preflight.archivePrivateCopyPath = removal.privateArchivePath;
    preflight.cleanedArchivedPaths = removal.proof.entries.map((entryProof) => entryProof.path);
    preflight.cleanedArchivedPathCount = removal.proof.entries.length;
    await context.afterArchivedPathsQuarantined?.();
    const remainingDirtyFiles = await getDirtyFiles(entry.path);
    const remainingIgnoredFiles = await getIgnoredFiles(entry.path);
    if (remainingDirtyFiles.length > 0 || remainingIgnoredFiles.length > 0) {
      preflight.remainingDirtyFiles = remainingDirtyFiles;
      preflight.remainingIgnoredFiles = remainingIgnoredFiles;
      await rollbackArchivedPathRemoval(removal);
      delete preflight.archivePrivateCopyPath;
      return blocked("archive-backed cleanup left uncommitted or ignored paths", { targetPath: entry.path }, preflight);
    }
    try {
      await finalizeArchivedPathRemoval(removal);
      delete preflight.archivePrivateCopyPath;
      return null;
    } catch (error) {
      await rollbackArchivedPathRemoval(removal);
      delete preflight.archivePrivateCopyPath;
      throw error;
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return blocked(errorMessage(error), { targetPath: entry.path }, preflight);
  }
}
