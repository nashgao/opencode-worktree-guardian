import assert from "node:assert/strict";
import test from "node:test";
import { classifyGuardCommand, classifyNormalAgentGitCommand } from "../src/guards.ts";

function assertBlocked(command: string): void {
  assert.equal(classifyGuardCommand(command).blocked, true, command);
  assert.equal(classifyNormalAgentGitCommand(command).allowed, false, command);
}

function assertAllowed(command: string): void {
  assert.equal(classifyGuardCommand(command).blocked, false, command);
  assert.equal(classifyNormalAgentGitCommand(command).allowed, true, command);
}

for (const command of [
  "G=git; $G reset --hard",
  "git${EMPTY} reset --hard",
  "eval \"git reset --hard\"",
  "printf 'git reset --hard\\n' | sh",
  "git.exe $(printf reset) --hard",
]) {
  test(`blocks opaque destructive execution: ${command}`, () => {
    assertBlocked(command);
  });
}

test("permits ordinary direct git inspection", () => {
  for (const command of ["git status --short", "git.exe status --short"]) {
    assertAllowed(command);
  }
});
