import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSafetyRef, createRef, getDirtyFiles, getHeadCommit, getRefCommit, runGit, tryGit } from "./git.ts";
import type { GuardianConfig } from "./types.ts";

const RESCUE_IDENTITY = {
  GIT_AUTHOR_NAME: "guardian-rescue",
  GIT_AUTHOR_EMAIL: "guardian-rescue@localhost",
  GIT_COMMITTER_NAME: "guardian-rescue",
  GIT_COMMITTER_EMAIL: "guardian-rescue@localhost",
};

async function removeUntracked(worktree: string): Promise<void> {
  const out = (await runGit(worktree, ["status", "--porcelain", "--untracked-files=normal"])).stdout;
  const paths = out.split("\n").filter((line) => line.startsWith("?? ")).map((line) => line.slice(3).replace(/\/$/, ""));
  for (const rel of paths) {
    if (rel.length > 0) await fs.rm(path.join(worktree, rel), { recursive: true, force: true });
  }
}

export async function rescueDirtyWorktree(worktree: string, _config: GuardianConfig, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const dirty = await getDirtyFiles(worktree);
  if (dirty.length === 0) {
    return { ok: true, status: "rescue-noop", lane: "rescue", worktree, rescuedFileCount: 0, message: "nothing to rescue; worktree is already clean" };
  }
  const head = await getHeadCommit(worktree);
  const tmpIndex = path.join(os.tmpdir(), `guardian-rescue-${crypto.randomUUID()}.index`);
  const env = { ...process.env, ...RESCUE_IDENTITY, GIT_INDEX_FILE: tmpIndex };
  try {
    await runGit(worktree, ["read-tree", head], { env });
    await runGit(worktree, ["add", "-A"], { env });
    const tree = (await runGit(worktree, ["write-tree"], { env })).stdout;
    const backupCommit = (await runGit(worktree, ["commit-tree", tree, "-p", head, "-m", `guardian-rescue backup for ${worktree}`], { env })).stdout;
    const captured = await tryGit(worktree, ["diff", "--quiet", head, backupCommit]);
    if (captured.ok) {
      return { ok: false, status: "blocked", lane: "rescue", worktree, rescuedFileCount: 0, reason: "rescue backup captured no changes; refusing to reset" };
    }
    const timestamp = typeof input.timestamp === "string" ? input.timestamp : undefined;
    const rescueRef = buildSafetyRef("rescue", path.basename(worktree), timestamp);
    await createRef(worktree, rescueRef, backupCommit);
    if ((await getRefCommit(worktree, rescueRef)) !== backupCommit) {
      return { ok: false, status: "blocked", lane: "rescue", worktree, rescueRef, reason: "rescue backup ref verification failed; refusing to reset" };
    }
    await runGit(worktree, ["read-tree", "-u", "--reset", head]);
    await removeUntracked(worktree);
    const remaining = await getDirtyFiles(worktree);
    return {
      ok: true,
      status: "rescued",
      lane: "rescue",
      worktree,
      head,
      rescueRef,
      backupCommit,
      recoveryRef: rescueRef,
      recoveryCommit: backupCommit,
      rescuedFiles: dirty,
      rescuedFileCount: dirty.length,
      stillDirtyFileCount: remaining.length,
      message: "dirty out-of-lane work backed up to a rescue ref; worktree reset to HEAD",
    };
  } finally {
    await fs.rm(tmpIndex, { force: true });
  }
}
