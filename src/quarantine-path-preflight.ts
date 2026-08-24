import fs from "node:fs/promises";
import path from "node:path";
import { collectCleanupFingerprint } from "./deletion-fingerprint.ts";
import type { DeletionFingerprintEntry } from "./deletion-fingerprint.ts";
import { isSameOrInside, lstatOrMissing, normalizeRelativePath, parseNullSeparated, relativePath } from "./filesystem-boundaries.ts";
import { getCommonGitDir, getRepoRoot, listWorktrees, runGit, tryGit } from "./git.ts";
import { canonicalPath } from "./plugin/canonical-path.ts";
import { protectedPathMatch, protectedPathsFromConfig } from "./protected-paths.ts";
import { getGuardianPaths, readState } from "./state.ts";
import { resolveSessionWorktree, validateOwnedSession } from "./session/worktree-binding.ts";
import type { GuardianConfig, GuardianSession, WorktreeEntry } from "./types.ts";

export type QuarantinePathKind = "directory" | "file" | "missing" | "other" | "symlink";
export type QuarantinePathBlocker = { readonly fatal: true; readonly reason: string };
export type QuarantinePathPreflightFilesystem = {
  readonly deviceId?: (candidate: string) => Promise<number>;
  readonly sourceKind?: (candidate: string) => Promise<QuarantinePathKind | null>;
};
export type QuarantinePathPreflightInput = {
  readonly action: "quarantine" | "restore";
  readonly artifactRelativePath: string;
  readonly config: GuardianConfig;
  readonly expectedFingerprint?: readonly DeletionFingerprintEntry[];
  readonly filesystem?: QuarantinePathPreflightFilesystem;
  readonly metadataRoot: string;
  readonly originalRelativePath?: string;
  readonly originalWorktreePath?: string;
  readonly repoRoot: string;
  readonly session: GuardianSession;
  readonly sourcePath?: string;
  readonly targetWorktreePath?: string;
};
export type QuarantinePathPreflight = {
  readonly action: QuarantinePathPreflightInput["action"];
  readonly blockers: readonly QuarantinePathBlocker[];
  readonly facts: {
    readonly commonGitDir: string | null;
    readonly destination: { readonly deviceId: number | null; readonly path: string };
    readonly metadataRoot: string | null;
    readonly repoRoot: string | null;
    readonly sessionBinding: "invalid" | "unverified" | "valid";
    readonly source: { readonly deviceId: number | null; readonly fingerprint: readonly DeletionFingerprintEntry[]; readonly kind: QuarantinePathKind; readonly path: string; readonly relativePath: string | null };
    readonly worktreePath: string | null;
  };
  readonly ok: boolean;
};

function pathKind(stat: Awaited<ReturnType<typeof lstatOrMissing>>): QuarantinePathKind {
  if (!stat) return "missing";
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return "other";
}

function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes("\0") || path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return normalized !== "." && normalized !== ".." && !normalized.startsWith(`..${path.sep}`);
}

async function inspectExistingAncestors(candidate: string, blockers: QuarantinePathBlocker[], label: string): Promise<string> {
  const resolved = path.resolve(candidate);
  const parts = path.relative(path.parse(resolved).root, resolved).split(path.sep).filter(Boolean);
  let current = path.parse(resolved).root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await lstatOrMissing(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) blockers.push({ fatal: true, reason: `${label} has a symlink ancestor: ${current}` });
  }
  return canonicalPath(resolved);
}

async function containsNestedGit(sourcePath: string): Promise<boolean> {
  const stat = await lstatOrMissing(sourcePath);
  if (!stat?.isDirectory()) return false;
  for (const child of await fs.readdir(sourcePath)) {
    if (child === ".git") return true;
    if (await containsNestedGit(path.join(sourcePath, child))) return true;
  }
  return false;
}

async function selectRestoreWorktree(input: QuarantinePathPreflightInput, repoRoot: string, commonGitDir: string, blockers: QuarantinePathBlocker[]): Promise<string | null> {
  const requested = input.targetWorktreePath ?? input.originalWorktreePath;
  if (!requested) {
    blockers.push({ fatal: true, reason: "restore requires an original worktree or explicit target worktree selection" });
    return null;
  }
  const canonicalRequested = await canonicalPath(requested);
  if (input.targetWorktreePath === undefined && typeof input.session.worktree_path === "string" && canonicalRequested !== await canonicalPath(input.session.worktree_path)) {
    blockers.push({ fatal: true, reason: "original worktree does not match the recorded session binding" });
    return null;
  }
  const entries = await listWorktrees(repoRoot);
  const matching: WorktreeEntry[] = [];
  for (const entry of entries) {
    if (await canonicalPath(entry.path) === canonicalRequested) matching.push(entry);
  }
  if (matching.length !== 1) {
    blockers.push({ fatal: true, reason: input.targetWorktreePath ? "restore target is not a registered Git worktree" : "original worktree is absent; explicit target worktree selection is required" });
    return null;
  }
  const targetGitDir = await tryGit(canonicalRequested, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  if (!targetGitDir.ok) {
    blockers.push({ fatal: true, reason: "restore target Git identity could not be verified" });
    return null;
  }
  if (await canonicalPath(targetGitDir.stdout) === commonGitDir) {
    blockers.push({ fatal: true, reason: "restore target is the primary repository worktree" });
    return null;
  }
  const entry = matching[0];
  if (!entry || entry.detached || !entry.branch) {
    blockers.push({ fatal: true, reason: "restore target is detached" });
    return null;
  }
  if (input.config.protectedBranches.includes(entry.branch)) {
    blockers.push({ fatal: true, reason: "restore target is on a protected branch" });
    return null;
  }
  if (await canonicalPath(await getCommonGitDir(canonicalRequested)) !== commonGitDir) {
    blockers.push({ fatal: true, reason: "restore target belongs to a different common Git directory" });
    return null;
  }
  return canonicalRequested;
}

async function nearestExistingParent(candidate: string): Promise<string> {
  let current = path.dirname(candidate);
  while (!(await lstatOrMissing(current))) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export async function buildQuarantinePathPreflight(input: QuarantinePathPreflightInput): Promise<QuarantinePathPreflight> {
  const blockers: QuarantinePathBlocker[] = [];
  const facts: {
    commonGitDir: string | null;
    destination: { deviceId: number | null; path: string };
    metadataRoot: string | null;
    repoRoot: string | null;
    sessionBinding: "invalid" | "unverified" | "valid";
    source: { deviceId: number | null; fingerprint: readonly DeletionFingerprintEntry[]; kind: QuarantinePathKind; path: string; relativePath: string | null };
    worktreePath: string | null;
  } = {
    commonGitDir: null,
    destination: { deviceId: null, path: path.resolve(input.metadataRoot, input.artifactRelativePath) },
    metadataRoot: null,
    repoRoot: null,
    sessionBinding: "unverified",
    source: { deviceId: null, fingerprint: [], kind: "missing", path: input.sourcePath ? path.resolve(input.sourcePath) : path.resolve(input.metadataRoot, input.artifactRelativePath), relativePath: null },
    worktreePath: null,
  };
  try {
    const repoRoot = await canonicalPath(await getRepoRoot(input.repoRoot));
    const commonGitDir = await canonicalPath(await getCommonGitDir(repoRoot));
    facts.repoRoot = repoRoot;
    facts.commonGitDir = commonGitDir;
    const metadataRoot = await inspectExistingAncestors(input.metadataRoot, blockers, "metadata root");
    facts.metadataRoot = metadataRoot;
    if (!isSafeRelativePath(input.artifactRelativePath) || !isSameOrInside(metadataRoot, commonGitDir)) blockers.push({ fatal: true, reason: "metadata root or artifact path escapes the common Git directory" });

    const sessionPath = typeof input.session.worktree_path === "string" ? await inspectExistingAncestors(input.session.worktree_path, blockers, "session worktree") : null;
    facts.worktreePath = sessionPath;
    const sessionId = typeof input.session.session_id === "string" ? input.session.session_id : "";
    const actualWorktree = typeof input.session.worktree_path === "string" ? input.session.worktree_path : repoRoot;
    const resolved = await resolveSessionWorktree({ repoRoot, cwd: repoRoot, sessionId, actualWorktree, config: input.config, validateBinding: input.action === "quarantine" });
    if (!resolved.ok && input.action === "quarantine") {
      facts.sessionBinding = "invalid";
      blockers.push({ fatal: true, reason: resolved.reason ?? "session worktree binding is invalid" });
    }
    if (input.action === "quarantine") {
      const binding = await validateOwnedSession(repoRoot, input.config, input.session);
      if (!binding.ok) {
        facts.sessionBinding = "invalid";
        blockers.push({ fatal: true, reason: binding.reason ?? "session worktree binding is invalid" });
      } else facts.sessionBinding = "valid";
    }

    const worktreePath = input.action === "restore" ? await selectRestoreWorktree(input, repoRoot, commonGitDir, blockers) : sessionPath;
    facts.worktreePath = worktreePath;
    if (!worktreePath) return { action: input.action, blockers, facts, ok: false };
    if (input.action === "restore" && (!input.originalRelativePath || !isSafeRelativePath(input.originalRelativePath))) blockers.push({ fatal: true, reason: "restore path is not a safe recorded relative path" });
    const sourcePath = input.action === "quarantine" ? input.sourcePath : path.resolve(metadataRoot, input.artifactRelativePath);
    if (!sourcePath) {
      blockers.push({ fatal: true, reason: "quarantine source path is required" });
      return { action: input.action, blockers, facts, ok: false };
    }
    const canonicalSource = await inspectExistingAncestors(sourcePath, blockers, "source path");
    facts.source.path = canonicalSource;
    const sourceRoot = input.action === "quarantine" ? worktreePath : metadataRoot;
    if (!isSameOrInside(canonicalSource, sourceRoot)) blockers.push({ fatal: true, reason: "source path escapes its protected root" });
    if (input.action === "quarantine" && canonicalSource === sourceRoot) blockers.push({ fatal: true, reason: "source overlaps a registered worktree" });
    const stat = await lstatOrMissing(sourcePath);
    facts.source.kind = await input.filesystem?.sourceKind?.(sourcePath) ?? pathKind(stat);
    facts.source.relativePath = isSameOrInside(canonicalSource, sourceRoot) ? normalizeRelativePath(relativePath(sourceRoot, canonicalSource)) : null;
    if (facts.source.kind === "missing") blockers.push({ fatal: true, reason: "source path is missing" });
    if (facts.source.kind !== "file" && facts.source.kind !== "directory") blockers.push({ fatal: true, reason: `unsupported source kind: ${facts.source.kind}` });

    const destination = input.action === "quarantine" ? path.resolve(metadataRoot, input.artifactRelativePath) : path.resolve(worktreePath, input.originalRelativePath ?? "");
    facts.destination = { deviceId: null, path: destination };
    const canonicalDestination = await inspectExistingAncestors(destination, blockers, "destination path");
    if (!isSameOrInside(canonicalDestination, input.action === "quarantine" ? metadataRoot : worktreePath)) blockers.push({ fatal: true, reason: "destination path escapes its validated root" });
    if (await lstatOrMissing(destination)) blockers.push({ fatal: true, reason: "destination already exists" });
    const destinationParent = await nearestExistingParent(destination);
    const deviceId = input.filesystem?.deviceId ?? (async (candidate: string) => (await fs.stat(candidate)).dev);
    const [sourceDevice, destinationDevice] = await Promise.all([deviceId(sourcePath), deviceId(destinationParent)]);
    facts.source = { ...facts.source, deviceId: sourceDevice };
    facts.destination = { deviceId: destinationDevice, path: destination };
    if (sourceDevice !== destinationDevice) blockers.push({ fatal: true, reason: "EXDEV risk: source and destination are on different devices" });

    if (input.action === "quarantine" && facts.source.relativePath) {
      const protectedPath = protectedPathMatch(facts.source.relativePath, protectedPathsFromConfig(input.config));
      if (protectedPath || facts.source.relativePath === ".git" || facts.source.relativePath.startsWith(".git/")) blockers.push({ fatal: true, reason: protectedPath?.reason ?? "protected Git metadata path" });
      const tracked = parseNullSeparated((await runGit(worktreePath, ["ls-files", "-z", "--", facts.source.relativePath])).stdout);
      if (tracked.length > 0) blockers.push({ fatal: true, reason: "tracked source cannot be quarantined" });
      if (facts.source.kind === "directory" && await containsNestedGit(sourcePath)) blockers.push({ fatal: true, reason: "source contains a nested Git repository" });
      for (const entry of await listWorktrees(repoRoot)) {
        const canonicalEntry = await canonicalPath(entry.path);
        if (canonicalEntry !== worktreePath && isSameOrInside(canonicalEntry, canonicalSource)) blockers.push({ fatal: true, reason: "source overlaps a registered worktree" });
      }
      const state = await readState(await getGuardianPaths(repoRoot), { repoRoot, config: input.config });
      for (const session of Object.values(state.sessions)) {
        if (session.session_id === input.session.session_id || session.status !== "active" || typeof session.worktree_path !== "string") continue;
        const sessionWorktree = await canonicalPath(session.worktree_path);
        if (isSameOrInside(canonicalSource, sessionWorktree) || isSameOrInside(sessionWorktree, canonicalSource)) blockers.push({ fatal: true, reason: "active session bindings are ambiguous" });
      }
    }
    if (input.action === "restore" && facts.source.kind === "directory" && await containsNestedGit(sourcePath)) blockers.push({ fatal: true, reason: "source contains a nested Git repository" });
    if (facts.source.kind === "file" || facts.source.kind === "directory") facts.source = { ...facts.source, fingerprint: await collectCleanupFingerprint(sourceRoot, sourcePath) };
    if (input.expectedFingerprint && JSON.stringify(input.expectedFingerprint) !== JSON.stringify(facts.source.fingerprint)) blockers.push({ fatal: true, reason: "source fingerprint drift" });
  } catch (error) {
    blockers.push({ fatal: true, reason: error instanceof Error ? error.message : "path preflight failed" });
  }
  return { action: input.action, blockers, facts, ok: blockers.length === 0 };
}
