import { removeArchivedPaths, verifyArchivedPaths } from "./archived-paths.ts";
import { blocked, errorMessage } from "./delete-worktree-report.ts";
import { getDirtyFiles, getIgnoredFiles } from "./git.ts";
import type { WorktreeEntry } from "./types.ts";

type ArchiveRuntimeContext = {
  readonly input: Record<string, unknown>;
  readonly preflight: Record<string, unknown>;
  readonly entry: WorktreeEntry;
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
  dirtyFiles: readonly string[],
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
  const paths = [...new Set([...dirtyFiles, ...ignoredFiles])].sort();
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
  try {
    const proof = await verifyArchivedPaths({ worktreePath: entry.path, ...archive, paths });
    if (JSON.stringify(proof.entries) !== JSON.stringify(preflight.archivedPathProofs)) {
      return blocked("archive-backed path proof changed at deletion boundary", { targetPath: entry.path }, preflight);
    }
    await removeArchivedPaths(entry.path, proof.entries);
    preflight.cleanedArchivedPaths = proof.entries.map((entryProof) => entryProof.path);
    preflight.cleanedArchivedPathCount = proof.entries.length;
    const remainingDirtyFiles = await getDirtyFiles(entry.path);
    const remainingIgnoredFiles = await getIgnoredFiles(entry.path);
    if (remainingDirtyFiles.length === 0 && remainingIgnoredFiles.length === 0) return null;
    preflight.remainingDirtyFiles = remainingDirtyFiles;
    preflight.remainingIgnoredFiles = remainingIgnoredFiles;
    return blocked("archive-backed cleanup left uncommitted or ignored paths", { targetPath: entry.path }, preflight);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return blocked(errorMessage(error), { targetPath: entry.path }, preflight);
  }
}
