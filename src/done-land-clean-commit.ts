import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promoteGitArtifactSandboxTree, runGit, runGitWithInput, tryGit, withGitArtifactSandboxFromIndex } from "./git.ts";
import { runGitInArtifactSandbox, runGitNullSeparated, runGitNullSeparatedInArtifactSandbox } from "./git.ts";
import type { GitArtifactSandbox, GitStashEntry } from "./git.ts";
import { completeDirtyCommitSafetyRefReservation, reserveDirtyCommitSafetyRef, SafetyRefReservationPersistenceError } from "./state-dirty-commit-reservation.ts";
import { errorMessage } from "./types.ts";
import type { DirtyCommitSafetyRefReservation, GuardianConfig } from "./types.ts";

type DirtySessionCommitContext = {
  readonly repoRoot: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly config: GuardianConfig;
  readonly input: {
    readonly timestamp?: unknown;
    readonly confirmToken?: unknown;
  };
};

type DirtySessionCommitPreflight = {
  readonly branch: string;
  readonly head: string;
  readonly dirtyFiles: readonly string[];
  readonly sourceIndexTree: string;
  readonly candidateTree: string;
  readonly safetyRef: string;
  readonly stashCount: number;
  readonly stashes: readonly GitStashEntry[];
};

type DirtySessionCommitResult =
  | {
      readonly ok: true;
      readonly head: string;
      readonly safetyRef: string;
      readonly safetyRefDisposition: "created" | "reused";
    }
  | {
      readonly ok: false;
      readonly result: Record<string, unknown>;
    };

type CommitTransactionEvent = {
  readonly indexLockPath: string;
  readonly oldHead: string;
  readonly newHead: string;
};

type SafetyRefTransactionEvent = {
  readonly safetyRef: string;
  readonly expectedHead: string;
};

type BranchPublicationEvent = SafetyRefTransactionEvent & { readonly newHead: string };

export type DirtySessionCommitCandidate = { readonly sourceIndexTree: string; readonly candidateTree: string };

type DirtySessionCommitCandidateOptions = { readonly artifactSandbox?: GitArtifactSandbox };

export async function worktreeIndexPath(cwd: string): Promise<string> {
  return (await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout;
}

export function stagedPaths(records: readonly string[]): Set<string> {
  const paths = new Set<string>(); for (let index = 0; index < records.length;) {
    const status = records[index], firstPath = records[index + 1];
    if (status === undefined || firstPath === undefined) break; paths.add(firstPath); index += 2;
    if (status.startsWith("R") || status.startsWith("C")) {
      const secondPath = records[index]; if (secondPath === undefined) break; paths.add(secondPath); index += 1;
    }
  }
  return paths;
}

export async function buildDirtySessionCommitCandidate(cwd: string, dirtyFiles: readonly string[], options: DirtySessionCommitCandidateOptions = {}): Promise<DirtySessionCommitCandidate> {
  if (options.artifactSandbox) {
    const sandbox = options.artifactSandbox;
    const sourceIndexTree = (await runGitInArtifactSandbox(cwd, ["write-tree"], sandbox)).stdout;
    const cachedPaths = new Set(await runGitNullSeparatedInArtifactSandbox(cwd, ["--literal-pathspecs", "ls-files", "--cached", "-z", "--", ...dirtyFiles], sandbox));
    const staged = stagedPaths(await runGitNullSeparatedInArtifactSandbox(cwd, ["diff", "--cached", "--name-status", "-z", "--find-renames"], sandbox));
    const trackedPaths = dirtyFiles.filter((dirtyFile) => cachedPaths.has(dirtyFile));
    const candidatePaths = dirtyFiles.filter((dirtyFile) => !cachedPaths.has(dirtyFile) && !staged.has(dirtyFile));
    if (trackedPaths.length > 0) await runGitInArtifactSandbox(cwd, ["--literal-pathspecs", "add", "-u", "--", ...trackedPaths], sandbox);
    if (candidatePaths.length > 0) await runGitInArtifactSandbox(cwd, ["--literal-pathspecs", "add", "--", ...candidatePaths], sandbox);
    const candidateTree = (await runGitInArtifactSandbox(cwd, ["write-tree"], sandbox)).stdout;
    return { sourceIndexTree, candidateTree };
  }
  const sourceIndex = await worktreeIndexPath(cwd);
  const temporaryIndex = path.join(os.tmpdir(), `guardian-commit-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: temporaryIndex };
  try {
    await fs.copyFile(sourceIndex, temporaryIndex, constants.COPYFILE_EXCL);
    const sourceIndexTree = (await runGit(cwd, ["write-tree"], { env })).stdout;
    const cachedPaths = new Set(await runGitNullSeparated(cwd, ["--literal-pathspecs", "ls-files", "--cached", "-z", "--", ...dirtyFiles], { env }));
    const staged = stagedPaths(await runGitNullSeparated(cwd, ["diff", "--cached", "--name-status", "-z", "--find-renames"], { env }));
    const trackedPaths = dirtyFiles.filter((dirtyFile) => cachedPaths.has(dirtyFile));
    const candidatePaths = dirtyFiles.filter((dirtyFile) => !cachedPaths.has(dirtyFile) && !staged.has(dirtyFile));
    if (trackedPaths.length > 0) await runGit(cwd, ["--literal-pathspecs", "add", "-u", "--", ...trackedPaths], { env });
    if (candidatePaths.length > 0) await runGit(cwd, ["--literal-pathspecs", "add", "--", ...candidatePaths], { env });
    const candidateTree = (await runGit(cwd, ["write-tree"], { env })).stdout;
    return { sourceIndexTree, candidateTree };
  } finally {
    await fs.rm(temporaryIndex, { force: true });
    await fs.rm(`${temporaryIndex}.lock`, { force: true });
  }
}

export type CommitTransactionHooks = {
  readonly afterSafetyRefValidated?: (event: SafetyRefTransactionEvent) => Promise<void>;
  readonly afterSafetyRefCreated?: (event: SafetyRefTransactionEvent) => Promise<void>;
  readonly beforeBranchPublication?: (event: BranchPublicationEvent) => Promise<void>;
  readonly afterBranchUpdate?: (event: CommitTransactionEvent) => Promise<void>;
  readonly afterIndexInstall?: (event: CommitTransactionEvent) => Promise<void>;
};

type CommitTransactionPhase = "preparing-index" | "branch-published" | "index-installed";

export async function commitDirtySessionWork(context: DirtySessionCommitContext, preflight: DirtySessionCommitPreflight, message: string, hooks?: CommitTransactionHooks): Promise<DirtySessionCommitResult> {
  const safetyRef = preflight.safetyRef;
  const indexPath = await worktreeIndexPath(context.cwd);
  const indexLockPath = `${indexPath}.lock`;
  let ownsIndexLock = false;
  let phase: CommitTransactionPhase = "preparing-index";
  let newHead: string | null = null;
  let safetyRefDisposition: "created" | "reused" | null = null;
  let reservation: DirtyCommitSafetyRefReservation | null = null;
  try {
    await fs.copyFile(indexPath, indexLockPath, constants.COPYFILE_EXCL);
    ownsIndexLock = true;
    const indexEnv = { GIT_INDEX_FILE: indexLockPath };
    await withGitArtifactSandboxFromIndex(context.cwd, indexLockPath, async (artifactSandbox) => {
      const finalCandidate = await buildDirtySessionCommitCandidate(context.cwd, preflight.dirtyFiles, { artifactSandbox });
      if (finalCandidate.sourceIndexTree !== preflight.sourceIndexTree || finalCandidate.candidateTree !== preflight.candidateTree) throw new Error("worktree index changed after the approved plan");
      await promoteGitArtifactSandboxTree(context.cwd, artifactSandbox, preflight.candidateTree);
    });
    const currentSourceTree = (await runGit(context.cwd, ["write-tree"], { env: indexEnv })).stdout;
    if (currentSourceTree !== preflight.sourceIndexTree) throw new Error("worktree index changed after the approved plan");
    const reserved = await reserveDirtyCommitSafetyRef({ repoRoot: context.repoRoot, sessionId: context.sessionId, config: context.config, timestamp: context.input.timestamp, confirmToken: context.input.confirmToken, branch: preflight.branch, expectedHead: preflight.head, safetyRef: preflight.safetyRef }, { afterValidated: hooks?.afterSafetyRefValidated, afterCreated: hooks?.afterSafetyRefCreated });
    safetyRefDisposition = reserved.disposition;
    reservation = reserved.reservation;
    await runGit(context.cwd, ["read-tree", preflight.candidateTree], { env: indexEnv });
    const installedTree = (await runGit(context.cwd, ["write-tree"], { env: indexEnv })).stdout;
    if (installedTree !== preflight.candidateTree) throw new Error("approved candidate tree could not be installed in the worktree index");
    const lockHandle = await fs.open(indexLockPath, "r");
    try {
      await lockHandle.sync();
    } finally {
      await lockHandle.close();
    }
    newHead = (await runGit(context.cwd, ["commit-tree", preflight.candidateTree, "-p", preflight.head, "-m", message])).stdout;
    await hooks?.beforeBranchPublication?.({ safetyRef, expectedHead: preflight.head, newHead });
    await runGitWithInput(context.cwd, ["update-ref", "--stdin"], `start\noption no-deref\nverify ${safetyRef} ${preflight.head}\noption no-deref\nupdate refs/heads/${preflight.branch} ${newHead} ${preflight.head}\nprepare\ncommit\n`);
    phase = "branch-published";
    const event = { indexLockPath, oldHead: preflight.head, newHead };
    await hooks?.afterBranchUpdate?.(event);
    await fs.rename(indexLockPath, indexPath);
    ownsIndexLock = false;
    phase = "index-installed";
    await completeDirtyCommitSafetyRefReservation(context.repoRoot, context.config, reservation, newHead);
    await hooks?.afterIndexInstall?.(event);
    return { ok: true, head: newHead, safetyRef, safetyRefDisposition };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (error instanceof SafetyRefReservationPersistenceError) {
      return {
        ok: false,
        result: {
          ok: false,
          status: "partial",
          reason: "safety ref was created but its reservation could not be persisted",
          safetyRef: error.safetyRef,
          recoveryRequired: true,
          error: errorMessage(error.cause),
        },
      };
    }
    if (phase === "branch-published" && newHead) {
      const rollback = await tryGit(context.cwd, ["update-ref", "--no-deref", `refs/heads/${preflight.branch}`, preflight.head, newHead]);
      if (rollback.ok) {
        return {
          ok: false,
          result: {
            ok: false,
            status: "blocked",
            reason: "commit failed after branch publication; branch was restored",
            branch: preflight.branch,
            oldHead: preflight.head,
            newHead,
            rollback: "restored",
            transactionPhase: phase,
            dirtyFiles: preflight.dirtyFiles,
            stashCount: preflight.stashCount,
            stashes: preflight.stashes,
            safetyRef,
            error: errorMessage(error),
          },
        };
      }
      const current = await tryGit(context.cwd, ["rev-parse", "--verify", `refs/heads/${preflight.branch}`]);
      return {
        ok: false,
        result: {
          ok: false,
          status: "partial",
          reason: "commit failed after branch publication and branch rollback could not be proven",
          branch: preflight.branch,
          oldHead: preflight.head,
          newHead,
          currentHead: current.ok ? current.stdout : null,
          rollback: "conflicted",
          rollbackError: rollback.error.message,
          transactionPhase: phase,
          dirtyFiles: preflight.dirtyFiles,
          stashCount: preflight.stashCount,
          stashes: preflight.stashes,
          safetyRef,
          error: errorMessage(error),
        },
      };
    }
    if (phase === "index-installed" && newHead) {
      return {
        ok: false,
        result: {
          ok: false,
          status: "partial",
          reason: "commit completed index installation after branch publication but follow-up failed",
          branch: preflight.branch,
          oldHead: preflight.head,
          newHead,
          currentHead: newHead,
          rollback: "not-attempted",
          transactionPhase: phase,
          dirtyFiles: preflight.dirtyFiles,
          stashCount: preflight.stashCount,
          stashes: preflight.stashes,
          safetyRef,
          error: errorMessage(error),
        },
      };
    }
    return {
      ok: false,
      result: {
        ok: false,
        status: "blocked",
        reason: "commit failed",
        branch: preflight.branch,
        dirtyFiles: preflight.dirtyFiles,
        stashCount: preflight.stashCount,
        stashes: preflight.stashes,
        safetyRef,
        transactionPhase: phase,
        error: errorMessage(error),
      },
    };
  } finally {
    if (ownsIndexLock) await fs.rm(indexLockPath, { force: true });
  }
}
