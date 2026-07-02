import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHudModel, type HudStatusInput } from "../src/hud/model.ts";

const FIXED = "2026-06-14T00:00:00.000Z";

function baseInput(overrides: Partial<HudStatusInput> = {}): HudStatusInput {
  return {
    repoRoot: "/repo",
    worktrees: [],
    sessions: [],
    activeSessions: [],
    terminalSessions: [],
    orphanedSessions: [],
    worktreesWithoutState: [],
    branchesWithoutWorktrees: [],
    safetyRefs: [],
    stashes: [],
    dirtyFiles: [],
    ...overrides,
  };
}

test("empty state yields zeroed metrics and no risks", () => {
  const model = buildHudModel(baseInput(), FIXED);
  assert.equal(model.generatedAt, FIXED);
  assert.deepEqual(model.worktrees, []);
  assert.deepEqual(model.risks, []);
  assert.equal(model.safetyRefTotal, 0);
  assert.equal(model.metrics.find((m) => m.label === "Worktrees")?.value, 0);
  assert.equal(model.metrics.find((m) => m.label === "Orphaned")?.tone, "good");
});

test("attributes owning active session and safety refs to a worktree", () => {
  const model = buildHudModel(baseInput({
    worktrees: [
      { path: "/repo", branch: "main", head: "abcdef1234567890" },
      { path: "/repo/.wt/feature", branch: "guardian/feature", head: "1234567890abcdef" },
    ],
    activeSessions: [
      { session_id: "ses_abc", status: "active", branch: "guardian/feature", worktree_path: "/repo/.wt/feature" },
    ],
    sessions: [
      { session_id: "ses_abc", status: "active", branch: "guardian/feature", worktree_path: "/repo/.wt/feature" },
    ],
    safetyRefs: [
      { name: "refs/opencode-guardian/ses_abc/guardian/feature/20260601", commit: "c1", date: "d", subject: "s" },
      { name: "refs/opencode-guardian/ses_abc/guardian/feature/20260602", commit: "c2", date: "d", subject: "s" },
      { name: "refs/opencode-guardian/ses_other/x/20260603", commit: "c3", date: "d", subject: "s" },
    ],
  }), FIXED);

  const [primary, owned] = model.worktrees;
  assert.equal(primary?.isPrimary, true);
  assert.equal(primary?.tone, "neutral");
  assert.equal(primary?.session, null);
  assert.equal(primary?.head, "abcdef123456");

  assert.equal(owned?.isPrimary, false);
  assert.equal(owned?.tone, "good");
  assert.equal(owned?.session?.sessionId, "ses_abc");
  assert.equal(owned?.session?.safetyRefCount, 2);
  assert.equal(model.safetyRefTotal, 3);
});

test("treats primary repo root as benign even when listed without state", () => {
  const model = buildHudModel(baseInput({
    worktrees: [{ path: "/repo", branch: "main", head: "abc" }],
    worktreesWithoutState: [
      { path: "/repo", branch: "main", head: "abc", category: "external-worktree", severity: "fail", reason: "outside" },
    ],
  }), FIXED);
  const [primary] = model.worktrees;
  assert.equal(primary?.tone, "neutral");
  assert.deepEqual(primary?.flags, []);
  assert.deepEqual(model.risks, []);
});

test("flags external worktree without state as a fail risk", () => {
  const model = buildHudModel(baseInput({
    worktrees: [{ path: "/tmp/external", branch: "x", head: "deadbeef" }],
    worktreesWithoutState: [
      { path: "/tmp/external", branch: "x", head: "deadbeef", category: "external-temp-worktree", severity: "fail", reason: "outside" },
    ],
  }), FIXED);
  const [wt] = model.worktrees;
  assert.equal(wt?.tone, "bad");
  assert.ok(wt?.flags.includes("external-temp-worktree"));
  assert.ok(model.risks.some((r) => r.severity === "fail" && r.label === "external-temp-worktree"));
});

test("orphaned sessions, dirty files, stashes, and hygiene produce risks", () => {
  const model = buildHudModel(baseInput({
    orphanedSessions: [{ session_id: "ses_orphan", status: "active", branch: "guardian/lost" }],
    dirtyFiles: ["src/a.ts", "src/b.ts"],
    stashes: [{ name: "stash@{0}", commit: "s1", message: "wip" }],
    hygiene: { summary: { findingCount: 3, bySeverity: { fail: 1, warn: 2 } } },
  }), FIXED);
  assert.ok(model.risks.some((r) => r.label === "orphaned session" && r.detail.includes("ses_orphan")));
  assert.ok(model.risks.some((r) => r.label === "dirty files"));
  assert.ok(model.risks.some((r) => r.label === "stashes"));
  assert.ok(model.risks.some((r) => r.severity === "warn" && r.label === "hygiene needs review"));
  assert.equal(model.metrics.find((m) => m.label === "Dirty")?.tone, "bad");
  assert.equal(model.metrics.find((m) => m.label === "Hygiene")?.tone, "warn");
});

test("buckets sessions by lifecycle status, sorted by count", () => {
  const model = buildHudModel(baseInput({
    sessions: [
      { session_id: "a", status: "deleted" },
      { session_id: "b", status: "deleted" },
      { session_id: "c", status: "active" },
    ],
  }), FIXED);
  assert.deepEqual(model.lifecycle, [
    { status: "deleted", count: 2 },
    { status: "active", count: 1 },
  ]);
});

test("lists branches without worktrees with short commits", () => {
  const model = buildHudModel(baseInput({
    branchesWithoutWorktrees: [{ name: "tooling/preserve", commit: "0123456789abcdef" }],
  }), FIXED);
  assert.deepEqual(model.branchesWithoutWorktree, [{ name: "tooling/preserve", head: "0123456789ab" }]);
});

test("empty state yields a clean good verdict", () => {
  const model = buildHudModel(baseInput(), FIXED);
  assert.equal(model.verdict.tone, "good");
  assert.match(model.verdict.headline, /clean, no risks detected/);
  assert.equal(model.verdict.nextAction, null);
});

test("poisoned session drives a fail verdict and a matching risk", () => {
  const model = buildHudModel(baseInput({
    activeSessions: [{ session_id: "ses_p", status: "active", branch: "main", worktree_path: "/repo" }],
    poisonedSessions: [{ session_id: "ses_p", status: "active", branch: "main", worktree_path: "/repo" }],
  }), FIXED);
  assert.equal(model.verdict.tone, "bad");
  assert.match(model.verdict.headline, /poisoned session/);
  assert.ok(model.risks.some((r) => r.label === "poisoned session" && r.detail.includes("ses_p")));
});

test("state branch without a worktree is a warn verdict and risk", () => {
  const model = buildHudModel(baseInput({
    stateBranchesWithoutWorktrees: ["guardian/stranded"],
  }), FIXED);
  assert.equal(model.verdict.tone, "warn");
  assert.ok(model.risks.some((r) => r.label === "branch without worktree" && r.detail === "guardian/stranded"));
});
