import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianFinish } from "../src/finish.ts";
import { guardianStart } from "../src/tools.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

const execFileAsync = promisify(execFile);

async function pathExists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true, () => false);
}

test("guardian_finish blocks a remote base advance during primary preparation before merge or push", async (t) => {
  // Given
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const config = { ...DEFAULT_CONFIG, finishMode: "merge-to-base", allowBaseWorktreePreserveReset: true };
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_finish_merge_race", taskName: "merge race", createWorktree: true, config });
  await fs.writeFile(path.join(started.session.worktree_path, "feature.txt"), "feature\n");
  await git(started.session.worktree_path, ["add", "feature.txt"]);
  await git(started.session.worktree_path, ["commit", "-m", "add merge race fixture"]);
  const featureHead = (await git(started.session.worktree_path, ["rev-parse", "HEAD"])).stdout;
  const primaryHead = (await git(repo, ["rev-parse", "main"])).stdout;
  await fs.writeFile(path.join(repo, "primary-dirt.txt"), "dirty\n");

  const updater = path.join(base, "merge-race-updater");
  await git(base, ["clone", remote, updater]);
  await git(updater, ["config", "user.email", "guardian@example.test"]);
  await git(updater, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(updater, "base-advance.txt"), "base advance\n");
  await git(updater, ["add", "base-advance.txt"]);
  await git(updater, ["commit", "-m", "advance base during primary preparation"]);
  const advancedRemoteHead = (await git(updater, ["rev-parse", "HEAD"])).stdout;

  const tools = path.join(base, "git-wrapper");
  const mergeMarker = path.join(base, "merge-attempted");
  const pushMarker = path.join(base, "push-attempted");
  await fs.mkdir(tools);
  await fs.writeFile(path.join(tools, "git"), `#!/bin/sh
if [ "$3" = "reset" ] && [ "$4" = "--hard" ]; then
  /usr/bin/git "$@" || exit $?
  exec /usr/bin/git -C "$GUARDIAN_RACE_UPDATER" push origin main
fi
if [ "$3" = "merge" ]; then
  : > "$GUARDIAN_RACE_MERGE_MARKER"
  exit 91
fi
if [ "$3" = "push" ]; then
  : > "$GUARDIAN_RACE_PUSH_MARKER"
  exit 92
fi
exec /usr/bin/git "$@"
`);
  await fs.chmod(path.join(tools, "git"), 0o755);
  const originalPath = process.env.PATH;
  const originalUpdater = process.env.GUARDIAN_RACE_UPDATER;
  const originalMergeMarker = process.env.GUARDIAN_RACE_MERGE_MARKER;
  const originalPushMarker = process.env.GUARDIAN_RACE_PUSH_MARKER;
  process.env.PATH = `${tools}${path.delimiter}${originalPath ?? ""}`;
  process.env.GUARDIAN_RACE_UPDATER = updater;
  process.env.GUARDIAN_RACE_MERGE_MARKER = mergeMarker;
  process.env.GUARDIAN_RACE_PUSH_MARKER = pushMarker;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalUpdater === undefined) delete process.env.GUARDIAN_RACE_UPDATER;
    else process.env.GUARDIAN_RACE_UPDATER = originalUpdater;
    if (originalMergeMarker === undefined) delete process.env.GUARDIAN_RACE_MERGE_MARKER;
    else process.env.GUARDIAN_RACE_MERGE_MARKER = originalMergeMarker;
    if (originalPushMarker === undefined) delete process.env.GUARDIAN_RACE_PUSH_MARKER;
    else process.env.GUARDIAN_RACE_PUSH_MARKER = originalPushMarker;
  });

  // When
  const result = await guardianFinish({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: "ses_finish_merge_race", config, allowMergeToBase: true });

  // Then
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.match(String(result.reason), /fresh remote base.*ancestor/i);
  assert.equal(result.preflight.baseRefOid, advancedRemoteHead);
  assert.equal((await git(repo, ["rev-parse", "main"])).stdout, primaryHead);
  assert.equal((await git(repo, ["ls-remote", "--heads", "origin", "main"])).stdout, `${advancedRemoteHead}\trefs/heads/main`);
  assert.equal(await pathExists(mergeMarker), false);
  assert.equal(await pathExists(pushMarker), false);
  assert.equal((await git(started.session.worktree_path, ["rev-parse", "HEAD"])).stdout, featureHead);
});

test("guardian_finish merges a fresh base after final revalidation", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const config = { ...DEFAULT_CONFIG, finishMode: "merge-to-base" };
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_finish_merge_fresh", taskName: "fresh merge", createWorktree: true, config });
  await fs.writeFile(path.join(started.session.worktree_path, "feature.txt"), "feature\n");
  await git(started.session.worktree_path, ["add", "feature.txt"]);
  await git(started.session.worktree_path, ["commit", "-m", "add fresh merge fixture"]);
  const featureHead = (await git(started.session.worktree_path, ["rev-parse", "HEAD"])).stdout;

  // When
  const result = await guardianFinish({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: "ses_finish_merge_fresh", config, allowMergeToBase: true });

  // Then
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "merged");
  assert.equal((await git(repo, ["rev-parse", "main"])).stdout, featureHead);
  assert.equal((await git(repo, ["rev-parse", "origin/main"])).stdout, featureHead);
  await execFileAsync("git", ["-C", repo, "merge-base", "--is-ancestor", featureHead, "origin/main"]);
});
