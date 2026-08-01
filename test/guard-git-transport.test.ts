import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianStart } from "../src/start.ts";
import { deleteRemoteBranch, fetchRemote, fetchRemotePrune, listRemoteBranches, pushBranchNormally, pushBranchWithLease } from "../src/git.ts";
import { classifyGuardCommand, classifyNormalAgentGitCommand } from "../src/guards.ts";
import { createRepoWithOrigin, createTempDir, git } from "./helpers.ts";

type GitRefusalCheck = { readonly marker: string; readonly bin: string; readonly command: () => Promise<unknown>; readonly errorPattern: RegExp; readonly markedCommand?: string };

async function assertRefusedBeforeGit({ marker, bin, command, errorPattern, markedCommand }: GitRefusalCheck) {
  const originalPath = process.env.PATH;
  const originalMarker = process.env.GUARDIAN_GIT_MARKER;
  const originalRealPath = process.env.GUARDIAN_REAL_PATH;
  const originalMarkedCommand = process.env.GUARDIAN_MARKED_COMMAND;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  process.env.GUARDIAN_GIT_MARKER = marker;
  process.env.GUARDIAN_REAL_PATH = originalPath ?? "";
  if (markedCommand === undefined) delete process.env.GUARDIAN_MARKED_COMMAND;
  else process.env.GUARDIAN_MARKED_COMMAND = markedCommand;
  let failure: unknown;
  try {
    try {
      await command();
    } catch (error) {
      failure = error;
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalMarker === undefined) delete process.env.GUARDIAN_GIT_MARKER;
    else process.env.GUARDIAN_GIT_MARKER = originalMarker;
    if (originalRealPath === undefined) delete process.env.GUARDIAN_REAL_PATH;
    else process.env.GUARDIAN_REAL_PATH = originalRealPath;
    if (originalMarkedCommand === undefined) delete process.env.GUARDIAN_MARKED_COMMAND;
    else process.env.GUARDIAN_MARKED_COMMAND = originalMarkedCommand;
  }
  await assert.rejects(fs.access(marker));
  assert.ok(failure instanceof Error);
  assert.match(failure.message, errorPattern);
}

function assertTransportBlocked(command: string): void {
  assert.equal(classifyGuardCommand(command).blocked, true, command);
  assert.equal(classifyNormalAgentGitCommand(command).allowed, false, command);
}

function assertTransportAllowed(command: string): void {
  assert.equal(classifyGuardCommand(command).blocked, false, command);
  assert.equal(classifyNormalAgentGitCommand(command).allowed, true, command);
}

test("blocks protected transport destinations after the remote", () => {
  for (const command of [
    "git push origin --receive-pack receive HEAD:refs/opencode-guardian",
    "git fetch origin --refmap=HEAD:refs/stash HEAD",
    "git fetch origin --refmap HEAD:refs/opencode-guardian HEAD",
  ]) {
    assertTransportBlocked(command);
  }
});

test("blocks late refmap destinations in separated and inline forms", () => {
  for (const command of [
    "git fetch origin HEAD --refmap HEAD:refs/opencode-guardian",
    "git fetch origin HEAD --refmap=HEAD:refs/opencode-guardian",
  ]) {
    assertTransportBlocked(command);
  }
});

test("blocks resolved and unresolved config-env recovery transports", () => {
  for (const command of [
    "REMOTE_FETCH=HEAD:refs/stash git --config-env remote.origin.fetch=REMOTE_FETCH fetch origin",
    "git --config-env remote.origin.fetch=REMOTE_FETCH fetch origin",
    "REMOTE_PUSH=HEAD:refs/opencode-guardian git --config-env remote.origin.push=REMOTE_PUSH push origin",
    "git --config-env remote.origin.push=REMOTE_PUSH push origin",
  ]) {
    assertTransportBlocked(command);
  }
});

test("blocks a valueless runtime remote mirror config as Git boolean true", () => {
  assertTransportBlocked("git -c remote.origin.mirror push origin");
});

test("blocks clustered force push flags", () => {
  for (const command of [
    "git push -vf origin HEAD:refs/heads/feature",
    "git push -fv origin HEAD:refs/heads/feature",
  ]) {
    assertTransportBlocked(command);
  }
});

test("blocks opaque and dynamic transport destinations", () => {
  for (const command of [
    "git fetch --stdin origin",
    "git push origin HEAD:refs/heads/$TARGET",
    "git fetch origin HEAD:refs/heads/$TARGET",
    "git fetch origin --refmap=HEAD:refs/heads/$TARGET HEAD",
  ]) {
    assertTransportBlocked(command);
  }
});

test("blocks runtime remote refspec configuration into recovery namespaces", () => {
  for (const command of [
    "git -c remote.origin.fetch=HEAD:refs/stash fetch origin",
    "git -c remote.self.push=HEAD:refs/opencode-guardian push self",
    "git -c remote.origin.fetch=HEAD:refs/heads/$TARGET fetch origin",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.fetch GIT_CONFIG_VALUE_0=HEAD:refs/stash git fetch origin",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.self.push GIT_CONFIG_VALUE_0=HEAD:refs/opencode-guardian git push self",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.self.push GIT_CONFIG_VALUE_0=HEAD:refs/heads/$TARGET git push self",
  ]) {
    assertTransportBlocked(command);
  }
});

test("blocks remote transport config mutations but permits read queries", () => {
  for (const command of [
    "git config remote.origin.fetch HEAD:refs/stash",
    "git config --add remote.origin.push HEAD:refs/opencode-guardian",
    "git config --unset remote.origin.mirror",
  ]) {
    assert.equal(classifyGuardCommand(command).blocked, true, command);
    assert.equal(classifyNormalAgentGitCommand(command).allowed, false, command);
  }

  for (const command of [
    "git config --get remote.origin.fetch",
    "git config --get-all remote.origin.push",
    "git config --get-regexp ^remote\\.origin\\.mirror$",
  ]) {
    assert.equal(classifyGuardCommand(command).blocked, false, command);
  }
});

test("blocks unsafe effective transport config for implicit fetch and push", () => {
  for (const [command, transportConfigs] of [
    ["git fetch origin", ["remote.origin.fetch=HEAD:refs/stash"]],
    ["git push origin", ["remote.origin.push=HEAD:refs/opencode-guardian"]],
  ] satisfies readonly (readonly [string, readonly string[]])[]) {
    const inspection = { state: "available" as const, aliases: [], transportConfigs, currentHead: null };
    assert.equal(classifyGuardCommand(command, { inspection }).blocked, true, command);
    assert.equal(classifyNormalAgentGitCommand(command, { inspection }).allowed, false, command);
  }

  for (const [command, transportConfigs] of [
    ["git fetch origin", ["remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*"]],
    ["git push origin", ["remote.origin.push=HEAD:refs/heads/feature"]],
  ] satisfies readonly (readonly [string, readonly string[]])[]) {
    const inspection = { state: "available" as const, aliases: [], transportConfigs, currentHead: null };
    assert.equal(classifyGuardCommand(command, { inspection }).blocked, false, command);
    assert.equal(classifyNormalAgentGitCommand(command, { inspection }).allowed, true, command);
  }
});

test("blocks unsafe effective transport config for dotted remote names", () => {
  assert.equal(classifyGuardCommand("git fetch origin.backup", {
    inspection: { state: "available", aliases: [], transportConfigs: ["remote.origin.backup.fetch=HEAD:refs/stash"], currentHead: null },
  }).blocked, true);
  assert.equal(classifyGuardCommand("git config remote.origin.backup.push HEAD:refs/opencode-guardian/recovery").blocked, true);
});

test("blocks effective transport configuration for its case-sensitive invoked remote", () => {
  const inspection = {
    state: "available" as const,
    aliases: [],
    transportConfigs: ["remote.Origin.push=HEAD:refs/opencode-guardian/recovery"],
    currentHead: null,
  };

  assert.equal(classifyGuardCommand("git push Origin", { inspection }).blocked, true);
  assert.equal(classifyNormalAgentGitCommand("git push Origin", { inspection }).allowed, false);
});

test("permits a differently-cased remote without matching effective transport configuration", () => {
  const inspection = {
    state: "available" as const,
    aliases: [],
    transportConfigs: ["remote.Origin.push=HEAD:refs/opencode-guardian/recovery"],
    currentHead: null,
  };

  assert.equal(classifyGuardCommand("git push origin", { inspection }).blocked, false);
  assert.equal(classifyNormalAgentGitCommand("git push origin", { inspection }).allowed, true);
});

test("blocks exact and descendant Guardian and stash recovery namespaces", () => {
  for (const command of [
    "git push origin HEAD:refs/opencode-guardian",
    "git push origin HEAD:refs/opencode-guardian/session/recovery",
    "git push origin HEAD:refs/stash",
    "git push origin HEAD:refs/stash/backup",
  ]) {
    assertTransportBlocked(command);
  }
});

test("allows ordinary static transport and source-only fetches", () => {
  for (const command of [
    "git push origin HEAD:refs/heads/feature",
    "git fetch origin HEAD:refs/heads/local-feature",
    "git fetch origin refs/heads/main",
    "git fetch --recurse-submodules origin HEAD:refs/heads/local-feature",
    "git fetch --recurse-submodules=on-demand origin HEAD:refs/heads/local-feature",
    "git fetch origin --upload-pack refs/stash HEAD",
    "git fetch origin --refmap=HEAD:refs/heads/local-feature HEAD",
  ]) {
    assertTransportAllowed(command);
  }
});

test("remote command boundary rejects unsafe and unconfigured remotes before Git starts", async (t) => {
  // Given a real repository, a configured option-shaped remote, and a fake Git executable.
  const { base, repo } = await createRepoWithOrigin();
  const toolRoot = await createTempDir("guardian-git-boundary-tools-");
  t.after(async () => fs.rm(base, { recursive: true, force: true }));
  t.after(async () => fs.rm(toolRoot, { recursive: true, force: true }));
  const uploadPack = path.join(toolRoot, "upload-pack");
  const optionRemote = `--upload-pack=${uploadPack}`;
  const fakeGit = path.join(toolRoot, "git");
  await fs.writeFile(uploadPack, '#!/bin/sh\n: > "$GUARDIAN_UPLOAD_PACK_MARKER"\nexit 93\n');
  await fs.writeFile(fakeGit, '#!/bin/sh\nif [ "$3" = config ]; then PATH="$GUARDIAN_REAL_PATH" exec git "$@"; fi\nif [ -z "$GUARDIAN_MARKED_COMMAND" ] || [ "$3" = "$GUARDIAN_MARKED_COMMAND" ]; then : > "$GUARDIAN_GIT_MARKER"; exit 94; fi\nPATH="$GUARDIAN_REAL_PATH" exec git "$@"\n');
  await fs.chmod(uploadPack, 0o755);
  await fs.chmod(fakeGit, 0o755);
  await fs.appendFile(path.join(repo, ".git", "config"), `\n[remote "${optionRemote}"]\n\turl = ${base}/remote.git\n`);
  const head = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  const unsafeRemotes = [optionRemote, "-ccore.fsmonitor=false", "", "origin//team", "unconfigured/team"];
  const remoteCommands = [
    (remote: string) => fetchRemote(repo, remote), (remote: string) => fetchRemotePrune(repo, remote),
    (remote: string) => pushBranchWithLease(repo, remote, "main", head, null), (remote: string) => pushBranchNormally(repo, remote, "main", head),
    (remote: string) => deleteRemoteBranch(repo, remote, "main", head), (remote: string) => listRemoteBranches(repo, remote),
  ];

  for (const [index, remote] of unsafeRemotes.entries()) {
    // When every remote-bearing boundary receives the unsafe value.
    for (const [commandIndex, command] of remoteCommands.entries()) {
      const marker = path.join(toolRoot, `git-${index}-${commandIndex}.marker`);
      await assertRefusedBeforeGit({ marker, bin: toolRoot, command: () => command(remote), errorPattern: /remote/i });

      // Then it rejects before the fake Git command runner can execute.
    }
  }
  await assertRefusedBeforeGit({
    marker: path.join(toolRoot, "start.marker"),
    bin: toolRoot,
    command: () => guardianStart({ repoRoot: repo, cwd: repo, sessionId: "unsafe-remote", taskName: "unsafe remote", createWorktree: true, config: { ...DEFAULT_CONFIG, remote: optionRemote } }),
    errorPattern: /remote/i,
    markedCommand: "worktree",
  });

  // When an option-shaped configured remote is passed directly to Git's fetch grammar.
  const uploadPackMarker = path.join(toolRoot, "upload-pack.marker");
  const originalUploadPackMarker = process.env.GUARDIAN_UPLOAD_PACK_MARKER;
  process.env.GUARDIAN_UPLOAD_PACK_MARKER = uploadPackMarker;
  try {
    await assert.rejects(fetchRemote(repo, optionRemote), /remote/i);
  } finally {
    if (originalUploadPackMarker === undefined) delete process.env.GUARDIAN_UPLOAD_PACK_MARKER;
    else process.env.GUARDIAN_UPLOAD_PACK_MARKER = originalUploadPackMarker;
  }

  // Then Git never reaches the configured upload-pack executable.
  await assert.rejects(fs.access(uploadPackMarker));
});
