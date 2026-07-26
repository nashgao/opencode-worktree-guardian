import assert from "node:assert/strict";
import test from "node:test";
import { classifyGuardCommand, classifyNormalAgentGitCommand } from "../src/guards.ts";

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
