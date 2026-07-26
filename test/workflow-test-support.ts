import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { createSafetyRef, deleteRemoteBranch } from "../src/git.ts";
import { guardianFinishWorkflow } from "../src/workflow.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

type WorkflowResult = {
  ok: boolean;
  status: string;
  reason?: string;
  confirmToken?: string;
  preflight: {
    candidateCount?: number;
    dirtyFileCount?: number;
    blockerCount?: number;
    baseRefOid?: string;
    maxCandidateCount?: number;
    candidateScanStatus?: "completed" | "skipped" | "failed";
    candidateScanSkippedReason?: "invalid-mode" | "base-unavailable" | "stash-blocker";
    candidateScanFailedReason?: "candidate-discovery-failed";
    blockers?: string[];
    stashCount?: number;
    stashes?: Array<Record<string, unknown>>;
  };
  candidates: Array<Record<string, unknown>>;
  blockers: Array<Record<string, unknown>>;
  finalPostflight?: Record<string, unknown>;
  results: Array<Record<string, unknown>>;
  remaining: Array<Record<string, unknown>>;
};

function workflowResult(result: Record<string, unknown>): WorkflowResult {
  return result as WorkflowResult;
}

async function createMergedBranch(repo: string, branch: string, fileName: string) {
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, fileName), `${branch}\n`);
  await git(repo, ["add", fileName]);
  await git(repo, ["commit", "-m", `add ${fileName}`]);
  await git(repo, ["checkout", "main"]);
  await git(repo, ["merge", "--no-ff", branch, "-m", `merge ${branch}`]);
  await git(repo, ["push", "origin", "main"]);
  const { stdout: head } = await git(repo, ["rev-parse", branch]);
  return head;
}

async function createUnmergedBranch(repo: string, branch: string, fileName: string) {
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, fileName), `${branch}\n`);
  await git(repo, ["add", fileName]);
  await git(repo, ["commit", "-m", `add ${fileName}`]);
  const { stdout: head } = await git(repo, ["rev-parse", branch]);
  await git(repo, ["checkout", "main"]);
  return head;
}

function branchExists(repo: string, branch: string) {
  return git(repo, ["rev-parse", "--verify", branch]).then(() => true, () => false);
}

function pathExists(filePath: string) {
  return fs.access(filePath).then(() => true, () => false);
}

async function remoteBranchExists(repo: string, branch: string) {
  const result = await git(repo, ["ls-remote", "--heads", "origin", branch]);
  return result.stdout.length > 0;
}

export {
  assert,
  branchExists,
  createMergedBranch,
  createRepoWithOrigin,
  createSafetyRef,
  createUnmergedBranch,
  DEFAULT_CONFIG,
  deleteRemoteBranch,
  fs,
  git,
  guardianFinishWorkflow,
  path,
  pathExists,
  remoteBranchExists,
  test,
  workflowResult,
};

export type { WorkflowResult };
