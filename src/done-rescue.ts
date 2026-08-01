import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { collectDeleteFingerprint, collectIgnoredFileFingerprint } from "./deletion-fingerprint.ts";
import type { DeletionFingerprintEntry } from "./deletion-fingerprint.ts";
import { buildDirtySessionCommitCandidate } from "./done-land-clean-commit.ts";
import { dirtySnapshotFromEntries, statusEntries } from "./done-primary-snapshot.ts";
import type { DirtySnapshot, StatusEntry } from "./done-primary-snapshot.ts";
import { isEnoent, isSameOrInside } from "./filesystem-boundaries.ts";
import { buildSafetyRef, createRef, getCommonGitDir, getHeadCommit, getRefCommit, runGit, withGitArtifactSandbox } from "./git.ts";
import { assertReferenceTransactionHookSafe, ReferenceTransactionHookPolicyError } from "./git-process.ts";
import type { GuardianConfig } from "./types.ts";

const RESCUE_IDENTITY = {
  GIT_AUTHOR_NAME: "guardian-rescue",
  GIT_AUTHOR_EMAIL: "guardian-rescue@localhost",
  GIT_COMMITTER_NAME: "guardian-rescue",
  GIT_COMMITTER_EMAIL: "guardian-rescue@localhost",
} as const;

const RESCUE_ACTION = "guardian-done-rescue";
const RESCUE_VERSION = 1;

type BoundPathFingerprint = {
  readonly path: string;
  readonly fingerprint: readonly DeletionFingerprintEntry[];
};

type RescuePreflight = {
  readonly repoRoot: string;
  readonly commonGitDir: string;
  readonly worktree: string;
  readonly head: string;
  readonly entries: readonly StatusEntry[];
  readonly snapshot: DirtySnapshot;
  readonly paths: readonly string[];
  readonly pathFingerprints: readonly BoundPathFingerprint[];
  readonly ignoredFiles: readonly string[];
  readonly ignoredFileFingerprint: readonly DeletionFingerprintEntry[];
  readonly sourceIndexTree: string;
  readonly candidateTree: string;
  readonly timestamp: unknown;
  readonly rescueRef: string;
  readonly safetyOptions: { readonly ignoredResiduePolicy: "block"; readonly rescue: true };
};

type RescueContext = {
  readonly repoRoot: string;
  readonly worktree: string;
  readonly input: Record<string, unknown>;
};

type RescueRequest = RescueContext & {
  readonly config: GuardianConfig;
  readonly mode: "plan" | "apply";
};

function compareEntries(left: StatusEntry, right: StatusEntry): number {
  const leftKey = `${left.status}\0${left.path}\0${left.sourcePath ?? ""}`;
  const rightKey = `${right.status}\0${right.path}\0${right.sourcePath ?? ""}`;
  return leftKey.localeCompare(rightKey);
}

function rescueTimestamp(input: Record<string, unknown>, head: string): unknown {
  return input.timestamp ?? head;
}

function blocked(reason: string, details: Record<string, unknown>): Record<string, unknown> {
  return { ok: false, status: "blocked", lane: "rescue", reason, ...details };
}

async function canonicalPath(value: string): Promise<string> {
  return fs.realpath(value);
}

async function collectBoundPathFingerprint(worktree: string, relativePath: string): Promise<BoundPathFingerprint> {
  const absolutePath = path.resolve(worktree, relativePath);
  if (!isSameOrInside(absolutePath, worktree)) throw new Error(`rescue path is outside worktree: ${relativePath}`);
  try {
    return { path: relativePath, fingerprint: await collectDeleteFingerprint(worktree, absolutePath) };
  } catch (error) {
    if (isEnoent(error)) return { path: relativePath, fingerprint: [{ path: relativePath, kind: "missing" }] };
    throw error;
  }
}

async function ordinaryUntrackedPath(worktree: string, entry: StatusEntry): Promise<string | null> {
  if (entry.status !== "??") return null;
  const absolutePath = path.resolve(worktree, entry.path);
  if (!isSameOrInside(absolutePath, worktree)) return `untracked path is outside the rescue worktree: ${entry.path}`;
  try {
    return (await fs.lstat(absolutePath)).isFile() ? null : `rescue only removes ordinary untracked files: ${entry.path}`;
  } catch (error) {
    if (isEnoent(error)) return `untracked path disappeared during rescue planning: ${entry.path}`;
    throw error;
  }
}

async function rescuePreflight(context: RescueContext): Promise<{ readonly ok: true; readonly value: RescuePreflight } | { readonly ok: false; readonly result: Record<string, unknown> }> {
  const [repoRoot, worktree] = await Promise.all([canonicalPath(context.repoRoot), canonicalPath(context.worktree)]);
  const [head, commonGitDir] = await Promise.all([getHeadCommit(worktree), getCommonGitDir(worktree).then(canonicalPath)]);
  try {
    await assertReferenceTransactionHookSafe(worktree);
  } catch (error) {
    if (!(error instanceof ReferenceTransactionHookPolicyError)) throw error;
    return { ok: false, result: blocked(error.message, { repoRoot, commonGitDir, worktree }) };
  }
  return withGitArtifactSandbox(worktree, async (artifactSandbox) => {
    const entries = await statusEntries(worktree, { includeIgnored: true, artifactSandbox });
    const ignoredFiles = entries.filter((entry) => entry.status === "!!").map((entry) => entry.path).sort((left, right) => left.localeCompare(right));
    const ignoredFileFingerprint = await collectIgnoredFileFingerprint(worktree, ignoredFiles);
    if (ignoredFiles.length > 0) {
      return { ok: false, result: blocked("worktree has ignored files; rescue refuses to capture or clean ignored residue", { repoRoot, commonGitDir, worktree, ignoredFiles, ignoredFileFingerprint }) };
    }
    const trackedEntries = entries.filter((entry) => entry.status !== "!!").sort(compareEntries);
    if (trackedEntries.length === 0) {
      return { ok: false, result: { ok: true, status: "rescue-noop", lane: "rescue", repoRoot, commonGitDir, worktree, rescuedFileCount: 0, message: "nothing to rescue; worktree is already clean" } };
    }
    for (const entry of trackedEntries) {
      const untrackedError = await ordinaryUntrackedPath(worktree, entry);
      if (untrackedError) return { ok: false, result: blocked(untrackedError, { repoRoot, commonGitDir, worktree, entries: trackedEntries }) };
    }
    const paths = [...new Set(trackedEntries.flatMap((entry) => [entry.path, entry.sourcePath].filter((value): value is string => typeof value === "string" && value.length > 0)))].sort((left, right) => left.localeCompare(right));
    const [snapshot, pathFingerprints, candidate] = await Promise.all([
      dirtySnapshotFromEntries(worktree, trackedEntries),
      Promise.all(paths.map((filePath) => collectBoundPathFingerprint(worktree, filePath))),
      buildDirtySessionCommitCandidate(worktree, paths, { artifactSandbox }),
    ]);
    const timestamp = rescueTimestamp(context.input, head);
    const rescueRef = buildSafetyRef("rescue", path.basename(worktree), timestamp);
    return {
      ok: true,
      value: {
        repoRoot,
        commonGitDir,
        worktree,
        head,
        entries: trackedEntries,
        snapshot,
        paths,
        pathFingerprints,
        ignoredFiles,
        ignoredFileFingerprint,
        sourceIndexTree: candidate.sourceIndexTree,
        candidateTree: candidate.candidateTree,
        timestamp,
        rescueRef,
        safetyOptions: { rescue: true, ignoredResiduePolicy: "block" },
      },
    };
  });
}

function rescueConfirmToken(preflight: RescuePreflight): string {
  const material = {
    action: RESCUE_ACTION,
    version: RESCUE_VERSION,
    repoRoot: preflight.repoRoot,
    commonGitDir: preflight.commonGitDir,
    worktree: preflight.worktree,
    head: preflight.head,
    entries: preflight.entries.map((entry) => ({ status: entry.status, path: entry.path, ...(entry.sourcePath ? { sourcePath: entry.sourcePath } : {}) })),
    paths: preflight.paths,
    snapshot: preflight.snapshot,
    pathFingerprints: preflight.pathFingerprints,
    ignoredFiles: preflight.ignoredFiles,
    ignoredFileFingerprint: preflight.ignoredFileFingerprint,
    sourceIndexTree: preflight.sourceIndexTree,
    candidateTree: preflight.candidateTree,
    timestamp: preflight.timestamp,
    rescueRef: preflight.rescueRef,
    safetyOptions: preflight.safetyOptions,
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

function rescuePlan(preflight: RescuePreflight, confirmToken: string): Record<string, unknown> {
  return {
    ok: true,
    status: "rescue-planned",
    lane: "rescue",
    action: RESCUE_ACTION,
    version: RESCUE_VERSION,
    repoRoot: preflight.repoRoot,
    commonGitDir: preflight.commonGitDir,
    worktree: preflight.worktree,
    head: preflight.head,
    rescueRef: preflight.rescueRef,
    recoveryRef: preflight.rescueRef,
    timestamp: preflight.timestamp,
    paths: preflight.paths,
    entries: preflight.entries,
    pathFingerprints: preflight.pathFingerprints,
    ignoredFiles: preflight.ignoredFiles,
    ignoredFileFingerprint: preflight.ignoredFileFingerprint,
    sourceIndexTree: preflight.sourceIndexTree,
    candidateTree: preflight.candidateTree,
    safetyOptions: preflight.safetyOptions,
    confirmToken,
  };
}

async function cleanupBoundPaths(preflight: RescuePreflight): Promise<void> {
  const trackedPaths = preflight.entries.filter((entry) => entry.status !== "??").flatMap((entry) => [entry.path, entry.sourcePath].filter((value): value is string => typeof value === "string" && value.length > 0));
  const untrackedPaths = preflight.entries.filter((entry) => entry.status === "??").map((entry) => entry.path);
  if (trackedPaths.length > 0) await runGit(preflight.worktree, ["--literal-pathspecs", "restore", "--source", preflight.head, "--staged", "--worktree", "--", ...trackedPaths]);
  for (const filePath of untrackedPaths) await fs.rm(path.join(preflight.worktree, filePath), { force: false });
}

export async function rescueDirtyWorktree(request: RescueRequest): Promise<Record<string, unknown>> {
  const preflight = await rescuePreflight(request);
  if (!preflight.ok) return preflight.result;
  const token = rescueConfirmToken(preflight.value);
  if (request.mode === "plan") return rescuePlan(preflight.value, token);
  if (request.input.confirmToken !== token) return blocked("rescue confirm token mismatch; rerun guardian_done rescue=true mode=plan", { repoRoot: preflight.value.repoRoot, worktree: preflight.value.worktree });
  if (request.input.confirm !== true) return blocked("guardian_done rescue apply requires confirm=true", { repoRoot: preflight.value.repoRoot, worktree: preflight.value.worktree, confirmToken: token });
  const targetCandidate = await buildDirtySessionCommitCandidate(preflight.value.worktree, preflight.value.paths);
  if (targetCandidate.sourceIndexTree !== preflight.value.sourceIndexTree || targetCandidate.candidateTree !== preflight.value.candidateTree) {
    return blocked("rescue target candidate differs from the isolated approved plan", { repoRoot: preflight.value.repoRoot, worktree: preflight.value.worktree });
  }
  const recoveryCommit = (await runGit(preflight.value.worktree, ["commit-tree", targetCandidate.candidateTree, "-p", preflight.value.head, "-m", `guardian-rescue backup for ${preflight.value.worktree}`], { env: RESCUE_IDENTITY })).stdout;
  try {
    await createRef(preflight.value.repoRoot, preflight.value.rescueRef, recoveryCommit);
  } catch (error) {
    return blocked("rescue recovery ref could not be created; refusing cleanup", {
      repoRoot: preflight.value.repoRoot,
      worktree: preflight.value.worktree,
      rescueRef: preflight.value.rescueRef,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if ((await getRefCommit(preflight.value.repoRoot, preflight.value.rescueRef)) !== recoveryCommit) {
    return blocked("rescue recovery ref verification failed; refusing cleanup", { repoRoot: preflight.value.repoRoot, worktree: preflight.value.worktree, rescueRef: preflight.value.rescueRef });
  }
  await cleanupBoundPaths(preflight.value);
  return {
    ok: true,
    status: "rescued",
    lane: "rescue",
    action: RESCUE_ACTION,
    version: RESCUE_VERSION,
    repoRoot: preflight.value.repoRoot,
    commonGitDir: preflight.value.commonGitDir,
    worktree: preflight.value.worktree,
    head: preflight.value.head,
    rescueRef: preflight.value.rescueRef,
    recoveryRef: preflight.value.rescueRef,
    recoveryCommit,
    rescuedFiles: preflight.value.paths,
    rescuedFileCount: preflight.value.paths.length,
    message: "dirty out-of-lane work was captured in a create-only rescue ref and only bound paths were restored or removed",
  };
}
