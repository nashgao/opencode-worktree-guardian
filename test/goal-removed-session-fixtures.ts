import fs from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianStart } from "../src/start.ts";
import { getGuardianPaths, readState } from "../src/state.ts";
import type { GuardianConfig } from "../src/types.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

export interface RemovedGoalFixture {
  base: string;
  repo: string;
  remote: string;
  config: GuardianConfig;
  sessionId: string;
  worktree: string;
  branch: string;
  baseline: string;
  head: string;
  landedBaseHead: string;
  otherId: string;
  otherBranch: string;
  otherBefore: unknown;
  primaryBefore: {
    head: string;
    branch: string;
    index: string;
    status: string;
    readme: string;
    staged: string;
    delivered: string;
  };
  request: {
    repoRoot: string;
    cwd: string;
    config: GuardianConfig;
    sessionId: string;
    action: "complete-removed-session";
    expectedRemoteHead: string;
    landedBaseHead: string;
    allowNonAncestorRemoteDeletion: boolean;
  };
}

export function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

export function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(`${name} must be a non-empty string`);
}

export async function primarySnapshot(repo: string) {
  return {
    head: (await git(repo, ["rev-parse", "HEAD"])).stdout,
    branch: (await git(repo, ["branch", "--show-current"])).stdout,
    index: (await git(repo, ["write-tree"])).stdout,
    status: (await git(repo, ["status", "--porcelain=v1"])).stdout,
    readme: await fs.readFile(path.join(repo, "README.md"), "utf8"),
    staged: await fs.readFile(path.join(repo, "owner-index.txt"), "utf8"),
    delivered: await fs.readFile(path.join(repo, "delivered.txt"), "utf8"),
  };
}

export async function removedGoalFixture(t: TestContext, squash = false, remoteName = "origin"): Promise<RemovedGoalFixture> {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  if (remoteName !== "origin") {
    await git(repo, ["remote", "add", remoteName, remote]);
    await git(repo, ["fetch", remoteName]);
    await git(repo, ["config", "--unset", "branch.main.remote"]);
    await git(repo, ["config", "--unset", "branch.main.merge"]);
  }
  const config = { ...DEFAULT_CONFIG, remote: remoteName, worktreeRoot: path.join(base, "managed") };
  const sessionId = "removed-goal-owner";
  const started = requireRecord(await guardianStart({ repoRoot: repo, cwd: repo, sessionId, createWorktree: true, taskName: "removed goal", config }), "start");
  const session = requireRecord(started.session, "session");
  const worktree = requireString(session.worktree_path, "worktree");
  const branch = requireString(session.branch, "branch");
  const baseline = requireString(session.started_head_commit, "baseline");
  await fs.writeFile(path.join(worktree, "delivered.txt"), "owned implementation\n");
  await git(worktree, ["add", "delivered.txt"]);
  await git(worktree, ["commit", "-m", "deliver owned implementation"]);
  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  await git(worktree, ["push", remoteName, `HEAD:refs/heads/${branch}`]);
  await git(repo, ["merge", squash ? "--squash" : "--ff-only", head]);
  if (squash) await git(repo, ["commit", "-m", "land owned implementation"]);
  const landedBaseHead = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  await git(repo, ["push", remoteName, "main"]);
  await git(repo, ["worktree", "remove", worktree]);
  await git(repo, ["branch", squash ? "-D" : "-d", branch]);

  const otherId = "unrelated-orphan";
  const other = requireRecord(await guardianStart({ repoRoot: repo, cwd: repo, sessionId: otherId, createWorktree: true, taskName: "other work", config }), "other start");
  const otherSession = requireRecord(other.session, "other session");
  const otherWorktree = requireString(otherSession.worktree_path, "other worktree");
  const otherBranch = requireString(otherSession.branch, "other branch");
  await git(otherWorktree, ["push", remoteName, `HEAD:refs/heads/${otherBranch}`]);
  await git(repo, ["worktree", "remove", otherWorktree]);
  await fs.writeFile(path.join(repo, "README.md"), "owner's unrelated working change\n");
  await fs.writeFile(path.join(repo, "owner-index.txt"), "owner's staged change\n");
  await git(repo, ["add", "owner-index.txt"]);
  const state = await readState(await getGuardianPaths(repo), { repoRoot: repo, config });
  return {
    base, repo, remote, config, sessionId, worktree, branch, baseline, head, landedBaseHead, otherId, otherBranch,
    otherBefore: state.sessions[otherId],
    primaryBefore: await primarySnapshot(repo),
    request: { repoRoot: repo, cwd: repo, config, sessionId, action: "complete-removed-session", expectedRemoteHead: head, landedBaseHead, allowNonAncestorRemoteDeletion: squash },
  };
}

export async function closureSnapshot(fixture: RemovedGoalFixture) {
  const state = await readState(await getGuardianPaths(fixture.repo), { repoRoot: fixture.repo, config: fixture.config });
  return {
    primary: await primarySnapshot(fixture.repo),
    sessions: state.sessions,
    localBranches: (await git(fixture.repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"])).stdout,
    remoteBranches: (await git(fixture.remote, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"])).stdout,
    safetyRefs: (await git(fixture.repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/opencode-guardian"])).stdout,
    worktrees: (await git(fixture.repo, ["worktree", "list", "--porcelain"])).stdout,
  };
}

export async function commitWithTree(repo: string, parent: string, treeSource: string, message: string) {
  return (await git(repo, ["commit-tree", `${treeSource}^{tree}`, "-p", parent, "-m", message])).stdout;
}

export async function rejectRemovalPush(fixture: RemovedGoalFixture) {
  const hooks = path.join(fixture.base, "reject-removal-hooks");
  const hook = path.join(hooks, "pre-push");
  const marker = path.join(fixture.base, "rejected-removal.txt");
  const quotedMarker = `'${marker.replaceAll("'", "'\\''")}'`;
  const statePath = (await getGuardianPaths(fixture.repo)).statePath;
  const quotedStatePath = `'${statePath.replaceAll("'", "'\\''")}'`;
  await fs.mkdir(hooks);
  await fs.writeFile(hook, `#!/bin/sh
set -eu
while read -r local_ref _local_sha remote_ref _remote_sha; do
  if [ "$local_ref" = "(delete)" ] && [ "$remote_ref" = "refs/heads/${fixture.branch}" ]; then
    printf '%s\\n' "$remote_ref" > ${quotedMarker}
    cp ${quotedStatePath} ${quotedMarker}.state.json
    git for-each-ref --format='%(refname) %(objectname)' refs/opencode-guardian > ${quotedMarker}.refs
    printf '%s\\n' 'disposable fixture rejects source deletion' >&2
    exit 1
  fi
done
`, "utf8");
  await fs.chmod(hook, 0o755);
  await git(fixture.repo, ["config", "core.hooksPath", hooks]);
  return { hook, marker };
}
