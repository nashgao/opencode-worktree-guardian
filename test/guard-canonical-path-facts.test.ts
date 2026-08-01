import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianFinish } from "../src/finish.ts";
import { classifyGuardCommand } from "../src/guards.ts";
import { collectGuardPathFacts } from "../src/plugin/guard-path-facts.ts";
import type { GuardianConfig } from "../src/types.ts";
import { createRepoWithOrigin, git, makeBranchCommit, seedSession } from "./helpers.ts";

const pathFacts = {
  canonicalRepoRoots: ["/repo"],
  canonicalKnownWorktreePaths: [],
  canonicalTargets: {
    "/outside/repo-link/generated": "/repo/generated",
  },
};

function macVarAlias(filePath: string): string {
  if (filePath.startsWith("/private/var/")) return filePath.replace(/^\/private\/var\//, "/var/");
  if (filePath.startsWith("/var/")) return `/private${filePath}`;
  return filePath;
}

async function recordAliasedSession(repo: string, worktreePath: string, sessionId: string, config: GuardianConfig): Promise<void> {
  const { branch, commit } = await makeBranchCommit(repo, `guardian/${sessionId}`);
  await seedSession(repo, {
    session_id: sessionId,
    status: "active",
    branch,
    worktree_path: worktreePath,
    base_ref: "origin/main",
    head_commit: commit,
    safety_refs: [],
  }, config);
}

async function createDarwinVarRepo(): Promise<{ readonly base: string; readonly repo: string }> {
  const base = await fs.mkdtemp("/var/tmp/guardian-var-alias-");
  const repoAlias = path.join(base, "repo");
  await git(base, ["init", "-b", "main", repoAlias]);
  const repo = await fs.realpath(repoAlias);
  await git(repo, ["config", "user.email", "guardian@example.test"]);
  await git(repo, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(repo, "README.md"), "initial\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  return { base, repo };
}

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

test("finish accepts recorded /var ownership for the same /private/var worktree", { skip: process.platform !== "darwin" }, async (t) => {
  const { base, repo } = await createDarwinVarRepo();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const alias = macVarAlias(repo);
  if (alias === repo) {
    t.skip("temporary repository does not use the Darwin /private/var alias");
    return;
  }
  const config = { ...DEFAULT_CONFIG, finishMode: "preserve-only" } satisfies GuardianConfig;
  await recordAliasedSession(repo, alias, "final-review-var-alias", config);

  const result = await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "final-review-var-alias", mode: "plan", config });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.preflight.sessionOwnedWorktree, true);
});

test("finish rejects a sibling of the recorded /var worktree", { skip: process.platform !== "darwin" }, async (t) => {
  const { base, repo } = await createDarwinVarRepo();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const alias = macVarAlias(repo);
  const config = { ...DEFAULT_CONFIG, finishMode: "preserve-only" } satisfies GuardianConfig;
  await recordAliasedSession(repo, `${alias}-sibling`, "final-review-var-sibling", config);

  const result = await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "final-review-var-sibling", mode: "plan", config });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.preflight.sessionOwnedWorktree, false);
  assert.match(String(result.reason), /does not own/);
  assert.equal((await git(repo, ["branch", "--show-current"])).stdout, "guardian/final-review-var-sibling");
});
