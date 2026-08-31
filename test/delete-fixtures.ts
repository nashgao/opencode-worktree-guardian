import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDeleteWorktree } from "../src/delete.ts";
import type { DeleteWorktreeRuntime } from "../src/delete-worktree.ts";
import { guardianStatus } from "../src/recover.ts";
import { recordSession } from "../src/state.ts";
import { guardianStart } from "../src/tools.ts";
import type { GuardianSession, GuardianToolResult } from "../src/types.ts";
import { createRepoWithOrigin, createTempDir, git, seedSession } from "./helpers.ts";

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

export async function deleteWorktree(input: Record<string, unknown>, runtime?: DeleteWorktreeRuntime) {
  return guardianDeleteWorktree(input, runtime) as Promise<DeleteResult>;
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

type TestLifecycle = {
  readonly after: (callback: () => void) => void;
};

type FakeGhOptions = {
  readonly repo: string;
  readonly branch: string;
  readonly head?: string;
  readonly dynamicHead?: boolean;
  readonly existingPr?: boolean;
  readonly mergeFails?: boolean;
  readonly expectAdmin?: boolean;
  readonly mergeMethod?: "merge" | "squash";
  readonly resultMethod?: "merge" | "squash";
  readonly autoDeleteBranch?: boolean;
};

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

export async function installFakeGh(t: TestLifecycle, options: FakeGhOptions) {
  const binDir = await createTempDir("guardian-fake-gh-");
  const stateDir = await createTempDir("guardian-fake-gh-state-");
  const ghPath = path.join(binDir, "gh");
  const logPath = path.join(stateDir, "gh.log");
  const createdPath = path.join(stateDir, "pr-created");
  const url = "https://github.example/acme/widget/pull/1";
  const script = `#!/bin/sh
set -eu
pr_head() {
  if [ "\${GUARDIAN_TEST_DYNAMIC_HEAD:-0}" = "1" ]; then
    git -C "$GUARDIAN_TEST_REPO" rev-parse "$GUARDIAN_TEST_BRANCH"
  else
    printf '%s\\n' "$GUARDIAN_TEST_HEAD"
  fi
}
pr_list_json() {
  printf '[{"number":1,"url":"%s","headRefName":"%s","headRefOid":"%s"}]\\n' "$GUARDIAN_TEST_PR_URL" "$GUARDIAN_TEST_BRANCH" "$(pr_head)"
}
pr_view_json() {
  printf '{"number":1,"url":"%s","headRefName":"%s","headRefOid":"%s"}\\n' "$GUARDIAN_TEST_PR_URL" "$GUARDIAN_TEST_BRANCH" "$(pr_head)"
}
printf '%s\\n' "$*" >> "$GUARDIAN_TEST_GH_LOG"
if [ "$1" = "pr" ] && [ "\${2:-}" = "list" ]; then
  if [ -f "$GUARDIAN_TEST_PR_CREATED" ]; then
    pr_list_json
  else
    printf '[]\\n'
  fi
elif [ "$1" = "pr" ] && [ "\${2:-}" = "create" ]; then
  : > "$GUARDIAN_TEST_PR_CREATED"
  printf '%s\\n' "$GUARDIAN_TEST_PR_URL"
elif [ "$1" = "pr" ] && [ "\${2:-}" = "view" ]; then
  pr_view_json
elif [ "$1" = "pr" ] && [ "\${2:-}" = "merge" ]; then
  has_admin=0
  has_merge_method=0
  for arg in "$@"; do
    if [ "$arg" = "--admin" ]; then has_admin=1; fi
    if [ "$arg" = "--$GUARDIAN_TEST_MERGE_METHOD" ]; then has_merge_method=1; fi
  done
  if [ "$has_merge_method" != "1" ]; then
    echo "$GUARDIAN_TEST_MERGE_METHOD merge method was expected" >&2
    exit 7
  fi
  if [ "\${GUARDIAN_TEST_EXPECT_ADMIN:-0}" = "1" ] && [ "$has_admin" != "1" ]; then
    echo "admin bypass was expected" >&2
    exit 8
  fi
  if [ "\${GUARDIAN_TEST_EXPECT_ADMIN:-0}" != "1" ] && [ "$has_admin" = "1" ]; then
    echo "admin bypass was not expected" >&2
    exit 9
  fi
  if [ "\${GUARDIAN_TEST_MERGE_FAILS:-0}" = "1" ]; then
    echo "review required" >&2
    exit 4
  fi
  git -C "$GUARDIAN_TEST_REPO" checkout main >/dev/null
  if [ "$GUARDIAN_TEST_RESULT_METHOD" = "squash" ]; then
    git -C "$GUARDIAN_TEST_REPO" merge --squash "$GUARDIAN_TEST_BRANCH" >/dev/null
    git -C "$GUARDIAN_TEST_REPO" commit -m "squash merged pull request" >/dev/null
  else
    git -C "$GUARDIAN_TEST_REPO" merge --ff-only "$GUARDIAN_TEST_BRANCH" >/dev/null
  fi
  git -C "$GUARDIAN_TEST_REPO" push origin main >/dev/null
  if [ "\${GUARDIAN_TEST_AUTO_DELETE_BRANCH:-0}" = "1" ]; then
    remote_path="$(git -C "$GUARDIAN_TEST_REPO" remote get-url origin)"
    git --git-dir="$remote_path" update-ref -d "refs/heads/$GUARDIAN_TEST_BRANCH"
  fi
else
  echo "unexpected gh invocation: $*" >&2
  exit 2
fi
`;
  await fs.writeFile(ghPath, script, "utf8");
  await fs.chmod(ghPath, 0o755);
  if (options.existingPr === true) await fs.writeFile(createdPath, "", "utf8");

  const originalEnv = {
    PATH: process.env.PATH,
    GUARDIAN_TEST_REPO: process.env.GUARDIAN_TEST_REPO,
    GUARDIAN_TEST_BRANCH: process.env.GUARDIAN_TEST_BRANCH,
    GUARDIAN_TEST_HEAD: process.env.GUARDIAN_TEST_HEAD,
    GUARDIAN_TEST_DYNAMIC_HEAD: process.env.GUARDIAN_TEST_DYNAMIC_HEAD,
    GUARDIAN_TEST_GH_LOG: process.env.GUARDIAN_TEST_GH_LOG,
    GUARDIAN_TEST_PR_CREATED: process.env.GUARDIAN_TEST_PR_CREATED,
    GUARDIAN_TEST_PR_URL: process.env.GUARDIAN_TEST_PR_URL,
    GUARDIAN_TEST_MERGE_FAILS: process.env.GUARDIAN_TEST_MERGE_FAILS,
    GUARDIAN_TEST_EXPECT_ADMIN: process.env.GUARDIAN_TEST_EXPECT_ADMIN,
    GUARDIAN_TEST_MERGE_METHOD: process.env.GUARDIAN_TEST_MERGE_METHOD,
    GUARDIAN_TEST_RESULT_METHOD: process.env.GUARDIAN_TEST_RESULT_METHOD,
    GUARDIAN_TEST_AUTO_DELETE_BRANCH: process.env.GUARDIAN_TEST_AUTO_DELETE_BRANCH,
  };
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.GUARDIAN_TEST_REPO = options.repo;
  process.env.GUARDIAN_TEST_BRANCH = options.branch;
  process.env.GUARDIAN_TEST_HEAD = options.head ?? "";
  process.env.GUARDIAN_TEST_DYNAMIC_HEAD = options.dynamicHead === true ? "1" : "0";
  process.env.GUARDIAN_TEST_GH_LOG = logPath;
  process.env.GUARDIAN_TEST_PR_CREATED = createdPath;
  process.env.GUARDIAN_TEST_PR_URL = url;
  process.env.GUARDIAN_TEST_MERGE_FAILS = options.mergeFails === true ? "1" : "0";
  process.env.GUARDIAN_TEST_EXPECT_ADMIN = options.expectAdmin === true ? "1" : "0";
  process.env.GUARDIAN_TEST_MERGE_METHOD = options.mergeMethod ?? "merge";
  process.env.GUARDIAN_TEST_RESULT_METHOD = options.resultMethod ?? options.mergeMethod ?? "merge";
  process.env.GUARDIAN_TEST_AUTO_DELETE_BRANCH = options.autoDeleteBranch === true ? "1" : "0";
  t.after(() => {
    for (const [key, value] of Object.entries(originalEnv)) restoreEnv(key, value);
  });

  return { logPath, url };
}
