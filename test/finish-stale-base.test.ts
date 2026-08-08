import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianFinish } from "../src/finish.ts";
import { guardianStatus } from "../src/recover.ts";
import { guardianStart } from "../src/tools.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("expected string");
  return value;
}

test("guardian_finish blocks a stale create-pr branch before safety-ref or push side effects", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_finish_stale_create_pr", taskName: "stale create pr", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(started.session.worktree_path, "feature.txt"), "feature\n");
  await git(started.session.worktree_path, ["add", "feature.txt"]);
  await git(started.session.worktree_path, ["commit", "-m", "add stale finish fixture"]);

  const updater = path.join(base, "finish-stale-updater");
  await git(base, ["clone", remote, updater]);
  await git(updater, ["config", "user.email", "guardian@example.test"]);
  await git(updater, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(updater, "base-advance.txt"), "base advance\n");
  await git(updater, ["add", "base-advance.txt"]);
  await git(updater, ["commit", "-m", "advance base before finish"]);
  await git(updater, ["push", "origin", "main"]);

  const result = await guardianFinish({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: "ses_finish_stale_create_pr", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.match(requireString(result.reason), /base.*ancestor/i);
  assert.equal(result.safetyRef, undefined);
  assert.equal(await git(repo, ["ls-remote", "--heads", "origin", started.session.branch]).then((entry) => entry.stdout), "");
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const session = status.sessions.find((candidate) => candidate.session_id === "ses_finish_stale_create_pr");
  assert.equal((session?.safety_refs ?? []).length, 0);
});

test("guardian_finish blocks a stale merge-to-base branch before primary-worktree mutation", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const config = { ...DEFAULT_CONFIG, finishMode: "merge-to-base" };
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_finish_stale_merge", taskName: "stale merge", createWorktree: true, config });
  await fs.writeFile(path.join(started.session.worktree_path, "feature.txt"), "feature\n");
  await git(started.session.worktree_path, ["add", "feature.txt"]);
  await git(started.session.worktree_path, ["commit", "-m", "add stale merge fixture"]);
  const primaryHead = (await git(repo, ["rev-parse", "main"])).stdout;

  const updater = path.join(base, "finish-stale-merge-updater");
  await git(base, ["clone", remote, updater]);
  await git(updater, ["config", "user.email", "guardian@example.test"]);
  await git(updater, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(updater, "base-advance.txt"), "base advance\n");
  await git(updater, ["add", "base-advance.txt"]);
  await git(updater, ["commit", "-m", "advance base before merge"]);
  await git(updater, ["push", "origin", "main"]);

  const result = await guardianFinish({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: "ses_finish_stale_merge", config, allowMergeToBase: true });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.match(requireString(result.reason), /base.*ancestor/i);
  assert.equal(result.safetyRef, undefined);
  assert.equal((await git(repo, ["rev-parse", "main"])).stdout, primaryHead);
});
