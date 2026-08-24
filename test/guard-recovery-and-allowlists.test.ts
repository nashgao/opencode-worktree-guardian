import assert from "node:assert/strict";
import test from "node:test";
import { classifyGuardCommand, classifyNormalAgentGitCommand, classifyReadOnlyInspectionCommand } from "../src/guards.ts";

const protectedBranchOptions = {
  protectedBranches: ["main", "master"],
  branchPrefix: "guardian/",
  currentBranch: "main",
};

test("blocks protected branch deletion push refspecs when branch context is available", () => {
  for (const command of [
    "git push origin --delete main",
    "git push origin :main",
  ]) {
    const result = classifyGuardCommand(command, protectedBranchOptions);
    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /protected branch/);
  }
});

test("blocks direct mutation of stash and Guardian recovery refs", () => {
  for (const command of [
    "git update-ref refs/stash HEAD",
    "git update-ref -d refs/stash",
    "git update-ref refs/opencode-guardian/ses/recovery HEAD",
    "git update-ref -d refs/opencode-guardian/ses/recovery",
    "git update-ref -d -m reason refs/stash",
    "git update-ref --delete -m reason refs/opencode-guardian/ses/recovery",
    "git symbolic-ref refs/stash refs/heads/main",
    "git symbolic-ref -d refs/stash",
    "git symbolic-ref refs/opencode-guardian/ses/recovery refs/heads/main",
    "git symbolic-ref -d refs/opencode-guardian/ses/recovery",
    "git reflog delete stash@{0}",
    "git reflog expire --expire=now refs/stash",
    "git reflog drop refs/stash",
    "git reflog delete refs/opencode-guardian/ses/recovery@{0}",
    "git reflog drop refs/opencode-guardian/ses/recovery",
    "git reflog expire --all",
    "git reflog drop --all",
    "git push . HEAD:refs/opencode-guardian/ses/recovery",
    "git push . :refs/opencode-guardian/ses/recovery",
    "git fetch . HEAD:refs/opencode-guardian/ses/recovery",
    "git push . HEAD:refs/stash",
    "git push . :refs/stash",
    "git fetch . HEAD:refs/stash",
    "git fetch --refmap=HEAD:refs/opencode-guardian/ses/recovery . HEAD",
  ]) {
    const result = classifyGuardCommand(command);
    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /stash|recovery ref/);
  }
});

test("allows non-mutating recovery-ref inspection", () => {
  assert.equal(classifyGuardCommand("git symbolic-ref refs/stash").blocked, false);
  assert.equal(classifyGuardCommand("git reflog show refs/stash").blocked, false);
});

test("blocks runtime git alias configurations in every worktree", () => {
  for (const command of [
    "git -c alias.nuke='stash clear' nuke",
    "git -c alias.x=stash x",
    "git --config-env=alias.nuke=GIT_ALIAS_NUKE nuke",
    "env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.nuke GIT_CONFIG_VALUE_0='stash clear' git nuke",
    "env GIT_CONFIG_GLOBAL=/tmp/guardian-aliases git nuke",
    "env GIT_CONFIG_SYSTEM=/tmp/guardian-aliases git nuke",
    "env GIT_CONFIG_PARAMETERS='alias.nuke=stash' git nuke",
    "env HOME=/tmp/guardian-alias-home git nuke",
    "env XDG_CONFIG_HOME=/tmp/guardian-alias-xdg git nuke",
    "env -C /tmp GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.nuke GIT_CONFIG_VALUE_0='stash clear' git nuke",
    "env -P /usr/bin GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.nuke GIT_CONFIG_VALUE_0='stash clear' git nuke",
    "bash -c \"export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.nuke GIT_CONFIG_VALUE_0='stash clear'; git nuke\"",
    "bash -c 'export HOME=/tmp/guardian-alias-home; git nuke'",
    "env -S'GIT_CONFIG_GLOBAL=/tmp/guardian-aliases git nuke'",
    "env -S'GIT_CONFIG_SYSTEM=/tmp/guardian-aliases git nuke'",
    "env -S'GIT_CONFIG_PARAMETERS=alias.nuke=stash git nuke'",
    "git config alias.nuke 'stash clear'",
    "git config --global alias.nuke 'stash clear'",
    "git config set include.path /tmp/guardian-aliases",
    "git config alias.nuke list",
    "git config include.path list",
    "git config $KEY '!git stash clear'",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.nuke GIT_CONFIG_VALUE_0='!git stash clear' command git nuke",
  ]) {
    const result = classifyGuardCommand(command);
    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /runtime git alias-capable config|executable search path/);
  }
});

test("blocks env alternate executable search paths", () => {
  for (const command of [
    "env -P /tmp git status",
    "env -iP /tmp git status",
    "env -S\"-iP /tmp git status\"",
    "FOO=1 env -P /tmp git status",
  ]) {
    const result = classifyGuardCommand(command);
    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /executable search path/);
    assert.equal(classifyReadOnlyInspectionCommand(command).allowed, false, command);
  }
});

test("blocks shell-expanded stash inspection arguments", () => {
  for (const command of [
    "git stash show $OPTS",
    "git stash show ${OPTS}",
    "git stash show \"$OPTS\"",
    "git stash show *",
    "git stash show --out{p..p}ut=README.md",
  ]) {
    const result = classifyGuardCommand(command);
    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /stash/);
    assert.equal(classifyReadOnlyInspectionCommand(command).allowed, false, command);
  }
});

test("blocks shell-expanded recovery-ref operands", () => {
  for (const command of [
    "bash -c 'TARGET=refs/stash; git update-ref \"$TARGET\" HEAD'",
    "bash -c 'TARGET=refs/opencode-guardian/ses/recovery; git symbolic-ref \"$TARGET\" refs/heads/main'",
    "bash -c 'TARGET=refs/stash; git reflog drop \"$TARGET\"'",
    "git update-ref $(printf refs/stash) HEAD",
    "git update-ref `printf refs/stash` HEAD",
    "git symbolic-ref $(printf refs/stash) refs/heads/main",
    "git reflog drop $(printf refs/stash)",
    "git update-ref -d -m reason \"$TARGET\"",
    "CMD=stash; git $CMD clear",
  ]) {
    const result = classifyGuardCommand(command);
    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /dynamic shell|dynamic git subcommand|stash|recovery ref/);
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

test("classifies normal non-destructive agent git passthrough", () => {
  for (const command of [
    "git status --short",
    "git add README.md src/index.ts",
    "git commit -m fix",
    "git fetch --prune origin",
    "git push origin main",
  ]) {
    assert.equal(classifyNormalAgentGitCommand(command).allowed, true, command);
  }

  for (const command of [
    "git reset --hard",
    "git clean -fd",
    "git commit --amend",
    "git push --force origin main",
    "git push --mirror origin",
    "git push origin --delete feature",
    "git push origin :feature",
    "git push . HEAD:refs/stash",
    "git fetch . HEAD:refs/stash",
    "git fetch --refmap=HEAD:refs/opencode-guardian/ses/recovery . HEAD",
    "git branch -D feature",
    "git stash pop",
    "bash -lc 'git add README.md'",
  ]) {
    assert.equal(classifyNormalAgentGitCommand(command).allowed, false, command);
  }
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
    "git log --output=history.txt",
    "git show --output=revision.txt HEAD",
    "git show --ext-diff HEAD",
    "git show --textconv HEAD",
    "git -c diff.external=/tmp/guardian-writer show HEAD",
    "git init",
    "git status --short > status.txt",
    "git status && git add README.md",
    "bash -c 'git status --short'",
    "git worktree prune",
    "git stash pop",
    "git stash -u -m list",
    "git stash show --output=stash.patch",
    "git stash show --ext-diff stash@{0}",
    "git stash show --textconv stash@{0}",
  ]) {
    assert.equal(classifyReadOnlyInspectionCommand(command).allowed, false, command);
  }
});
