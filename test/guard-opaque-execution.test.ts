import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { classifyGuardCommand, classifyNormalAgentGitCommand } from "../src/guards.ts";
import { createRef, isAncestor } from "../src/git.ts";
import { createRepoWithOrigin, git, makeBranchCommit } from "./helpers.ts";

function assertBlocked(command: string): void {
  assert.equal(classifyGuardCommand(command).blocked, true, command);
  assert.equal(classifyNormalAgentGitCommand(command).allowed, false, command);
}

function assertAllowed(command: string): void {
  assert.equal(classifyGuardCommand(command).blocked, false, command);
  assert.equal(classifyNormalAgentGitCommand(command).allowed, true, command);
}

for (const command of [
  "G=git; $G reset --hard",
  "git${EMPTY} reset --hard",
  "eval \"git reset --hard\"",
  "printf 'git reset --hard\\n' | sh",
  "git.exe $(printf reset) --hard",
]) {
  test(`blocks opaque destructive execution: ${command}`, () => {
    assertBlocked(command);
  });
}

test("permits ordinary direct git inspection", () => {
  for (const command of ["git status --short", "git.exe status --short"]) {
    assertAllowed(command);
  }
});

test("Guardian ignores replacement objects while plain Git observes them", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const { commit } = await makeBranchCommit(repo, "guardian/replace-spoof");
  const remoteBase = (await git(repo, ["rev-parse", "refs/remotes/origin/main"])).stdout;
  const baseTree = (await git(repo, ["rev-parse", `${remoteBase}^{tree}`])).stdout;
  const replacementBase = (await git(repo, ["commit-tree", baseTree, "-p", commit, "-m", "replacement base with feature parent"])).stdout;
  await git(repo, ["replace", remoteBase, replacementBase]);

  const plainGitObservesReplacement = await git(repo, ["merge-base", "--is-ancestor", commit, remoteBase]).then(() => true, () => false);
  const guardianObservesReplacement = await isAncestor(repo, commit, "refs/remotes/origin/main");

  assert.equal(plainGitObservesReplacement, true);
  assert.equal(guardianObservesReplacement, false);
});

test("Guardian keeps non-executable reference-transaction EACCES fail-closed", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const hooks = path.join(base, "non-executable-hooks");
  const ref = "refs/opencode-guardian/non-executable-hook/probe";
  await fs.mkdir(hooks);
  await fs.writeFile(path.join(hooks, "reference-transaction"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  await git(repo, ["config", "core.hooksPath", hooks]);

  await assert.rejects(createRef(repo, ref), /cannot determine whether.*executable/i);
  await assert.rejects(git(repo, ["show-ref", "--verify", ref]));
});
