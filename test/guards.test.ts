import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyGuardCommand, classifyNormalAgentGitCommand, classifyReadOnlyInspectionCommand, extractCommandText, tokenizeCommand } from "../src/guards.ts";

const blocked = [
  "git reset --hard",
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
    assert.match(String(result.reason), /guardian_finish/);
  }
});

test("blocks recorded descriptive Guardian branches from protected branch bypasses", () => {
  const options = {
    protectedBranches: ["main"],
    branchPrefix: "guardian/",
    guardianBranches: ["feature/source-facts-hardening"],
    currentBranch: "main",
  };
  for (const command of [
    "git push origin feature/source-facts-hardening:main",
    "git push origin refs/heads/feature/source-facts-hardening:refs/heads/main",
    "git merge feature/source-facts-hardening",
  ]) {
    const result = classifyGuardCommand(command, options);
    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /guardian_finish/);
  }
});

test("blocks git -C merges into protected worktree paths", () => {
  const options = {
    cwd: "/tmp",
    protectedBranches: ["main"],
    branchPrefix: "guardian/",
    guardianBranches: ["feature/source-facts-hardening"],
    currentBranch: "feature/local-context",
    protectedBranchWorktreePaths: ["/repo"],
  };

  const result = classifyGuardCommand("git -C /repo merge feature/source-facts-hardening", options);

  assert.equal(result.blocked, true);
  assert.match(String(result.reason), /guardian_finish/);
});

test("blocks git -C merges inside protected worktree paths", () => {
  const options = {
    cwd: "/tmp",
    protectedBranches: ["main"],
    branchPrefix: "guardian/",
    guardianBranches: ["feature/source-facts-hardening"],
    currentBranch: "feature/local-context",
    protectedBranchWorktreePaths: ["/repo"],
  };

  for (const command of [
    "git -C /repo/subdir merge feature/source-facts-hardening",
    "git -C /repo -C . merge feature/source-facts-hardening",
    "git -C /repo -C subdir merge feature/source-facts-hardening",
  ]) {
    const result = classifyGuardCommand(command, options);
    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /guardian_finish/);
  }
});

test("blocks git -C symlinks to protected worktree paths", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-guard-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const protectedWorktree = path.join(base, "repo");
  const link = path.join(base, "repo-link");
  await fs.mkdir(path.join(protectedWorktree, "subdir"), { recursive: true });
  await fs.symlink(protectedWorktree, link, "dir");
  const options = {
    cwd: base,
    protectedBranches: ["main"],
    branchPrefix: "guardian/",
    guardianBranches: ["feature/source-facts-hardening"],
    currentBranch: "feature/local-context",
    protectedBranchWorktreePaths: [protectedWorktree],
  };

  for (const command of [
    `git -C ${link} merge feature/source-facts-hardening`,
    `git -C ${link}/subdir merge feature/source-facts-hardening`,
  ]) {
    const result = classifyGuardCommand(command, options);
    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /guardian_finish/);
  }
});

test("blocks shell cd merges into protected worktree paths", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-guard-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const protectedWorktree = path.join(base, "repo");
  await fs.mkdir(path.join(protectedWorktree, "subdir"), { recursive: true });
  const options = {
    cwd: base,
    protectedBranches: ["main"],
    branchPrefix: "guardian/",
    guardianBranches: ["feature/source-facts-hardening"],
    currentBranch: "feature/local-context",
    protectedBranchWorktreePaths: [protectedWorktree],
  };

  for (const command of [
    `bash -lc "cd ${protectedWorktree} && git merge feature/source-facts-hardening"`,
    `bash -lc "cd ${path.join(protectedWorktree, "subdir")} && git merge feature/source-facts-hardening"`,
  ]) {
    const result = classifyGuardCommand(command, options);
    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /guardian_finish/);
  }
});

test("does not let failed shell cd leave a protected worktree context", () => {
  const options = {
    cwd: "/repo",
    protectedBranches: ["main"],
    branchPrefix: "guardian/",
    guardianBranches: ["feature/source-facts-hardening"],
    currentBranch: "feature/local-context",
    protectedBranchWorktreePaths: ["/repo"],
  };

  for (const command of [
    `cd /does-not-exist || git merge feature/source-facts-hardening`,
    `cd /does-not-exist; git merge feature/source-facts-hardening`,
    `bash -lc "cd /does-not-exist || git merge feature/source-facts-hardening"`,
    `bash -lc "cd /does-not-exist; git merge feature/source-facts-hardening"`,
  ]) {
    const result = classifyGuardCommand(command, options);
    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /guardian_finish/);
  }
});

test("blocks shell pushd merges into protected worktree paths", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-guard-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const protectedWorktree = path.join(base, "repo");
  await fs.mkdir(path.join(protectedWorktree, "subdir"), { recursive: true });
  const options = {
    cwd: base,
    protectedBranches: ["main"],
    branchPrefix: "guardian/",
    guardianBranches: ["feature/source-facts-hardening"],
    currentBranch: "feature/local-context",
    protectedBranchWorktreePaths: [protectedWorktree],
  };

  for (const command of [
    `bash -lc "pushd ${protectedWorktree} && git merge feature/source-facts-hardening"`,
    `bash -lc "pushd ${path.join(protectedWorktree, "subdir")} && git merge feature/source-facts-hardening"`,
  ]) {
    const result = classifyGuardCommand(command, options);
    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /guardian_finish/);
  }
});

test("blocks git work-tree merges into protected worktree paths", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-guard-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const protectedWorktree = path.join(base, "repo");
  const link = path.join(base, "repo-link");
  await fs.mkdir(path.join(protectedWorktree, ".git"), { recursive: true });
  await fs.mkdir(path.join(protectedWorktree, "subdir"), { recursive: true });
  await fs.symlink(protectedWorktree, link, "dir");
  const options = {
    cwd: base,
    protectedBranches: ["main"],
    branchPrefix: "guardian/",
    guardianBranches: ["feature/source-facts-hardening"],
    currentBranch: "feature/local-context",
    protectedBranchWorktreePaths: [protectedWorktree],
  };

  for (const command of [
    `git --work-tree ${protectedWorktree} --git-dir ${path.join(protectedWorktree, ".git")} merge feature/source-facts-hardening`,
    `git --work-tree=${protectedWorktree} --git-dir=${path.join(protectedWorktree, ".git")} merge feature/source-facts-hardening`,
    `git --work-tree=${path.join(protectedWorktree, "subdir")} --git-dir=${path.join(protectedWorktree, ".git")} merge feature/source-facts-hardening`,
    `git --work-tree=${link} --git-dir=${path.join(protectedWorktree, ".git")} merge feature/source-facts-hardening`,
  ]) {
    const result = classifyGuardCommand(command, options);
    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /guardian_finish/);
  }
});

test("blocks runtime git aliases in protected worktree paths", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-guard-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const protectedWorktree = path.join(base, "repo");
  await fs.mkdir(protectedWorktree, { recursive: true });
  const options = {
    cwd: base,
    protectedBranches: ["main"],
    branchPrefix: "guardian/",
    guardianBranches: ["feature/source-facts-hardening"],
    currentBranch: "feature/local-context",
    protectedBranchWorktreePaths: [protectedWorktree],
  };

  for (const command of [
    `git -C ${protectedWorktree} -c alias.m='merge feature/source-facts-hardening' m`,
    `git -C ${protectedWorktree} -c include.path=${path.join(base, "alias.gitconfig")} m`,
    `git -C ${protectedWorktree} -c includeIf.onbranch:main.path=${path.join(base, "alias.gitconfig")} m`,
    `git -C ${protectedWorktree} -c includeIf.gitdir:${protectedWorktree}/.git.path=${path.join(base, "alias.gitconfig")} m`,
    `bash -lc "cd ${protectedWorktree} && git -c alias.m='merge feature/source-facts-hardening' m"`,
    `git -C ${protectedWorktree} --config-env=alias.m=GIT_ALIAS_M m`,
    `git -C ${protectedWorktree} --config-env=include.path=GIT_ALIAS_CONFIG m`,
    `git -C ${protectedWorktree} --config-env=includeIf.gitdir:${protectedWorktree}/.git.path=GIT_ALIAS_CONFIG m`,
    `git -C ${protectedWorktree} --config-env alias.m=GIT_ALIAS_M m`,
    `git --work-tree ${protectedWorktree} --git-dir ${path.join(protectedWorktree, ".git")} --config-env=alias.m=GIT_ALIAS_M m`,
    `env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.m GIT_CONFIG_VALUE_0='merge feature/source-facts-hardening' git -C ${protectedWorktree} m`,
    `env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=include.path GIT_CONFIG_VALUE_0=${path.join(base, "alias.gitconfig")} git -C ${protectedWorktree} m`,
    `env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=includeIf.gitdir:${protectedWorktree}/.git.path GIT_CONFIG_VALUE_0=${path.join(base, "alias.gitconfig")} git -C ${protectedWorktree} m`,
    `env -u FOO GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.m GIT_CONFIG_VALUE_0='merge feature/source-facts-hardening' git -C ${protectedWorktree} m`,
    `env -S "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.m GIT_CONFIG_VALUE_0='merge feature/source-facts-hardening' git -C ${protectedWorktree} m"`,
    `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.m GIT_CONFIG_VALUE_0='merge feature/source-facts-hardening' git -C ${protectedWorktree} m`,
    `bash -lc "cd ${protectedWorktree} && env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.m GIT_CONFIG_VALUE_0='merge feature/source-facts-hardening' git m"`,
    `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.m GIT_CONFIG_VALUE_0='merge feature/source-facts-hardening' bash -lc "cd ${protectedWorktree} && git m"`,
    `env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.m GIT_CONFIG_VALUE_0='merge feature/source-facts-hardening' bash -lc "cd ${protectedWorktree} && git m"`,
    `env -S "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.m GIT_CONFIG_VALUE_0='merge feature/source-facts-hardening' bash -lc 'cd ${protectedWorktree} && git m'"`,
  ]) {
    const result = classifyGuardCommand(command, options);
    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /runtime git alias-capable config/);
  }
});

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

test("allows non-branch update-ref operations through the generic guard", () => {
  assert.equal(classifyGuardCommand("git update-ref refs/tags/check HEAD").blocked, false);
  assert.equal(classifyGuardCommand("git update-ref -d refs/tags/check").blocked, false);
  assert.equal(classifyGuardCommand("git update-ref -d --no-deref refs/tags/check").blocked, false);
});

test("does not block protected branch bypass patterns without required context", () => {
  assert.equal(classifyGuardCommand("git push origin HEAD:main").blocked, false);
  assert.equal(classifyGuardCommand("git merge guardian/foo", {
    protectedBranches: ["main"],
    branchPrefix: "guardian/",
    currentBranch: "feature",
  }).blocked, false);
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
    "git branch -D feature",
    "git stash pop",
    "bash -lc 'git add README.md'",
  ]) {
    assert.equal(classifyNormalAgentGitCommand(command).allowed, false, command);
  }
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
