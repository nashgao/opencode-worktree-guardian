import assert from "node:assert/strict";
import test from "node:test";
import { classifyGuardCommand, classifyReadOnlyInspectionCommand, extractCommandText, tokenizeCommand } from "../src/guards.ts";

const blocked = [
  "git reset --hard",
  "git clean -fd",
  "git clean --force -d",
  "git branch -D feature",
  "git worktree remove ../wt",
  "git worktree prune",
  "opencode-worktree-workflow wt-clean apply feature",
  "git stash",
  "git stash push -u",
  "git stash pop",
  "git push --force origin feature",
  "git push --force-with-lease",
  "git push --force-with-lease=main origin feature",
  "git push --force=main origin feature",
  "git push origin +feature:feature",
  "git -C /tmp/repo reset --hard",
  "git -C /tmp/repo clean -fd",
  "git -C /tmp/repo worktree remove /tmp/wt",
  "git --git-dir=.git push --force origin branch",
  "command git reset --hard",
  "env GIT_DIR=.git git reset --hard",
  "sudo git reset --hard",
  "echo $(git reset --hard)",
  "( git reset --hard )",
  "if git reset --hard; then true; fi",
  "bash -c \"git reset --hard\"",
  "sh -lc \"git worktree remove /repo/.worktrees/a\"",
  "echo `git reset --hard`",
  "git restore .",
  "git restore --worktree README.md",
  "git checkout -- README.md",
  "git checkout HEAD -- README.md",
  "git checkout -f main",
  "git checkout --force main",
  "git switch -f main",
  "git switch --force main",
  "git switch --discard-changes main",
  "git status\ngit reset --hard",
];

for (const command of blocked) {
  test(`blocks ${command}`, () => {
    assert.equal(classifyGuardCommand(command).blocked, true);
  });
}


const protectedBranchOptions = {
  protectedBranches: ["main", "master"],
  branchPrefix: "guardian/",
  currentBranch: "main",
};

test("blocks Guardian protected branch bypasses when branch context is available", () => {
  for (const command of [
    "git push origin HEAD:main",
    "git push origin guardian/foo:main",
    "git push origin guardian/foo:refs/heads/main",
    "git push origin refs/heads/guardian/foo:refs/heads/main",
    "git push origin 'guardian/foo:main'",
    "git push origin \"HEAD:main\"",
    "git push --repo origin HEAD:main",
    "git push -o ci.skip origin HEAD:main",
    "git push --push-option ci.skip origin HEAD:main",
    "git push --atomic --porcelain -u origin HEAD:main",
    "git push --set-upstream origin guardian/foo:main",
    "git push origin +guardian/foo:main",
    "git push origin +HEAD:main",
    "git merge guardian/foo",
    "git merge refs/heads/guardian/foo",
  ]) {
    const result = classifyGuardCommand(command, protectedBranchOptions);
    assert.equal(result.blocked, true, command);
    assert.match(result.reason, /guardian_finish/);
  }
});

test("blocks protected branch deletion push refspecs when branch context is available", () => {
  for (const command of [
    "git push origin --delete main",
    "git push origin :main",
  ]) {
    const result = classifyGuardCommand(command, protectedBranchOptions);
    assert.equal(result.blocked, true, command);
    assert.match(result.reason, /protected branch/);
  }
});

test("does not block protected branch bypass patterns without required context", () => {
  assert.equal(classifyGuardCommand("git push origin HEAD:main").blocked, false);
  assert.equal(classifyGuardCommand("git merge guardian/foo", {
    protectedBranches: ["main"],
    branchPrefix: "guardian/",
    currentBranch: "feature",
  }).blocked, false);
});

test("blocks rm -rf only for known worktree paths", () => {
  assert.equal(classifyGuardCommand("rm -rf ../repo/.worktrees/a", {
    cwd: "/tmp/repo",
    knownWorktreePaths: ["/tmp/repo/.worktrees/a"],
  }).blocked, true);

  assert.equal(classifyGuardCommand("rm -rf /tmp/repo/.worktrees/a/nested", {
    cwd: "/tmp/repo",
    knownWorktreePaths: ["/tmp/repo/.worktrees/a"],
  }).blocked, true);

  assert.equal(classifyGuardCommand("rm -rf /tmp/repo/.worktrees", {
    cwd: "/tmp/repo",
    knownWorktreePaths: ["/tmp/repo/.worktrees"],
  }).blocked, true);

  assert.equal(classifyGuardCommand("rm -rf /tmp/not-a-worktree", {
    cwd: "/tmp/repo",
    knownWorktreePaths: ["/tmp/repo/.worktrees/a"],
  }).blocked, false);
});

test("allows read-only stash inspection and normal push", () => {
  assert.equal(classifyGuardCommand("git stash list").blocked, false);
  assert.equal(classifyGuardCommand("git stash show -p stash@{0}").blocked, false);
  assert.equal(classifyGuardCommand("git push origin feature").blocked, false);
  assert.equal(classifyGuardCommand("git checkout feature").blocked, false);
  assert.equal(classifyGuardCommand("git switch feature").blocked, false);
  assert.equal(classifyGuardCommand("git clean -nfd").blocked, false);
  assert.equal(classifyGuardCommand("git restore --staged").blocked, false);
});

test("finds dangerous commands inside shell command chains", () => {
  const result = classifyGuardCommand("printf ok && git reset --hard");
  assert.equal(result.blocked, true);
  assert.match(result.reason, /reset/);
});

test("tokenizes quoted worktree paths and extracts hook command text", () => {
  assert.deepEqual(tokenizeCommand("rm -rf '/tmp/a b'"), ["rm", "-rf", "/tmp/a b"]);
  assert.equal(extractCommandText({ args: { command: "a" } }, { args: { command: "b" } }), "b");
});


test("read-only inspection allowlist is conservative", () => {
  for (const command of [
    "pwd",
    "git status --short",
    "git diff HEAD~1 -- README.md",
    "git log --oneline -3",
    "git show HEAD:README.md",
    "git rev-parse --show-toplevel",
    "git branch --show-current",
    "git worktree list --porcelain",
    "git stash list",
    "git stash show -p stash@{0}",
    "git remote -v",
    "git ls-files",
  ]) {
    assert.equal(classifyReadOnlyInspectionCommand(command).allowed, true, command);
  }

  for (const command of [
    "touch changed.txt",
    "npm test",
    "git add README.md",
    "git fetch origin",
    "git diff --output=patch.diff",
    "git status --short > status.txt",
    "git status && git add README.md",
    "bash -c 'git status --short'",
    "git worktree prune",
    "git stash pop",
  ]) {
    assert.equal(classifyReadOnlyInspectionCommand(command).allowed, false, command);
  }
});
