import assert from "node:assert/strict";
import test from "node:test";
import { classifyGuardCommand } from "../src/guards.ts";

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
    "git push origin HEAD:ma{in,ster}",
    "git push origin HEAD:$TARGET",
    "git push origin :ma{in,ster}",
    "git merge $TARGET",
    "git push origin HEAD:$(printf main)",
    "git merge $(printf guardian/foo)",
  ]) {
    const result = classifyGuardCommand(command, protectedBranchOptions);
    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /guardian_finish|dynamic shell command substitution/);
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

test("blocks env -C merges into protected worktree paths", () => {
  const options = {
    cwd: "/tmp",
    protectedBranches: ["main"],
    branchPrefix: "guardian/",
    guardianBranches: ["feature/source-facts-hardening"],
    currentBranch: "feature/local-context",
    protectedBranchWorktreePaths: ["/repo"],
  };

  for (const command of [
    "env -C /repo git merge feature/source-facts-hardening",
    "env -iC /repo git merge feature/source-facts-hardening",
    "env -S\"-iC /repo git merge feature/source-facts-hardening\"",
    "FOO=1 env -C /repo git merge feature/source-facts-hardening",
    "env -C /repo env -C sub git merge feature/source-facts-hardening",
    "bash -c 'env -C /repo env -C sub git merge feature/source-facts-hardening'",
  ]) {
    const result = classifyGuardCommand(command, options);
    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /guardian_finish/);
  }
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
