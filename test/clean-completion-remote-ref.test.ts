import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { proveCleanCompletionUniverse } from "../src/clean-completion-universe.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { createSafetyRef } from "../src/git.ts";
import { guardianStart } from "../src/start.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

async function remoteCleanupRefFixture() {
  const { base, repo } = await createRepoWithOrigin();
  const config = { ...DEFAULT_CONFIG, worktreeRoot: path.join(base, "worktrees", "$REPO") };
  await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_remote_cleanup_ref", taskName: "remote cleanup ref", createWorktree: true, config });
  await git(repo, ["checkout", "-b", "feature"]);
  await fs.writeFile(path.join(repo, "feature.txt"), "feature\n");
  await git(repo, ["add", "feature.txt"]);
  await git(repo, ["commit", "-m", "feature"]);
  const featureHead = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  await git(repo, ["checkout", "main"]);
  await git(repo, ["merge", "--no-ff", "feature", "-m", "merge feature"]);
  const mergedHead = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  return { base, config, featureHead, mergedHead, repo };
}

test("clean-completion accepts a completed remote-cleanup ref whose preserved head reached its recorded merge", async (t) => {
  const fixture = await remoteCleanupRefFixture();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const safetyRef = `refs/opencode-guardian/remote-branch-cleanup/origin/guardian/feature/${fixture.mergedHead}`;
  await createSafetyRef(fixture.repo, { sessionId: "remote-branch-cleanup", branch: "origin/guardian/feature", commit: fixture.featureHead, ref: safetyRef });

  const proof = await proveCleanCompletionUniverse({ repoRoot: fixture.repo, config: fixture.config });

  assert.equal(proof.status, "stable", JSON.stringify(proof));
});

test("clean-completion rejects a remote-cleanup ref whose preserved head did not reach its recorded merge", async (t) => {
  const fixture = await remoteCleanupRefFixture();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  await git(fixture.repo, ["checkout", "-b", "unmerged", `${fixture.mergedHead}^1`]);
  await fs.writeFile(path.join(fixture.repo, "unmerged.txt"), "unmerged\n");
  await git(fixture.repo, ["add", "unmerged.txt"]);
  await git(fixture.repo, ["commit", "-m", "unmerged"]);
  const unmergedHead = (await git(fixture.repo, ["rev-parse", "HEAD"])).stdout;
  await git(fixture.repo, ["checkout", "main"]);
  const safetyRef = `refs/opencode-guardian/remote-branch-cleanup/origin/guardian/unmerged/${fixture.mergedHead}`;
  await createSafetyRef(fixture.repo, { sessionId: "remote-branch-cleanup", branch: "origin/guardian/unmerged", commit: unmergedHead, ref: safetyRef });

  const proof = await proveCleanCompletionUniverse({ repoRoot: fixture.repo, config: fixture.config });

  assert.equal(proof.status, "unstable");
  assert.match(String(proof.reason), /unknown Guardian safety ref/);
});
