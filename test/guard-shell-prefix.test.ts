import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyGuardCommand, classifyNormalAgentGitCommand, classifyReadOnlyInspectionCommand } from "../src/guards.ts";
import { getHeadCommit, runGit } from "../src/git.ts";
import { runGit as runGitProcess, runGitNullSeparated, runGitWithInput } from "../src/git-process.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

const ownedRoots: string[] = [];

async function initializeRepository(directory: string): Promise<void> {
  await runGitProcess(directory, ["init", "--quiet"]);
  await runGitProcess(directory, ["config", "user.email", "test@example.com"]);
  await runGitProcess(directory, ["config", "user.name", "Test User"]);
  await fs.writeFile(path.join(directory, "README"), "test\n");
  await runGitProcess(directory, ["add", "README"]);
  await runGitProcess(directory, ["commit", "--quiet", "-m", "initial"]);
}

async function installHook(directory: string, markerPath: string): Promise<void> {
  const hooksDirectory = path.join(directory, ".git", "hooks");
  await fs.mkdir(hooksDirectory, { recursive: true });
  const hookPath = path.join(hooksDirectory, "reference-transaction");
  await fs.writeFile(hookPath, `#!/bin/sh\nprintf hooked > ${JSON.stringify(markerPath)}\n`);
  await fs.chmod(hookPath, 0o755);
}

test.after(async () => {
  const remaining = await Promise.all(ownedRoots.map((root) => fs.access(root).then(() => root, () => null)));
  assert.deepEqual(remaining.filter((root): root is string => root !== null), []);
});

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

test("reference transaction hook blocks normalized ref writers and permits proven read-only commands", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  ownedRoots.push(base);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const head = await getHeadCommit(repo);
  const marker = path.join(base, "normalized-hook-ran");
  await git(repo, ["config", "alias.guardian-update", "update-ref"]);
  const hooks = path.join(repo, "reference-transaction-hooks");
  await fs.mkdir(hooks, { recursive: true });
  await fs.writeFile(path.join(hooks, "reference-transaction"), `#!/bin/sh\nprintf hook > ${JSON.stringify(marker)}\n`, "utf8");
  await fs.chmod(path.join(hooks, "reference-transaction"), 0o755);
  await git(repo, ["config", "core.hooksPath", hooks]);
  const ref = "refs/opencode-guardian/classifier/probe";
  const writers = [
    ["--literal-pathspecs", "update-ref", ref, head],
    ["guardian-update", ref, head],
    ["branch", "guardian/classifier-branch"],
    ["branch", "-D", "guardian/classifier-branch"],
    ["checkout", "-b", "guardian/classifier-checkout"],
    ["checkout", "--no-overwrite-ignore", "main"],
    ["tag", "classifier-tag"],
    ["notes", "add", "-m", "note", head],
    ["symbolic-ref", "HEAD", "refs/heads/main"],
    ["unknown-external-command"],
  ] as const;

  for (const args of writers) await assert.rejects(runGit(repo, args), /reference-transaction/i);
  for (const args of [["-C", repo, "update-ref", ref, head], ["-C"]] as const) await assert.rejects(runGit(repo, args), /global Git option/i);
  for (const args of [["status", "--short"], ["diff", "--quiet"], ["rev-parse", "HEAD"], ["ls-files"], ["for-each-ref"], ["clean", "-n"], ["config", "--get", "core.hooksPath"]] as const) {
    await runGit(repo, args);
  }

  await assert.rejects(fs.access(marker));
  await assert.rejects(git(repo, ["show-ref", "--verify", ref]));
  await assert.rejects(git(repo, ["show-ref", "--verify", "refs/tags/classifier-tag"]));
});

test("ref executors reject policy-routing global options before hooks run", async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(tmpdir(), "guardian-git-globals-"));
  const targetDirectory = path.join(temporaryDirectory, "target");
  const alternateDirectory = path.join(temporaryDirectory, "alternate");
  const markerPath = path.join(temporaryDirectory, "hook-ran");
  const customHooksDirectory = path.join(temporaryDirectory, "custom-hooks");
  const previousHookPath = process.env.GUARDIAN_TEST_HOOK_PATH;

  t.after(async () => {
    if (previousHookPath === undefined) delete process.env.GUARDIAN_TEST_HOOK_PATH;
    else process.env.GUARDIAN_TEST_HOOK_PATH = previousHookPath;
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  await fs.mkdir(targetDirectory);
  await fs.mkdir(alternateDirectory);
  await initializeRepository(targetDirectory);
  await initializeRepository(alternateDirectory);
  await installHook(targetDirectory, markerPath);
  await installHook(alternateDirectory, markerPath);
  await fs.mkdir(customHooksDirectory);
  await fs.writeFile(path.join(customHooksDirectory, "reference-transaction"), `#!/bin/sh\nprintf hooked > ${JSON.stringify(markerPath)}\n`);
  await fs.chmod(path.join(customHooksDirectory, "reference-transaction"), 0o755);
  process.env.GUARDIAN_TEST_HOOK_PATH = customHooksDirectory;

  const targetHead = (await runGitProcess(targetDirectory, ["rev-parse", "HEAD"])).stdout;
  const alternateGitDirectory = path.join(alternateDirectory, ".git");
  const hostilePrefixes = [
    ["-C", alternateDirectory], [`-C${alternateDirectory}`], ["--git-dir", alternateGitDirectory], [`--git-dir=${alternateGitDirectory}`],
    ["--work-tree", alternateDirectory], [`--work-tree=${alternateDirectory}`], ["--namespace", "attacker"], ["--namespace=attacker"],
    ["-c", `core.hooksPath=${customHooksDirectory}`], [`-ccore.hooksPath=${customHooksDirectory}`],
    ["--config-env=core.hooksPath=GUARDIAN_TEST_HOOK_PATH"], ["-C"], ["--git-dir"], ["-c"],
  ];

  for (const prefix of hostilePrefixes) {
    await assert.rejects(() => runGitProcess(targetDirectory, [...prefix, "update-ref", "refs/heads/forbidden", targetHead]), /global Git option/i);
    await assert.rejects(() => runGitWithInput(targetDirectory, [...prefix, "update-ref", "--stdin"], `update refs/heads/forbidden\0${targetHead}\0`), /global Git option/i);
    await assert.rejects(() => runGitNullSeparated(targetDirectory, [...prefix, "update-ref", "refs/heads/forbidden", targetHead]), /global Git option/i);
  }

  await assert.rejects(() => fs.readFile(markerPath, "utf8"));
});
