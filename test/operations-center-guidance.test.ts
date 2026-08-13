import assert from "node:assert/strict";
import test from "node:test";
import { actionGuidance } from "../src/operations-center/guidance.ts";
import type { OperationsCenterActionId } from "../src/operations-center/model.ts";
import { OPERATIONS_CENTER_CONTROLLER } from "../src/operations-center/controller.ts";

test("Given every Operations Center action, when guidance is requested, then it only describes Guardian-native read-only next steps", () => {
  // Given
  const path = "/repo/.worktrees/example path";

  // When
  const actions = ["add", "sync", "fetch", "pull", "switch", "open", "terminal", "remove"] as const satisfies readonly OperationsCenterActionId[];
  const guidance = actions.map((id) => actionGuidance({ id, path }));

  // Then
  assert.deepEqual(guidance.map((entry) => entry.id), ["add", "sync", "fetch", "pull", "switch", "open", "terminal", "remove"]);
  assert.match(guidance[0]?.instruction ?? "", /guardian_start createWorktree=true/);
  assert.match(guidance[1]?.instruction ?? "", /guardian_goal mode=plan/);
  assert.match(guidance[2]?.instruction ?? "", /guardian_status/);
  assert.match(guidance[3]?.instruction ?? "", /cached report/);
  assert.match(guidance[4]?.instruction ?? "", /OpenCode session/);
  assert.match(guidance[5]?.instruction ?? "", /OpenCode session/);
  assert.match(guidance[6]?.instruction ?? "", /OpenCode session/);
  assert.match(guidance[7]?.instruction ?? "", /guardian_delete_worktree mode=plan targetPath="\/repo\/\.worktrees\/example path"/);
});

test("Given the controller source, when selecting precomputed guidance, then it contains no Guardian command vocabulary and supports complete tab keyboard activation", () => {
  // Then
  for (const command of ["guardian_start", "guardian_goal", "guardian_status", "guardian_delete_worktree"]) assert.doesNotMatch(OPERATIONS_CENTER_CONTROLLER, new RegExp(command));
  for (const token of ["ArrowLeft", "ArrowRight", "Home", "End", "Enter", " ", "tabindex", "aria-selected", "textContent"]) assert.match(OPERATIONS_CENTER_CONTROLLER, new RegExp(token));
});
