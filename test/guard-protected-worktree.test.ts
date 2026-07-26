import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyGuardCommand } from "../src/guards.ts";

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
    pathFacts: {
      canonicalRepoRoots: [],
      canonicalKnownWorktreePaths: [],
      canonicalTargets: {
        [link]: protectedWorktree,
        [path.join(link, "subdir")]: path.join(protectedWorktree, "subdir"),
      },
    },
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
    pathFacts: {
      canonicalRepoRoots: [],
      canonicalKnownWorktreePaths: [],
      canonicalTargets: { [link]: protectedWorktree },
    },
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
