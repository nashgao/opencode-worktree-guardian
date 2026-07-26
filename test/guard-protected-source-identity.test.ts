import assert from "node:assert/strict";
import test from "node:test";
import { classifyGuardCommand, classifyNormalAgentGitCommand } from "../src/guards.ts";
import type { GuardOptions } from "../src/types.ts";

const currentHeadOid = "0123456789012345678901234567890123456789";
const guardianBranchOptions = {
  protectedBranches: ["main"],
  branchPrefix: "guardian/",
  currentBranch: "guardian/source-identity",
  inspection: {
    state: "available",
    aliases: [],
    transportConfigs: [],
    currentHead: currentHeadOid,
  },
} satisfies GuardOptions;

function assertBlocked(command: string): void {
  assert.equal(classifyGuardCommand(command, guardianBranchOptions).blocked, true, command);
  assert.equal(classifyNormalAgentGitCommand(command, guardianBranchOptions).allowed, false, command);
}

for (const source of ["@", "HEAD~0", "HEAD^0", "HEAD~00", "@~0", currentHeadOid, currentHeadOid.slice(0, 12)]) {
  test(`blocks a protected push from Guardian head spelling ${source}`, () => {
    // Given a Guardian branch HEAD expressed by an equivalent revision spelling.
    // When that spelling is pushed to a protected branch.
    // Then both guard paths reject the bypass.
    assertBlocked(`git push origin ${source}:refs/heads/main`);
  });
}

test("permits a Guardian head push to an ordinary feature destination", () => {
  const command = `git push origin ${currentHeadOid}:refs/heads/feature`;

  assert.equal(classifyGuardCommand(command, guardianBranchOptions).blocked, false, command);
  assert.equal(classifyNormalAgentGitCommand(command, guardianBranchOptions).allowed, true, command);
});
