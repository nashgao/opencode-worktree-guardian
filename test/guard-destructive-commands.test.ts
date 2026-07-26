import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { classifyGuardCommand, classifyNormalAgentGitCommand, extractCommandText, tokenizeCommand } from "../src/guards.ts";

const blocked = [
  "git reset",
  "git reset --hard",
  "git reset --keep origin/main",
  "git reset --merge origin/main",
  "git reset --soft HEAD~1",
  "git reset origin/main",
  "git reset -- README.md",
  "git clean -fd",
  "git clean --force -d",
  "git branch -d feature",
  "git branch -D feature",
  "git branch -df feature",
  "git branch --delete feature",
  "git branch --delete --force feature",
  "git update-ref -d refs/heads/guardian/foo",
  "git update-ref -d --no-deref refs/heads/guardian/foo",
  "git update-ref --delete refs/heads/feature",
  "git update-ref --delete=refs/heads/main",
  "printf 'delete refs/heads/guardian/foo' | git update-ref --stdin",
  "git worktree remove ../wt",
  "git worktree prune",
  "git worktree add /tmp/unmanaged main",
  "git -C /repo worktree add /private/tmp/unmanaged main",
  `bash -lc "git worktree add /var/folders/tw/example/T/opencode/wt main"`,
  "opencode-worktree-workflow wt-clean apply feature",
  "git stash",
  "git stash push -u",
  "git stash pop",
  "git stash apply stash@{0}",
  "git stash drop stash@{0}",
  "git stash clear",
  "git stash -u -m list",
  "git stash show --output=stash.patch",
  "git stash show --ext-diff stash@{0}",
  "git stash show --textconv stash@{0}",
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
  "$(printf git) reset --hard",
  "`printf git` reset --hard",
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

test("blocks raw local branch and branch-ref deletion", () => {
  for (const command of [
    "git branch -d guardian/foo",
    "git branch -D guardian/foo",
    "git branch -df guardian/foo",
    "git branch --delete guardian/foo",
    "git branch --delete --force guardian/foo",
  ]) {
    const result = classifyGuardCommand(command);
    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /guardian_delete_worktree/);
  }

  for (const command of [
    "git update-ref -d refs/heads/guardian/foo",
    "git update-ref -d --no-deref refs/heads/guardian/foo",
    "git update-ref -d HEAD",
    "git update-ref -d --no-deref HEAD",
    "git update-ref --delete HEAD",
    "git update-ref --delete=HEAD",
    "git update-ref -d @",
    "git update-ref --delete refs/heads/feature/source-facts-hardening",
    "git update-ref --delete=refs/heads/main",
    "printf 'delete refs/heads/guardian/foo' | git update-ref --stdin",
  ]) {
    const result = classifyGuardCommand(command);
    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /guardian_delete_worktree/);
  }
});

test("blocks path-qualified Unix and Windows destructive git commands", () => {
  for (const command of [
    "/usr/bin/git reset --hard",
    "\"C:/Program Files/Git/cmd/git.exe\" reset --hard",
    "git.exe reset --hard",
  ]) {
    assert.equal(classifyGuardCommand(command).blocked, true, command);
    assert.equal(classifyNormalAgentGitCommand(command).allowed, false, command);
  }
});

test("allows non-branch update-ref operations through the generic guard", () => {
  assert.equal(classifyGuardCommand("git update-ref refs/tags/check HEAD").blocked, false);
  assert.equal(classifyGuardCommand("git update-ref -d refs/tags/check").blocked, false);
  assert.equal(classifyGuardCommand("git update-ref -d --no-deref refs/tags/check").blocked, false);
});

test("blocks rm -rf for known worktree paths and repo-managed paths", () => {
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

  for (const command of [
    "rm -rf src",
    "rm -rf ./src",
    "rm -Rf /tmp/repo/src",
    "bash -lc 'rm -rf src'",
    'bash -lc \\"rm -rf src\\"',
  ]) {
    const result = classifyGuardCommand(command, {
      cwd: "/tmp/repo",
      repoRoot: "/tmp/repo",
    });
    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /guardian_delete_paths|guardian_hygiene/);
  }

  assert.equal(classifyGuardCommand("rm -rf /tmp/not-a-worktree", {
    cwd: "/tmp/repo",
    knownWorktreePaths: ["/tmp/repo/.worktrees/a"],
  }).blocked, false);

  assert.equal(classifyGuardCommand("rm -rf /tmp/src", {
    cwd: "/tmp",
    repoRoot: "/tmp/repo",
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
  assert.match(String(result.reason), /reset/);
});

test("classifies nested shell payloads with scoped cwd from prior cd", () => {
  const repoRoot = process.cwd();
  const result = classifyGuardCommand(`cd ${JSON.stringify(repoRoot)} && bash -lc "rm -rf src"`, {
    cwd: path.dirname(repoRoot),
    repoRoot,
  });
  assert.equal(result.blocked, true);
  assert.match(String(result.reason), /shell -c payload is blocked/);
});

test("tokenizes quoted worktree paths and extracts hook command text", () => {
  assert.deepEqual(tokenizeCommand("rm -rf '/tmp/a b'"), ["rm", "-rf", "/tmp/a b"]);
  assert.equal(extractCommandText({ args: { command: "a" } }, { args: { command: "b" } }), "b");
  assert.equal(extractCommandText({ args: { code: "git worktree add /tmp/wt main" } }, {}), "git worktree add /tmp/wt main");
});
