import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { classifyGuardCommand } from "../src/guards.ts";
import { collectGuardPathFacts } from "../src/plugin/guard-path-facts.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

const pathFacts = {
  canonicalRepoRoots: ["/repo"],
  canonicalKnownWorktreePaths: [],
  canonicalTargets: {
    "/outside/repo-link/generated": "/repo/generated",
  },
};

test("blocks a supplied symlink spelling for an in-repository deletion target", () => {
  const command = "rm -rf /outside/repo-link/generated";
  const result = classifyGuardCommand(command, {
    cwd: "/outside",
    repoRoot: "/repo",
    pathFacts,
  });

  assert.equal(result.blocked, true, command);
});

test("permits an unrelated deletion target despite supplied canonical facts", () => {
  const command = "rm -rf /outside/unrelated/generated";
  const result = classifyGuardCommand(command, {
    cwd: "/outside",
    repoRoot: "/repo",
    pathFacts,
  });

  assert.equal(result.blocked, false, command);
});

test("collects the canonical --work-tree symlink target for a protected Git merge", async (t) => {
  // Given a linked Guardian worktree and a symlink to the protected primary worktree.
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const linked = path.join(base, "linked");
  const outside = path.join(base, "outside");
  const primaryLink = path.join(outside, "primary-link");
  await git(repo, ["worktree", "add", "-b", "guardian/linked", linked]);
  await fs.mkdir(outside);
  await fs.symlink(repo, primaryLink, "dir");
  const { stdout: primaryGitDir } = await git(repo, ["rev-parse", "--absolute-git-dir"]);
  const command = `git --git-dir=${primaryGitDir} --work-tree=${primaryLink} merge guardian/linked`;

  // When Guardian collects path facts for the explicit Git target.
  const facts = await collectGuardPathFacts({ command, cwd: linked, repoRoots: [repo], knownWorktreePaths: [repo] });

  // Then the symlink spelling resolves to the actual protected worktree.
  assert.equal(facts.canonicalTargets[primaryLink], repo);
});
