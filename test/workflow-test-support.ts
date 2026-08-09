import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { createSafetyRef, deleteRemoteBranch } from "../src/git.ts";
import { guardianFinishWorkflow } from "../src/workflow.ts";
import { createRepoWithOrigin, createTempDir, git } from "./helpers.ts";

const execFileAsync = promisify(execFile);

type WorkflowResult = {
  ok: boolean;
  status: string;
  lane?: string;
  reason?: string;
  confirmToken?: string;
  tokenMatched?: boolean;
  tokenChecked?: boolean;
  confirmationRequired?: boolean;
  remoteRefresh?: "skipped";
  driftDetected?: boolean;
  plannedConfirmToken?: string;
  refreshedConfirmToken?: string;
  nextAction?: string;
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
  reservationRetirementCandidates?: Array<Record<string, unknown>>;
  reservationRetirementResults?: Array<Record<string, unknown>>;
  freshPlanRequired?: boolean;
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

export async function doneAllCandidateSnapshot(repo: string, branch: string, worktreePath: string, candidateFile: string, childPlan: unknown) {
  const [remoteTrackingRefs, remoteTrackingReflog, fetchHead, objects, index, branchOid, candidateContent, state] = await Promise.all([
    git(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes"]),
    git(repo, ["reflog", "show", "--all", "--format=%gD %H"]),
    fs.readFile(path.join(repo, ".git", "FETCH_HEAD"), "utf8").then((contents) => contents, () => "<absent>"),
    git(repo, ["count-objects", "-v"]), git(repo, ["ls-files", "--stage"]), git(repo, ["rev-parse", branch]), fs.readFile(candidateFile, "utf8"),
    fs.readFile(path.join(repo, ".git", "opencode-guardian", "state.json"), "utf8").then((contents) => contents, () => "<absent>"),
  ]);
  return { remoteTrackingRefs: remoteTrackingRefs.stdout, remoteTrackingReflog: remoteTrackingReflog.stdout, fetchHead, objects: objects.stdout, index: index.stdout, state, childPlan: JSON.stringify(childPlan), branchOid: branchOid.stdout, candidateContent, worktreeExists: await pathExists(worktreePath) };
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

type TestLifecycle = {
  readonly after: (callback: () => void) => void;
};

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

export async function installMultiBranchFakeGh(t: TestLifecycle, options: { readonly repo: string; readonly remote: string }) {
  const binDir = await createTempDir("guardian-multi-gh-");
  const stateDir = await createTempDir("guardian-multi-gh-state-");
  const mergerDir = await createTempDir("guardian-multi-gh-merger-");
  await execFileAsync("git", ["clone", "--quiet", options.remote, mergerDir]);
  await execFileAsync("git", ["-C", mergerDir, "config", "user.email", "guardian@example.test"]);
  await execFileAsync("git", ["-C", mergerDir, "config", "user.name", "Guardian Test"]);
  const ghPath = path.join(binDir, "gh");
  const logPath = path.join(stateDir, "gh.log");
  const currentPath = path.join(stateDir, "current-branch");
  const script = `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$GUARDIAN_TEST_GH_LOG"
sub="\${2:-}"
head_branch=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--head" ]; then head_branch="$arg"; fi
  prev="$arg"
done
if [ "$1" = "pr" ] && [ "$sub" = "list" ]; then
  printf '[]\\n'
elif [ "$1" = "pr" ] && [ "$sub" = "create" ]; then
  printf '%s\\n' "$head_branch" > "$GUARDIAN_TEST_CURRENT_BRANCH"
  printf 'https://github.example/acme/widget/pull/%s\\n' "$head_branch"
elif [ "$1" = "pr" ] && [ "$sub" = "view" ]; then
  branch="$(cat "$GUARDIAN_TEST_CURRENT_BRANCH")"
  oid="$(git -C "$GUARDIAN_TEST_REPO" rev-parse "$branch")"
  printf '{"number":1,"url":"https://github.example/acme/widget/pull/%s","headRefName":"%s","headRefOid":"%s"}\\n' "$branch" "$branch" "$oid"
elif [ "$1" = "pr" ] && [ "$sub" = "merge" ]; then
  branch="$(cat "$GUARDIAN_TEST_CURRENT_BRANCH")"
  git -C "$GUARDIAN_TEST_MERGER" fetch -q origin
  git -C "$GUARDIAN_TEST_MERGER" checkout -q -B main origin/main
  git -C "$GUARDIAN_TEST_MERGER" merge -q --no-ff "origin/$branch" -m "merge $branch"
  git -C "$GUARDIAN_TEST_MERGER" push -q origin main
else
  echo "unexpected gh invocation: $*" >&2
  exit 2
fi
`;
  await fs.writeFile(ghPath, script, "utf8");
  await fs.chmod(ghPath, 0o755);
  const originalEnv = {
    PATH: process.env.PATH,
    GUARDIAN_TEST_REPO: process.env.GUARDIAN_TEST_REPO,
    GUARDIAN_TEST_MERGER: process.env.GUARDIAN_TEST_MERGER,
    GUARDIAN_TEST_GH_LOG: process.env.GUARDIAN_TEST_GH_LOG,
    GUARDIAN_TEST_CURRENT_BRANCH: process.env.GUARDIAN_TEST_CURRENT_BRANCH,
  };
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.GUARDIAN_TEST_REPO = options.repo;
  process.env.GUARDIAN_TEST_MERGER = mergerDir;
  process.env.GUARDIAN_TEST_GH_LOG = logPath;
  process.env.GUARDIAN_TEST_CURRENT_BRANCH = currentPath;
  t.after(() => {
    for (const [key, value] of Object.entries(originalEnv)) restoreEnv(key, value);
  });
  return { logPath };
}
