import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const sha256Pattern = /^[0-9a-f]{64}$/;

export class ArchivedPathProofError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchivedPathProofError";
  }
}

export type ArchivedPathFingerprint =
  | { readonly path: string; readonly kind: "file"; readonly mode: number; readonly size: number; readonly sha256: string }
  | { readonly path: string; readonly kind: "symlink"; readonly target: string };

export type ArchivedPathProof = {
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly entries: readonly ArchivedPathFingerprint[];
};

type VerifyArchivedPathsInput = {
  readonly worktreePath: string;
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly paths: readonly string[];
};

function isSameOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || relative.length > 0 && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function normalizeArchivedPath(value: string): string {
  if (value.length === 0 || value.includes("\0") || value.includes("\n") || value.includes("\r") || value.includes("\\")) {
    throw new ArchivedPathProofError(`archive member path is malformed: ${JSON.stringify(value)}`);
  }
  const normalized = path.posix.normalize(value);
  if (path.posix.isAbsolute(value) || normalized !== value || value === "." || value === ".." || value.startsWith("../")) {
    throw new ArchivedPathProofError(`archive member path escapes the worktree: ${value}`);
  }
  return value;
}

async function fileSHA256(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = createReadStream(filePath);
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function runTar(args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("tar", [...args], { maxBuffer: 16 * 1024 * 1024 }, (error) => {
      if (error) reject(new ArchivedPathProofError(`archive extraction failed: ${error.message}`));
      else resolve();
    });
  });
}

async function fingerprint(root: string, relativePath: string): Promise<ArchivedPathFingerprint> {
  const absolutePath = path.join(root, relativePath);
  const stats = await fs.lstat(absolutePath);
  if (stats.isSymbolicLink()) return { path: relativePath, kind: "symlink", target: await fs.readlink(absolutePath) };
  if (!stats.isFile()) throw new ArchivedPathProofError(`archive-backed paths must be regular files or symlinks: ${relativePath}`);
  return {
    path: relativePath,
    kind: "file",
    mode: stats.mode & 0o777,
    size: stats.size,
    sha256: await fileSHA256(absolutePath),
  };
}

export async function verifyArchivedPaths(input: VerifyArchivedPathsInput): Promise<ArchivedPathProof> {
  if (!path.isAbsolute(input.archivePath)) throw new ArchivedPathProofError("archivePath must be absolute");
  if (!sha256Pattern.test(input.archiveSha256)) throw new ArchivedPathProofError("archiveSha256 must be an exact lowercase SHA-256 digest");
  const worktreePath = await fs.realpath(input.worktreePath);
  const archiveStats = await fs.lstat(input.archivePath);
  if (!archiveStats.isFile() || archiveStats.isSymbolicLink()) throw new ArchivedPathProofError("archivePath must resolve directly to a regular file");
  const archivePath = await fs.realpath(input.archivePath);
  if (isSameOrInside(archivePath, worktreePath)) throw new ArchivedPathProofError("archivePath must be outside the target worktree");
  const paths = [...new Set(input.paths.map(normalizeArchivedPath))].sort();
  if (paths.length === 0) throw new ArchivedPathProofError("archive-backed deletion requires at least one path");
  const initialArchiveSha256 = await fileSHA256(archivePath);
  if (initialArchiveSha256 !== input.archiveSha256) throw new ArchivedPathProofError("archive SHA-256 does not match archiveSha256");
  const extractionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-archive-proof-"));
  try {
    await runTar(["-xpzf", archivePath, "-C", extractionRoot, "--", ...paths]);
    const currentEntries = await Promise.all(paths.map((relativePath) => fingerprint(worktreePath, relativePath)));
    const archivedEntries = await Promise.all(paths.map((relativePath) => fingerprint(extractionRoot, relativePath)));
    if (JSON.stringify(currentEntries) !== JSON.stringify(archivedEntries)) {
      throw new ArchivedPathProofError("archive contents do not exactly match the target worktree paths");
    }
    const finalArchiveSha256 = await fileSHA256(archivePath);
    if (finalArchiveSha256 !== initialArchiveSha256) throw new ArchivedPathProofError("archive changed during verification");
    return { archivePath, archiveSha256: finalArchiveSha256, entries: currentEntries };
  } finally {
    await fs.rm(extractionRoot, { recursive: true, force: true });
  }
}

export async function removeArchivedPaths(worktreePath: string, entries: readonly ArchivedPathFingerprint[]): Promise<void> {
  for (const entry of entries) await fs.rm(path.join(worktreePath, entry.path));
}
