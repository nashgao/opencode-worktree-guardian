import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { proveCleanCompletionUniverse } from "../src/clean-completion-universe.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianStart } from "../src/start.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

async function proofFixture() {
  const { base, repo } = await createRepoWithOrigin();
  const config = {
    ...DEFAULT_CONFIG,
    protectedPaths: ["evidence", "protected-untracked"],
    worktreeRoot: path.join(base, "worktrees", "$REPO"),
  };
  await fs.writeFile(path.join(repo, ".gitignore"), "evidence/\nnode_modules/\nresidue/\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "configure ignored proof fixture"]);
  await git(repo, ["push", "origin", "main"]);
  await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_protected_ignored_proof", taskName: "protected ignored proof", createWorktree: true, config });
  return { base, config, repo };
}

test("clean-completion permits configured and built-in protected ignored files", async (t) => {
  const fixture = await proofFixture();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  await fs.mkdir(path.join(fixture.repo, "evidence"), { recursive: true });
  await fs.mkdir(path.join(fixture.repo, "node_modules", "fixture"), { recursive: true });
  await fs.mkdir(path.join(fixture.repo, "protected-untracked"), { recursive: true });
  await fs.writeFile(path.join(fixture.repo, "evidence", "keep.txt"), "keep\n");
  await fs.writeFile(path.join(fixture.repo, "node_modules", "fixture", "index.js"), "export {};\n");
  await fs.writeFile(path.join(fixture.repo, "protected-untracked", "keep.txt"), "keep\n");

  const proof = await proveCleanCompletionUniverse({ repoRoot: fixture.repo, config: fixture.config, requireCleanWorktrees: true });

  assert.equal(proof.status, "stable", JSON.stringify(proof));
});

test("clean-completion still rejects unprotected ignored files", async (t) => {
  const fixture = await proofFixture();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  await fs.mkdir(path.join(fixture.repo, "residue"), { recursive: true });
  await fs.writeFile(path.join(fixture.repo, "residue", "block.txt"), "block\n");

  const proof = await proveCleanCompletionUniverse({ repoRoot: fixture.repo, config: fixture.config, requireCleanWorktrees: true });

  assert.equal(proof.status, "unstable");
  assert.match(String(proof.reason), /registered worktree is not clean/);
});
