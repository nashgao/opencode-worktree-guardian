import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDeleteWorktree } from "../src/delete.ts";
import { guardianStatus } from "../src/recover.ts";
import { recordSession } from "../src/state.ts";
import { guardianStart } from "../src/tools.ts";
import type { GuardianSession, GuardianToolResult } from "../src/types.ts";
import { createRepoWithOrigin, git, seedSession } from "./helpers.ts";

export { assert, fs, path, test, DEFAULT_CONFIG, guardianDeleteWorktree, guardianStatus, recordSession, guardianStart, createRepoWithOrigin, git, seedSession };
export type { GuardianSession, GuardianToolResult };

export type DeleteResult = Record<string, unknown> & {
  ok: boolean;
  status: string;
  reason: string;
  confirmToken: string;
  safetyRef: string;
  branchDeleted: boolean;
  preflight: Record<string, unknown>;
  report: Record<string, unknown>;
};

export type StartedSession = GuardianSession & {
  readonly session_id: string;
  readonly branch: string;
  readonly worktree_path: string;
};

export type StartSuccess = GuardianToolResult & {
  readonly ok: true;
  readonly session: StartedSession;
};

export function assertStartSuccess(result: GuardianToolResult): asserts result is StartSuccess {
  assert.equal(result.ok, true);
  assert.equal(typeof result.session?.session_id, "string");
  assert.equal(typeof result.session?.branch, "string");
  assert.equal(typeof result.session?.worktree_path, "string");
}

export async function createGuardianWorktree(repo: string, sessionId: string, taskName = sessionId, branch = `guardian/${sessionId}`) {
  const result = await guardianStart({
    repoRoot: repo,
    cwd: repo,
    sessionId,
    taskName,
    branch,
    createWorktree: true,
    config: DEFAULT_CONFIG,
  });
  assertStartSuccess(result);
  return result;
}

export async function worktreePaths(repo: string) {
  const result = await git(repo, ["worktree", "list", "--porcelain"]);
  return result.stdout.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
}

export async function branchExists(repo: string, branch: string) {
  return git(repo, ["show-ref", "--verify", `refs/heads/${branch}`]).then(() => true, () => false);
}

export async function refExists(repo: string, ref: string) {
  return git(repo, ["show-ref", "--verify", ref]).then(() => true, () => false);
}

export async function advanceBase(repo: string, message: string, changes: readonly { readonly file: string; readonly content: string | null }[]) {
  for (const change of changes) {
    const filePath = path.join(repo, change.file);
    if (change.content === null) await fs.rm(filePath, { force: true });
    else await fs.writeFile(filePath, change.content);
  }
  await git(repo, ["add", "-A", "--", ...changes.map((change) => change.file)]);
  await git(repo, ["commit", "-m", message]);
  await git(repo, ["push", "origin", "main"]);
  return (await git(repo, ["rev-parse", "origin/main"])).stdout;
}

export async function deleteWorktree(input: Record<string, unknown>) {
  return guardianDeleteWorktree(input) as Promise<DeleteResult>;
}

export function assertNoExpectedToken(result: Record<string, unknown>) {
  assert.equal(Object.hasOwn(result, "expectedToken"), false);
  assert.equal(JSON.stringify(result).includes("expectedToken"), false);
}

export function findSession(status: Awaited<ReturnType<typeof guardianStatus>>, sessionId: string): GuardianSession {
  const session = status.sessions.find((candidate) => candidate.session_id === sessionId);
  assert.ok(session);
  return session;
}
