import assert from "node:assert/strict";
import test from "node:test";
import { computeGuardianVerdict } from "../src/verdict.ts";

test("clean repo with no active sessions reads good with no next action", () => {
  const verdict = computeGuardianVerdict({ ok: true, repoRoot: "/repo", activeSessions: [] });
  assert.equal(verdict.tone, "good");
  assert.equal(verdict.headline, "No active Guardian sessions — clean, no risks detected.");
  assert.equal(verdict.nextAction, null);
});

test("single clean active session names its branch", () => {
  const verdict = computeGuardianVerdict({
    ok: true,
    repoRoot: "/repo",
    activeSessions: [{ session_id: "ses_1", branch: "guardian/foo" }],
  });
  assert.equal(verdict.tone, "good");
  assert.equal(verdict.headline, "1 active session on guardian/foo — clean, no risks detected.");
  assert.equal(verdict.nextAction, null);
});

test("dirty files produce a warn verdict with a commit/done next action", () => {
  const verdict = computeGuardianVerdict({
    ok: true,
    repoRoot: "/repo",
    activeSessions: [{ branch: "guardian/foo" }],
    dirtyFiles: ["src/a.ts", "src/b.ts"],
  });
  assert.equal(verdict.tone, "warn");
  assert.match(verdict.headline, /2 dirty files uncommitted/);
  assert.match(verdict.nextAction ?? "", /guardian_done/);
});

test("orphaned session is a fail verdict", () => {
  const verdict = computeGuardianVerdict({
    ok: true,
    repoRoot: "/repo",
    activeSessions: [{ branch: "guardian/foo" }],
    orphanedSessions: [{ session_id: "ses_x" }],
  });
  assert.equal(verdict.tone, "bad");
  assert.match(verdict.headline, /1 orphaned session/);
  assert.match(verdict.nextAction ?? "", /guardian_recover/);
});

test("poisoned session is a fail verdict", () => {
  const verdict = computeGuardianVerdict({
    ok: true,
    repoRoot: "/repo",
    activeSessions: [{ branch: "main" }],
    poisonedSessions: [{ session_id: "ses_x", severity: "fail" }],
  });
  assert.equal(verdict.tone, "bad");
  assert.match(verdict.headline, /poisoned session/);
});

test("primary repo worktree-without-state is not counted as an external failure", () => {
  const verdict = computeGuardianVerdict({
    ok: true,
    repoRoot: "/repo",
    activeSessions: [],
    // guardianStatus always lists the primary repo here with severity:fail.
    worktreesWithoutState: [{ path: "/repo", severity: "fail", category: "external-worktree" }],
  });
  assert.equal(verdict.tone, "good");
  assert.match(verdict.headline, /clean, no risks detected/);
});

test("a genuine external worktree outside the repo root is a fail verdict", () => {
  const verdict = computeGuardianVerdict({
    ok: true,
    repoRoot: "/repo",
    activeSessions: [],
    worktreesWithoutState: [{ path: "/tmp/stray", severity: "fail", category: "external-temp-worktree" }],
  });
  assert.equal(verdict.tone, "bad");
  assert.match(verdict.headline, /outside Guardian ownership/);
});

test("fail outranks warn and extra signals are summarised with a +N suffix", () => {
  const verdict = computeGuardianVerdict({
    ok: true,
    repoRoot: "/repo",
    activeSessions: [{ branch: "guardian/foo" }],
    orphanedSessions: [{ session_id: "ses_x" }],
    dirtyFiles: ["src/a.ts"],
    stashes: ["stash@{0}"],
  });
  assert.equal(verdict.tone, "bad");
  assert.match(verdict.headline, /1 orphaned session/);
  assert.match(verdict.headline, /\(\+2 more\)/);
});

test("hygiene findings that need manual review produce a warn verdict", () => {
  const verdict = computeGuardianVerdict({
    ok: true,
    repoRoot: "/repo",
    activeSessions: [],
    hygiene: { summary: { findingCount: 3, bySeverity: { fail: 1, warn: 2 } } },
  });
  assert.equal(verdict.tone, "warn");
  assert.match(verdict.headline, /3 workspace hygiene findings \(1 manual-review item\)/);
  assert.match(verdict.nextAction ?? "", /guardian_hygiene/);
});

test("ok:false short-circuits to a fail verdict carrying the reason", () => {
  const verdict = computeGuardianVerdict({ ok: false, reason: "repo root not found" });
  assert.equal(verdict.tone, "bad");
  assert.equal(verdict.headline, "repo root not found");
});
