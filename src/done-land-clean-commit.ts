import { createSafetyRef, getHeadCommit, runGit } from "./git.ts";
import type { GitStashEntry } from "./git.ts";
import { errorMessage } from "./types.ts";

type DirtySessionCommitContext = {
  readonly repoRoot: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly input: {
    readonly timestamp?: unknown;
  };
};

type DirtySessionCommitPreflight = {
  readonly branch: string;
  readonly head: string;
  readonly dirtyFiles: readonly string[];
  readonly stashCount: number;
  readonly stashes: readonly GitStashEntry[];
};

type DirtySessionCommitResult =
  | {
      readonly ok: true;
      readonly head: string;
      readonly safetyRef: string;
    }
  | {
      readonly ok: false;
      readonly result: Record<string, unknown>;
    };

export async function commitDirtySessionWork(context: DirtySessionCommitContext, preflight: DirtySessionCommitPreflight, message: string): Promise<DirtySessionCommitResult> {
  const safetyRef = await createSafetyRef(context.repoRoot, {
    sessionId: context.sessionId,
    branch: preflight.branch,
    commit: preflight.head,
    timestamp: context.input.timestamp,
  });
  try {
    await runGit(context.cwd, ["add", "--all", "--", ...preflight.dirtyFiles]);
    await runGit(context.cwd, ["commit", "-m", message]);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
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
        error: errorMessage(error),
      },
    };
  }
  return { ok: true, head: await getHeadCommit(context.cwd), safetyRef };
}
