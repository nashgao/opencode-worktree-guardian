import assert from "node:assert/strict";
import test from "node:test";
import { buildTopologyDisplayModel } from "../src/operations-center/topology-model.ts";
import { TOPOLOGY_MODES, type OperationsCenterWorktree } from "../src/operations-center/model.ts";

test("Given observed worktrees and events, when deriving topology display data, then all modes retain only explicit relationships and unavailable facts", () => {
  // Given
  const worktrees = [
    { id: "primary", path: "/repo", branch: "main", head: "abc", flags: { primary: true, linked: false, detached: false, bare: false }, owner: { state: "unowned" as const, sessionId: null, status: null }, state: "primary", tone: "neutral", risk: { external: false, orphaned: false, poisoned: false }, baseDistance: { status: "unavailable" as const, reason: "not-an-active-session-worktree" } },
    { id: "linked", path: "/repo/.worktrees/linked", branch: "guardian/linked", head: "def", flags: { primary: false, linked: true, detached: false, bare: false }, owner: { state: "owned" as const, lifecycle: "active" as const, sessionId: "ses_linked", status: "active", path: "/repo/.worktrees/linked" }, state: "active", tone: "good", risk: { external: false, orphaned: false, poisoned: false }, baseDistance: { status: "unavailable" as const, reason: "unavailable" } },
  ] satisfies readonly OperationsCenterWorktree[];

  // When
  const topology = buildTopologyDisplayModel({ worktrees, observedEvents: [{ kind: "terminal-recovery-action", sessionId: "ses_linked", at: null, action: null }] });

  // Then
  assert.deepEqual(topology.modes, TOPOLOGY_MODES);
  assert.deepEqual(topology.edges, [{ from: "primary", to: "linked", verification: "unverified", label: "Unverified relationship" }]);
  assert.equal(topology.primaryWorktreeId, "primary");
  assert.equal(topology.events[0]?.at, null);
  assert.match(topology.unavailable.timeline, /Unavailable/);
  assert.match(topology.unavailable.gitTree, /Commit ancestry/);
  assert.match(topology.unavailable.radar, /illustrative/);
});
