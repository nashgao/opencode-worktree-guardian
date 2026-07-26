import assert from "node:assert/strict";
import test from "node:test";
import { classifyGuardCommand, classifyNormalAgentGitCommand, classifyReadOnlyInspectionCommand } from "../src/guards.ts";

test("blocks rm targets relative to an env -C cwd", () => {
  const result = classifyGuardCommand("env -C /repo rm -rf src", {
    cwd: "/outside",
    knownWorktreePaths: ["/repo/src"],
  });

  assert.equal(result.blocked, true);
  assert.match(String(result.reason), /known worktree path/);
});

test("composes nested relative env -C directories for generic commands", () => {
  const result = classifyGuardCommand("env -C /repo env -C src rm -rf generated", {
    cwd: "/outside",
    knownWorktreePaths: ["/repo/src/generated"],
  });

  assert.equal(result.blocked, true);
  assert.match(String(result.reason), /known worktree path/);
});

test("fails closed when supported prefixes synthesize the git executable", () => {
  for (const command of [
    "GIT_DIR=.git $(printf git) reset --hard",
    "command $(printf git) reset --hard",
    "env $(printf git) reset --hard",
    "sudo $(printf git) reset --hard",
  ]) {
    const result = classifyGuardCommand(command);

    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /dynamic shell command substitution/);
  }
});

test("blocks command-substituted rm targets but permits ordinary arguments", () => {
  for (const command of ["rm -rf $(pwd)", "rm -rf \"$(pwd)\""]) {
    assert.equal(classifyGuardCommand(command, { cwd: "/tmp", repoRoot: "/repo" }).blocked, true, command);
  }

  assert.equal(classifyGuardCommand("echo $(date)").blocked, false);
});

test("blocks executable search-path overrides but permits exec-path inspection", () => {
  for (const command of [
    "PATH=/tmp git status --short",
    "GIT_EXEC_PATH=/tmp git status --short",
    "git --exec-path=/tmp status --short",
  ]) {
    assert.equal(classifyGuardCommand(command).blocked, true, command);
    assert.equal(classifyNormalAgentGitCommand(command).allowed, false, command);
  }

  assert.equal(classifyGuardCommand("git --exec-path").blocked, false);
});

test("allows env split-string read-only git invocations", () => {
  for (const command of [
    "env -iS 'git status --short'",
    "env -ivS 'git status --short'",
  ]) {
    assert.equal(classifyGuardCommand(command).blocked, false, command);
    assert.equal(classifyReadOnlyInspectionCommand(command).allowed, true, command);
  }
});

test("fails closed for unknown env short-option clusters", () => {
  const command = "env -izS 'git status --short'";

  assert.equal(classifyGuardCommand(command).blocked, true);
  assert.match(String(classifyGuardCommand(command).reason), /executable search path/);
  assert.equal(classifyReadOnlyInspectionCommand(command).allowed, false);
});

test("blocks destructive env split-string git invocations for their git behavior", () => {
  for (const command of [
    "env -iS 'git reset --hard'",
    "env -iSgit reset --hard",
  ]) {
    const result = classifyGuardCommand(command);

    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /reset/);
  }
});

test("blocks env executable-path replacement even with split-string support", () => {
  const result = classifyGuardCommand("env -P /tmp git status --short");

  assert.equal(result.blocked, true);
  assert.match(String(result.reason), /executable search path/);
});
