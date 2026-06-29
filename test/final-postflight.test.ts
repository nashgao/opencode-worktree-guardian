import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { runFinalCleanupPostflight } from "../src/final-postflight.ts";
import { createSafetyRef } from "../src/git.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

const execFileAsync = promisify(execFile);

test("final postflight blocks safety-reffed commits that are absent from final base", async () => {
  const { repo } = await createRepoWithOrigin();
  await fs.writeFile(path.join(repo, "feature.go"), "package main\n");
  await git(repo, ["add", "feature.go"]);
  await git(repo, ["commit", "-m", "fix: local behavior"]);
  const dropped = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  const safetyRef = await createSafetyRef(repo, { sessionId: "discard-local-main-divergence", branch: "main", commit: dropped, timestamp: "20260628T134058" });

  await git(repo, ["reset", "--keep", "origin/main"]);

  const result = await runFinalCleanupPostflight({
    repoRoot: repo,
    config: DEFAULT_CONFIG,
    requiredCommits: [{ commit: dropped, source: "main", reason: "local main commit must survive cleanup" }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.deepEqual((result.droppedCommits as Array<{ commit: string; safetyRefs: string[] }>).map((entry) => entry.commit), [dropped]);
  assert.match(JSON.stringify(result.blockers), /dropped-required-commit/);
  assert.match(JSON.stringify(result.blockers), new RegExp(safetyRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("final postflight treats explicit discard confirmation differently from preservation", async () => {
  const { repo } = await createRepoWithOrigin();
  await fs.writeFile(path.join(repo, "discarded.go"), "package main\n");
  await git(repo, ["add", "discarded.go"]);
  await git(repo, ["commit", "-m", "chore: discarded scratch"]);
  const discarded = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  await createSafetyRef(repo, { sessionId: "discard-local-main-divergence", branch: "main", commit: discarded, timestamp: "20260628T134058" });
  await git(repo, ["reset", "--keep", "origin/main"]);

  const result = await runFinalCleanupPostflight({
    repoRoot: repo,
    config: DEFAULT_CONFIG,
    requiredCommits: [{ commit: discarded, source: "main", discardConfirmed: true, discardEvidence: { reviewed: true } }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "passed");
  assert.equal((result.droppedCommits as Array<{ commit: string }>).length, 1);
});

test("final postflight allows the resolved upstream remote branch by default", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const gitlab = path.join(base, "gitlab.git");
  await execFileAsync("git", ["init", "--bare", gitlab]);
  await git(repo, ["remote", "add", "gitlab", gitlab]);
  await git(repo, ["push", "-u", "gitlab", "main:trunk"]);
  await git(repo, ["branch", "--set-upstream-to", "gitlab/trunk", "main"]);

  const result = await runFinalCleanupPostflight({
    repoRoot: repo,
    config: { ...DEFAULT_CONFIG, trustedUpstreamRemotes: ["gitlab"] },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "passed");
});
