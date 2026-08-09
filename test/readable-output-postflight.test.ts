import assert from "node:assert/strict";
import test from "node:test";
import { formatGuardianOutput } from "../src/plugin/readable-output.ts";

const scope = {
  effectiveRemote: "origin",
  freshness: "freshly-fetched-effective-remote",
  localBranchCount: 3,
  effectiveRemoteBranchCount: 4,
  unexaminedSecondaryRemotes: ["backup\nremote", "mirror\tremote"],
};

const finalPostflight = {
  ok: false,
  status: "blocked",
  reason: "final cleanup postflight failed\nneeds review",
  baseRef: "origin/main",
  baseBranch: "main",
  baseHead: "1234567890abcdef",
  operationalScope: scope,
  blockers: Array.from({ length: 9 }, (_, index) => ({
    kind: "extra-local-branches",
    reason: `branch ${index}\tneeds cleanup`,
  })),
  droppedCommits: [{
    commit: "abcdef1234567890",
    source: "guardian/old",
    reason: "cleanup removed worktree",
    safetyRefs: ["refs/opencode-guardian/ses_old/guardian/old/20260809"],
  }],
  refInventory: {
    safetyOnlyRefCount: 1,
    activePreservedRefCount: 1,
    safetyOnlyRefs: [{ name: "refs/opencode-guardian/ses_old/guardian/old/20260809", commit: "abcdef1234567890", subject: "cleanup\nref" }],
    activePreservedRefs: [{ name: "refs/opencode-guardian/preserved/ses_keep", commit: "fedcba0987654321", subject: "kept\tref" }],
  },
};

test("guardian_status renders the operational scope without claiming a secondary remote scan", () => {
  // Given
  const result = {
    ok: true,
    repoRoot: "/repo",
    activeSessions: [],
    worktrees: [],
    operationalScope: { ...scope, freshness: "cached-read-only" },
  };

  // When
  const output = formatGuardianOutput("guardian_status", result);

  // Then
  assert.match(output, /Operational Scope/);
  assert.match(output, /effective remote: origin \| freshness: cached-read-only/);
  assert.match(output, /local branches: 3 \| effective-remote branches: 4/);
  assert.match(output, /secondary remotes were not branch-scanned: backup\\nremote, mirror\\tremote/);
});

test("guardian_finish_workflow renders bounded blocked postflight and cleanup evidence", () => {
  // Given
  const result = {
    ok: true,
    status: "planned-partial",
    preflight: { mode: "plan", currentBranch: "main", baseRef: "origin/main", baseRefOid: "1234567890abcdef", candidateScanStatus: "completed" },
    results: Array.from({ length: 9 }, (_, index) => ({ status: "deleted", branch: `guardian/old-${index}`, worktreeRemoved: true, branchDeleted: true, safetyRef: `refs/opencode-guardian/ses_${index}` })),
    finalPostflight,
  };

  // When
  const output = formatGuardianOutput("guardian_finish_workflow", result);

  // Then
  assert.match(output, /final postflight: blocked/);
  assert.match(output, /final postflight blockers: 9 \| omitted: 1/);
  assert.match(output, /cleanup results: 9 \| omitted: 1/);
  assert.match(output, /worktreeRemoved=true branchDeleted=true safetyRef=refs\/opencode-guardian\/ses_0/);
  assert.match(output, /safety refs: 1/);
  assert.match(output, /final cleanup postflight failed\\nneeds review/);
});

test("guardian_done renders final postflight evidence for a partial cleanup", () => {
  // Given
  const result = {
    ok: false,
    status: "partial",
    lane: "finish-workflow",
    preflight: { currentBranch: "main", baseBranch: "main" },
    finalPostflight,
  };

  // When
  const output = formatGuardianOutput("guardian_done", result);

  // Then
  assert.match(output, /^\[FAIL\] guardian_done partial/);
  assert.match(output, /final postflight: blocked/);
  assert.match(output, /secondary remotes were not branch-scanned/);
});

test("guardian_goal renders nested finish-workflow postflight evidence instead of only step counts", () => {
  // Given
  const result = {
    ok: false,
    status: "blocked",
    goal: { commitDirty: false, landToBase: false, pushBase: false, cleanupWorktrees: true, cleanupBranches: true, cleanupHygiene: false },
    steps: [{ tool: "guardian_finish_workflow", status: "planned-partial", ok: true, result: { status: "planned-partial", finalPostflight } }],
    blockers: [{ tool: "guardian_finish_workflow", reason: "final cleanup postflight failed" }],
  };

  // When
  const output = formatGuardianOutput("guardian_goal", result);

  // Then
  assert.match(output, /guardian_finish_workflow evidence:/);
  assert.match(output, /final postflight: blocked/);
  assert.match(output, /safety refs: 1/);
  assert.doesNotMatch(output, /cleanup\nref/);
});

test("guardian_goal renders bounded nested cleanup evidence without expanding clean steps", () => {
  // Given
  const cleanupEntries = Array.from({ length: 9 }, (_, index) => ({
    kind: "worktree",
    targetKind: "worktree",
    branch: `guardian/nested-${index}`,
    targetPath: `/repo/.worktrees/nested-${index}\tpath`,
    status: "deleted",
    worktreeRemoved: true,
    branchDeleted: true,
    safetyRef: `refs/opencode-guardian/nested-${index}`,
    reason: `cleanup ${index}\nreason`,
  }));
  const result = {
    ok: true,
    status: "planned-partial",
    goal: { commitDirty: true, landToBase: true, pushBase: true, cleanupWorktrees: true, cleanupBranches: true, cleanupHygiene: false },
    steps: [
      {
        tool: "guardian_done",
        status: "planned-partial",
        ok: true,
        result: {
          status: "planned-partial",
          candidates: cleanupEntries,
          cleanupPlan: { blockers: cleanupEntries },
          remaining: cleanupEntries,
          results: cleanupEntries,
        },
      },
      { tool: "guardian_finish_workflow", status: "planned", ok: true, result: { status: "planned" } },
    ],
    blockers: [],
  };

  // When
  const output = formatGuardianOutput("guardian_goal", result);

  // Then
  assert.match(output, /guardian_done evidence:/);
  assert.match(output, /cleanup candidates: 9 \| omitted: 1/);
  assert.match(output, /cleanup blockers: 9 \| omitted: 1/);
  assert.match(output, /remaining repo blockers: 9 \| omitted: 1/);
  assert.match(output, /cleanup results: 9 \| omitted: 1/);
  assert.match(output, /guardian\/nested-0/);
  assert.doesNotMatch(output, /guardian\/nested-8/);
  assert.match(output, /nested-0\\tpath/);
  assert.doesNotMatch(output, /cleanup 0\nreason/);
  assert.match(output, /guardian_finish_workflow evidence:/);
  assert.doesNotMatch(output, /guardian_finish_workflow evidence:\n\[INFO\] cleanup candidates/);
});

test("passed final postflight keeps non-empty recovery evidence bounded", () => {
  // Given
  const result = {
    ok: true,
    status: "planned",
    preflight: { mode: "plan", currentBranch: "main", baseRef: "origin/main", baseRefOid: "1234567890abcdef", candidateScanStatus: "completed" },
    finalPostflight: {
      ok: true,
      status: "passed",
      operationalScope: scope,
      droppedCommits: Array.from({ length: 9 }, (_, index) => ({ commit: `abcdef${index}1234567890`, source: `guardian/dropped-${index}` })),
      refInventory: {
        safetyOnlyRefCount: 9,
        safetyOnlyRefs: Array.from({ length: 9 }, (_, index) => ({ name: `refs/opencode-guardian/safety-${index}`, commit: `abcdef${index}1234567890`, subject: "recovery evidence" })),
        activePreservedRefCount: 1,
        activePreservedRefs: [{ name: "refs/opencode-guardian/preserved/keep", commit: "fedcba0987654321", subject: "preserved evidence" }],
      },
    },
  };

  // When
  const output = formatGuardianOutput("guardian_finish_workflow", result);

  // Then
  assert.match(output, /final postflight: passed/);
  assert.match(output, /dropped commits: 9 \| omitted: 1/);
  assert.match(output, /safety refs: 9 \| omitted: 1/);
  assert.match(output, /preserved refs: 1/);
});

test("blocked final postflight renders actionable compound blocker evidence safely", () => {
  // Given
  const result = {
    ok: false,
    status: "partial",
    lane: "finish-workflow",
    preflight: { currentBranch: "main", baseBranch: "main" },
    finalPostflight: {
      ok: false,
      status: "blocked",
      blockers: [{
        kind: "remote-branch",
        reason: "advanced reservation requires review",
        branch: "guardian/branch",
        remote: "origin\u202Egit clean",
        remoteBranch: "guardian/remote",
        targetPath: "/repo/.worktrees/target",
        path: "/repo/path",
        worktreePath: "/repo/worktree",
        head: "abcdef1234567890",
        observedHead: "fedcba0987654321",
        safetyRef: "refs/opencode-guardian/safety",
        branches: Array.from({ length: 9 }, (_, index) => `guardian/branch-${index}`),
        worktrees: Array.from({ length: 9 }, (_, index) => ({ branch: `guardian/worktree-${index}`, path: `/repo/worktree-${index}` })),
        stashes: Array.from({ length: 9 }, (_, index) => ({ name: `stash@{${index}}` })),
      }],
    },
  };

  // When
  const output = formatGuardianOutput("guardian_done", result);

  // Then
  assert.match(output, /branch=guardian\/branch remote=origin\\u202Egit clean remoteBranch=guardian\/remote/);
  assert.match(output, /targetPath=\/repo\/\.worktrees\/target path=\/repo\/path worktreePath=\/repo\/worktree/);
  assert.match(output, /head=abcdef123456 observedHead=fedcba098765 safetyRef=refs\/opencode-guardian\/safety/);
  assert.match(output, /blocker branches: 9 \| omitted: 1/);
  assert.match(output, /blocker worktrees: 9 \| omitted: 1/);
  assert.match(output, /blocker stashes: 9 \| omitted: 1/);
  assert.doesNotMatch(output, /\u202E/);
});

test("retirement evidence is bounded, preserved, and requires a fresh plan across output surfaces", () => {
  // Given
  const candidates = Array.from({ length: 8 }, (_, index) => ({
    kind: "remote-branch-reservation-retirement",
    remote: "origin",
    remoteBranch: `guardian/retire-${index}`,
    branch: `guardian/retire-${index}`,
    head: `abcdef${index}1234567890`,
    observedHead: `fedcba${index}9876543210`,
    safetyRef: `refs/opencode-guardian/retire-${index}`,
  }));
  const nested = {
    ok: false,
    status: "partial",
    preflight: { reservationRetirementCandidateCount: 9, reservationRetirementCandidateOmittedCount: 1 },
    reservationRetirementCandidates: candidates,
    reservationRetirementResults: [{ ...candidates[0], status: "retired" }],
    remaining: [{ kind: "reservation-retirement", status: "deferred", reason: "run a fresh plan before cleanup" }],
    freshPlanRequired: true,
  };

  // When
  const workflowOutput = formatGuardianOutput("guardian_finish_workflow", nested);
  const doneOutput = formatGuardianOutput("guardian_done", { ...nested, lane: "finish-workflow" });
  const goalOutput = formatGuardianOutput("guardian_goal", {
    ok: false,
    status: "partial",
    goal: {},
    blockers: [],
    steps: [{ tool: "guardian_finish_workflow", status: "partial", ok: false, result: nested }],
  });

  // Then
  for (const output of [workflowOutput, doneOutput, goalOutput]) {
    assert.match(output, /reservation retirement candidates: 9 \| omitted: 1/);
    assert.match(output, /reservation retirement results: 1/);
    assert.match(output, /remoteBranch=guardian\/retire-0 .*branch preserved=true.*safety ref preserved=true/);
    assert.match(output, /deferred cleanup: 1/);
    assert.match(output, /fresh plan required before cleanup/);
    assert.doesNotMatch(output, /remoteBranchDeleted=true|branchDeleted=true/);
  }
});

test("final postflight renders actual local and remote branch records without object coercion", () => {
  // Given
  const result = {
    ok: false,
    status: "partial",
    lane: "finish-workflow",
    preflight: { currentBranch: "main", baseBranch: "main" },
    finalPostflight: {
      ok: false,
      status: "blocked",
      blockers: [
        {
          kind: "base-branch-unsynced",
          reason: "local base differs from final base",
          baseBranch: "main\nbranch",
          baseRef: "origin/main",
          baseHead: "abcdef1234567890",
          localHead: "fedcba0987654321",
          commit: "1122334455667788",
          source: "guardian/source\tbranch",
        },
        {
          kind: "extra-local-branches",
          reason: "local branches remain",
          branches: [{ name: "guardian/local", commit: "1234567890abcdef" }],
        },
        {
          kind: "extra-remote-branches",
          reason: "remote branches remain",
          branches: [{ branch: "guardian/remote", commit: "0987654321abcdef" }],
        },
      ],
    },
  };

  // When
  const output = formatGuardianOutput("guardian_done", result);

  // Then
  assert.match(output, /baseBranch=main\\nbranch baseRef=origin\/main baseHead=abcdef123456 localHead=fedcba098765 commit=112233445566 source=guardian\/source\\tbranch/);
  assert.match(output, /name=guardian\/local commit=1234567890ab/);
  assert.match(output, /branch=guardian\/remote commit=0987654321ab/);
  assert.doesNotMatch(output, /\[object Object\]/);
});

test("retirement evidence distinguishes active safety refs from pending-proof reservations", () => {
  // Given
  const result = {
    ok: false,
    status: "partial",
    preflight: { reservationRetirementCandidateCount: 2 },
    reservationRetirementCandidates: [
      { remote: "origin", remoteBranch: "guardian/active", head: "abcdef1234567890", observedHead: "fedcba0987654321", safetyRef: "refs/opencode-guardian/active", reservationPhase: "active" },
      { remote: "origin", remoteBranch: "guardian/pending", head: "1122334455667788", observedHead: "8877665544332211", reservationPhase: "pending-proof" },
    ],
    reservationRetirementResults: [{ remote: "origin", remoteBranch: "guardian/active", head: "abcdef1234567890", observedHead: "fedcba0987654321", safetyRef: "refs/opencode-guardian/active", reservationPhase: "active", status: "retired" }],
    retirementCandidateCount: 2,
    retiredCount: 1,
    retirementFailedCount: 1,
    applyWorkCount: 2,
    freshPlanRequired: true,
  };

  // When
  const output = formatGuardianOutput("guardian_finish_workflow", result);

  // Then
  assert.match(output, /reservationPhase=active .*remote branch preserved=true safety ref preserved=true/);
  assert.match(output, /reservationPhase=pending-proof .*remote branch preserved=true safety-ref proof absent\/pending/);
  assert.doesNotMatch(output, /remoteBranch=guardian\/pending.*safety ref preserved=true/);
  assert.match(output, /retirement summary: candidates=2 applyWork=2 retired=1 failed=1/);
  assert.match(output, /fresh plan required before cleanup/);
});
