import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { constants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const sha256Pattern = /^[0-9a-f]{64}$/;
const trustedTarCandidates = process.platform === "darwin" ? ["/usr/bin/bsdtar", "/usr/bin/tar"] : ["/usr/bin/tar", "/bin/tar"];

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

export function parseArchivedPathFingerprints(value: unknown): ArchivedPathFingerprint[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: ArchivedPathFingerprint[] = [];
  for (const proof of value) {
    if (typeof proof !== "object" || proof === null) return null;
    const proofPath = Reflect.get(proof, "path");
    const kind = Reflect.get(proof, "kind");
    if (typeof proofPath !== "string") return null;
    if (kind === "symlink") {
      const target = Reflect.get(proof, "target");
      if (typeof target !== "string") return null;
      parsed.push({ path: proofPath, kind, target });
      continue;
    }
    const mode = Reflect.get(proof, "mode");
    const size = Reflect.get(proof, "size");
    const sha256 = Reflect.get(proof, "sha256");
    if (kind !== "file" || typeof mode !== "number" || typeof size !== "number" || typeof sha256 !== "string") return null;
    parsed.push({ path: proofPath, kind, mode, size, sha256 });
  }
  return parsed;
}

type VerifyArchivedPathsInput = {
  readonly worktreePath: string;
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly paths: readonly string[];
};

type ArchiveMember = {
  readonly path: string;
  readonly type: "directory" | "file" | "symlink";
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

export async function archivedFileSHA256(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = createReadStream(filePath);
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function trustedTarPath(): Promise<string> {
  for (const candidate of trustedTarCandidates) {
    try {
      const stat = await fs.lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      await fs.access(candidate, constants.X_OK);
      return await fs.realpath(candidate);
    } catch (error) {
      if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") continue;
      throw error;
    }
  }
  throw new ArchivedPathProofError("trusted system tar executable is unavailable");
}

async function runTar(args: readonly string[]): Promise<string> {
  const executable = await trustedTarPath();
  return await new Promise<string>((resolve, reject) => {
    execFile(executable, [...args], { env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new ArchivedPathProofError(`archive extraction failed: ${error.message}`));
      else resolve(stdout);
    });
  });
}

function archiveMemberType(marker: string, memberPath: string): ArchiveMember["type"] {
  if (marker === "-") return "file";
  if (marker === "l") return "symlink";
  if (marker === "d") return "directory";
  if (marker === "h") throw new ArchivedPathProofError(`hardlink archive member is not allowed: ${memberPath}`);
  throw new ArchivedPathProofError(`unsupported archive member type ${JSON.stringify(marker)}: ${memberPath}`);
}

async function listArchiveMembers(archivePath: string): Promise<ArchiveMember[]> {
  const names = (await runTar(["-tzf", archivePath])).split("\n").filter(Boolean);
  const verbose = (await runTar(["-tvzf", archivePath])).split("\n").filter(Boolean);
  if (names.length !== verbose.length) throw new ArchivedPathProofError("archive member inventory is ambiguous");
  const members = names.map((rawName, index) => {
    const directoryName = rawName.endsWith("/") ? rawName.slice(0, -1) : rawName;
    const memberPath = normalizeArchivedPath(directoryName);
    const type = archiveMemberType(verbose[index]?.slice(0, 1) ?? "", memberPath);
    if (rawName.endsWith("/") !== (type === "directory")) throw new ArchivedPathProofError(`archive member type is ambiguous: ${memberPath}`);
    return { path: memberPath, type };
  });
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.path)) throw new ArchivedPathProofError(`duplicate archive member is not allowed: ${member.path}`);
    seen.add(member.path);
  }
  return members;
}

async function fingerprintArchivedPathAt(absolutePath: string, relativePath: string): Promise<ArchivedPathFingerprint> {
  const stats = await fs.lstat(absolutePath);
  if (stats.isSymbolicLink()) return { path: relativePath, kind: "symlink", target: await fs.readlink(absolutePath) };
  if (!stats.isFile()) throw new ArchivedPathProofError(`archive-backed paths must be regular files or symlinks: ${relativePath}`);
  if (stats.nlink !== 1) throw new ArchivedPathProofError(`archive-backed paths cannot preserve hardlink identity: ${relativePath}`);
  return {
    path: relativePath,
    kind: "file",
    mode: stats.mode & 0o7777,
    size: stats.size,
    sha256: await archivedFileSHA256(absolutePath),
  };
}

export function fingerprintArchivedPath(root: string, relativePath: string): Promise<ArchivedPathFingerprint> {
  return fingerprintArchivedPathAt(path.join(root, relativePath), relativePath);
}

async function verifyArchiveContents(input: VerifyArchivedPathsInput, archivePath: string, reportedArchivePath: string): Promise<ArchivedPathProof> {
  const initialArchiveSha256 = await archivedFileSHA256(archivePath);
  if (initialArchiveSha256 !== input.archiveSha256) throw new ArchivedPathProofError("archive SHA-256 does not match archiveSha256");
  const members = await listArchiveMembers(archivePath);
  const paths = [...new Set(input.paths.map(normalizeArchivedPath))].sort();
  if (paths.length === 0) throw new ArchivedPathProofError("archive-backed deletion requires at least one path");
  for (const requestedPath of paths) {
    const matches = members.filter((member) => member.path === requestedPath);
    if (matches.length !== 1 || matches[0]?.type === "directory") throw new ArchivedPathProofError(`archive is missing one recoverable file or symlink member: ${requestedPath}`);
  }
  const extractionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-archive-proof-"));
  try {
    await runTar(["-xpzf", archivePath, "-C", extractionRoot, "--", ...paths]);
    const currentEntries = await Promise.all(paths.map((relativePath) => fingerprintArchivedPath(input.worktreePath, relativePath)));
    const archivedEntries = await Promise.all(paths.map((relativePath) => fingerprintArchivedPath(extractionRoot, relativePath)));
    if (JSON.stringify(currentEntries) !== JSON.stringify(archivedEntries)) {
      throw new ArchivedPathProofError("archive contents do not exactly match the target worktree paths");
    }
    const finalArchiveSha256 = await archivedFileSHA256(archivePath);
    if (finalArchiveSha256 !== initialArchiveSha256) throw new ArchivedPathProofError("archive changed during verification");
    return { archivePath: reportedArchivePath, archiveSha256: finalArchiveSha256, entries: currentEntries };
  } finally {
    await fs.rm(extractionRoot, { recursive: true, force: true });
  }
}

export async function verifyArchivedPaths(input: VerifyArchivedPathsInput): Promise<ArchivedPathProof> {
  if (!path.isAbsolute(input.archivePath)) throw new ArchivedPathProofError("archivePath must be absolute");
  if (!sha256Pattern.test(input.archiveSha256)) throw new ArchivedPathProofError("archiveSha256 must be an exact lowercase SHA-256 digest");
  const worktreePath = await fs.realpath(input.worktreePath);
  const archiveStats = await fs.lstat(input.archivePath);
  if (!archiveStats.isFile() || archiveStats.isSymbolicLink()) throw new ArchivedPathProofError("archivePath must resolve directly to a regular file");
  const archivePath = await fs.realpath(input.archivePath);
  if (isSameOrInside(archivePath, worktreePath)) throw new ArchivedPathProofError("archivePath must be outside the target worktree");
  return verifyArchiveContents({ ...input, worktreePath }, archivePath, archivePath);
}

export async function verifyArchivedPathsFromPrivateCopy(input: VerifyArchivedPathsInput, privateArchivePath: string): Promise<ArchivedPathProof> {
  if (!sha256Pattern.test(input.archiveSha256)) throw new ArchivedPathProofError("archiveSha256 must be an exact lowercase SHA-256 digest");
  const worktreePath = await fs.realpath(input.worktreePath);
  return verifyArchiveContents({ ...input, worktreePath }, privateArchivePath, input.archivePath);
}
