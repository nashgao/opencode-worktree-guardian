import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { guardianStart } from "../src/start.ts";
import { isRecordLike } from "../src/types.ts";
import { installFakeGh } from "./delete-fixtures.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(`${name} must be a non-empty string`);
}

test("guardian_done runs pre-push hooks in the session worktree context", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "land-clean-hook-context";
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "hook context", createWorktree: true, config: DEFAULT_CONFIG });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");
  await fs.writeFile(path.join(worktree, "feature.txt"), "hook context\n", "utf8");
  await git(worktree, ["add", "feature.txt"]);
  await git(worktree, ["commit", "-m", "add hook context fixture"]);
  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
  await installFakeGh(t, { repo, branch, head });
  const commonGitDir = path.resolve(repo, (await git(repo, ["rev-parse", "--git-common-dir"])).stdout.trim());
  const hooksPath = path.resolve(repo, (await git(repo, ["rev-parse", "--git-path", "hooks"])).stdout.trim());
  const observedBranchPath = path.join(commonGitDir, "guardian-pre-push-context.txt");
  const hookPath = path.join(hooksPath, "pre-push");
  await fs.mkdir(hooksPath, { recursive: true });
  await fs.writeFile(hookPath, `#!/bin/sh
set -eu
while read -r _local_ref local_sha remote_ref _remote_sha; do
  if [ "$local_sha" != "0000000000000000000000000000000000000000" ] && [ "$remote_ref" = "refs/heads/${branch}" ]; then
    current_branch="$(git rev-parse --abbrev-ref HEAD)"
    printf '%s\\n' "$current_branch" > "$(git rev-parse --git-common-dir)/guardian-pre-push-context.txt"
    [ "$current_branch" = "${branch}" ]
  fi
done
`, "utf8");
  await fs.chmod(hookPath, 0o755);
  const request = { repoRoot: repo, cwd: worktree, sessionId, config: DEFAULT_CONFIG };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");

  // When
  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });

  // Then
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "landed-and-cleaned");
  assert.equal(await fs.readFile(observedBranchPath, "utf8"), `${branch}\n`);
});
