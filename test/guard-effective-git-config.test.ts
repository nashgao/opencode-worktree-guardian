import assert from "node:assert/strict";
import test from "node:test";
import { classifyGuardCommand, classifyNormalAgentGitCommand } from "../src/guards.ts";

function assertBlocked(command: string, options: Record<string, unknown>): void {
  assert.equal(classifyGuardCommand(command, options).blocked, true, command);
  assert.equal(classifyNormalAgentGitCommand(command, options).allowed, false, command);
}

function assertAllowed(command: string, options: Record<string, unknown>): void {
  assert.equal(classifyGuardCommand(command, options).blocked, false, command);
  assert.equal(classifyNormalAgentGitCommand(command, options).allowed, true, command);
}

for (const [command, config] of [
  ["git push origin", "remote.origin.mirror=true"],
  ["git push origin", "remote.origin.mirror=yes"],
  ["git push origin", "remote.origin.mirror=on"],
  ["git push origin", "remote.origin.mirror=1"],
  ["git push origin.backup", "remote.origin.backup.mirror=true"],
] satisfies readonly (readonly [string, string])[]) {
  const mirror = config.split("=")[1];
  test(`blocks effective mirror=${mirror} push configuration for ${command}`, () => {
    assertBlocked(command, {
      inspection: { state: "available", aliases: [], transportConfigs: [config], currentHead: null },
    });
  });
}

for (const mirror of ["false", "no", "off", "0"]) {
  test(`permits an explicit effective mirror=${mirror} control`, () => {
    assertAllowed("git push origin", {
      inspection: {
        state: "available",
        aliases: [],
        transportConfigs: [`remote.origin.mirror=${mirror}`],
        currentHead: null,
      },
    });
  });
}

for (const config of [
  "remote.origin.push=+HEAD:refs/heads/feature",
  "remote.origin.push=:refs/heads/main",
]) {
  test(`blocks effective unsafe push refspec ${config}`, () => {
    assertBlocked("git push origin", {
      inspection: { state: "available", aliases: [], transportConfigs: [config], currentHead: null },
    });
  });
}

test("permits ordinary effective refspec mappings", () => {
  assertAllowed("git push origin", {
    inspection: {
      state: "available",
      aliases: [],
      transportConfigs: ["remote.origin.push=HEAD:refs/heads/feature"],
      currentHead: null,
    },
  });
});

test("blocks effective protected-source mappings with equivalent Guardian HEAD identities", () => {
  const currentHead = "0123456789012345678901234567890123456789";
  for (const source of ["HEAD~00", "@~0", currentHead.slice(0, 12)]) {
    assertBlocked("git push Origin", {
      protectedBranches: ["main"],
      branchPrefix: "guardian/",
      inspection: {
        state: "available",
        aliases: [],
        transportConfigs: [`remote.Origin.push=${source}:refs/heads/main`],
        currentHead,
      },
      revisionIdentities: [{ source, oid: currentHead }],
    });
  }
});

test("permits a differently-cased remote outside an effective protected-source mapping", () => {
  const currentHead = "0123456789012345678901234567890123456789";
  assertAllowed("git push origin", {
    protectedBranches: ["main"],
    branchPrefix: "guardian/",
    inspection: {
      state: "available",
      aliases: [],
      transportConfigs: ["remote.Origin.push=HEAD~00:refs/heads/main"],
      currentHead,
    },
    revisionIdentities: [{ source: "HEAD~00", oid: currentHead }],
  });
});

test("scopes effective protected-source push configuration to the selected remote", () => {
  assertAllowed("git push safe", {
    protectedBranches: ["main"],
    branchPrefix: "guardian/",
    currentBranch: "guardian/source",
    inspection: {
      state: "available",
      aliases: [],
      transportConfigs: ["remote.danger.push=refs/heads/guardian/source:refs/heads/main"],
      currentHead: null,
    },
  });
});

test("blocks the invoked effective Git alias", () => {
  assertBlocked("git guardian-nuke", {
    inspection: {
      state: "available",
      aliases: ["guardian-nuke"],
      transportConfigs: [],
      currentHead: null,
    },
  });
});

test("blocks the invoked effective Git alias regardless of invocation case", () => {
  assertBlocked("git GUARDIAN-NUKE", {
    inspection: {
      state: "available",
      aliases: ["guardian-nuke"],
      transportConfigs: [],
      currentHead: null,
    },
  });
});

test("denies an effective transport inspection failure", () => {
  assertBlocked("git fetch origin", {
    inspection: { state: "failed", stage: "git-config", reason: "git config inspection failed" },
  });
});
