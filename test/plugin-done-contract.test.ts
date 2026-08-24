import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import plugin from "../src/index.ts";
import { maybeInjectPlanConfirmToken, rememberPlanConfirmToken } from "../src/plugin/plan-token-cache.ts";
import { formatGuardianOutput } from "../src/plugin/readable-output.ts";
import { createToolContext, metadataRecord, runTool } from "./plugin-contract-helpers.ts";
import type { PlanCacheToolArgs, PlanTokenCache } from "../src/types.ts";

test("guardian_done tool execute returns readable primary-main plan output with raw metadata", async () => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const path = await import("node:path");
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "contract-done.txt"), "done\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context, metadataCalls } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_done.execute;

  const result = await runTool(execute, { repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: contract done" }, context);

  assert.equal(typeof result.output, "string");
  assert.equal(typeof result.metadata, "object");
  assert.equal(result.metadata.status, "planned");
  assert.equal(result.metadata.lane, "primary-main-publish");
  assert.deepEqual(metadataCalls, [{ title: "guardian_done" }]);
  assert.match(result.output, /guardian_done planned/);
  assert.match(result.output, /lane: primary-main-publish/);
  assert.match(result.output, /commitMessage: feat: contract done/);
  assert.match(result.output, /confirm=true/);
  assert.doesNotMatch(result.output, /confirmToken|sessionId/);
  assert.equal(typeof result.metadata.confirmToken, "string");
  assert.match(result.output, /contract-done.txt/);
});

test("guardian_done tool direct preserve-only plan is read-only", async (t) => {
  const { createRepoWithOrigin, git } = await import("./helpers.ts");
  const path = await import("node:path");
  const { guardianStatus } = await import("../src/recover.ts");
  const { guardianStart } = await import("../src/tools.ts");
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_contract_done_plan_preserve", taskName: "contract done plan preserve", createWorktree: true });
  const worktree = started.session.worktree_path;
  await fs.writeFile(path.join(worktree, "contract-plan-preserve.txt"), "contract plan preserve\n");
  await git(worktree, ["add", "contract-plan-preserve.txt"]);
  await git(worktree, ["commit", "-m", "add contract plan preserve work"]);
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context, metadataCalls } = createToolContext();
  context.directory = worktree;
  context.worktree = worktree;
  const execute = hooks.tool.guardian_done.execute;

  const result = await runTool(execute, { repoRoot: repo, cwd: worktree, sessionId: "ses_contract_done_plan_preserve", mode: "plan", finishMode: "preserve-only", timestamp: "20260609T070707" }, context);

  assert.equal(result.metadata.status, "planned");
  assert.equal(result.metadata.lane, "session-finish");
  assert.equal(result.metadata.safetyRef, undefined);
  assert.deepEqual(metadataCalls, [{ title: "guardian_done" }]);
  assert.match(result.output, /guardian_done planned/);
  assert.match(result.output, /lane: session-finish/);
  assert.match(result.output, /guardian_done mode=apply confirm=true finishMode=preserve-only/);
  const status = await guardianStatus({ repoRoot: repo });
  assert.equal(status.activeSessions.some((session: Record<string, unknown>) => session.session_id === "ses_contract_done_plan_preserve"), true);
  assert.equal(status.safetyRefs.length, 0);
  const { stdout: refs } = await git(repo, ["for-each-ref", "--format=%(refname)", "refs/opencode-guardian"]);
  assert.equal(refs, "");
});

test("guardian_done plugin confirm reuses matching plan token for primary publish", async () => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const path = await import("node:path");
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "contract-confirm-done.txt"), "done\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_done.execute;

  const plan = await runTool(execute, { repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: contract confirm done" }, context);
  const apply = await runTool(execute, { repoRoot: repo, cwd: repo, mode: "apply", commitMessage: "feat: contract confirm done", confirm: true, confirmToken: "" }, context);

  assert.equal(plan.metadata.status, "planned");
  assert.equal(apply.metadata.status, "published");
  assert.equal(apply.metadata.lane, "primary-main-publish");
  assert.equal(metadataRecord(apply.metadata, "postCompletionHygiene").status, "satisfied");
  assert.match(apply.output, /post-completion hygiene: satisfied/);
  const { git } = await import("./helpers.ts");
  const { stdout: remoteMain } = await git(repo, ["rev-parse", "origin/main"]);
  assert.equal(remoteMain, apply.metadata.commit);
});

test("guardian_done readable done-all output includes cleanup plan details", () => {
  const output = formatGuardianOutput("guardian_done", {
    ok: true,
    status: "planned-partial",
    lane: "done-all",
    confirmToken: "token",
    summary: { total: 1, finishable: 1, dirtySkipped: 0, blocked: 0 },
    sessions: [{ session_id: "ses_active", branch: "guardian/session-ses-active", disposition: "finishable", head: "1234567890abcdef" }],
    cleanupPlan: {
      ok: true,
      status: "planned-partial",
      preflight: { stashCount: 1 },
      candidates: [{ kind: "worktree", targetKind: "worktree", branch: "guardian/session-ses-old", targetPath: "/repo/.worktrees/repo/old", head: "abcdef1234567890" }],
      blockers: [{ kind: "worktree", branch: "guardian/session-ses-blocked", targetPath: "/repo/.worktrees/repo/blocked", head: "fedcba0987654321", reason: "worktree branch is not proven reachable from base ref" }],
    },
  });

  assert.match(output, /cleanupPlan: planned-partial candidates=1 blockers=1/);
  assert.match(output, /^\[WARN\] guardian_done planned-partial/);
  assert.match(output, /cleanup candidates:/);
  assert.match(output, /branch=guardian\/session-ses-old/);
  assert.match(output, /cleanup blockers:/);
  assert.match(output, /branch=guardian\/session-ses-blocked/);
  assert.match(output, /\[WARN\] repository stash inventory: 1/);
});

test("guardian_done done-all renders retirement evidence from the production cleanup sweep nesting", () => {
  const active = { remote: "origin", remoteBranch: "guardian/active", head: "abcdef1234567890", observedHead: "fedcba0987654321", safetyRef: "refs/opencode-guardian/active", reservationPhase: "active" };
  const pending = { remote: "origin", remoteBranch: "guardian/pending", head: "1122334455667788", observedHead: "8877665544332211", reservationPhase: "pending-proof" };
  const output = formatGuardianOutput("guardian_done", {
    ok: false,
    status: "partial",
    lane: "done-all",
    summary: {},
    freshPlanRequired: true,
    cleanupSweep: {
      ok: false,
      status: "partial",
      candidateCount: 0,
      cleanedCount: 0,
      failedCount: 0,
      retirementCandidateCount: 2,
      retiredCount: 1,
      retirementFailedCount: 1,
      applyWorkCount: 2,
      plan: { reservationRetirementCandidates: [active, pending] },
      apply: { reservationRetirementResults: [{ ...active, status: "retired" }, { ...pending, status: "blocked" }] },
    },
  });

  assert.match(output, /cleanupSweep: ok=false status=partial candidates=0 cleaned=0 failed=0 retirementCandidates=2 retired=1 retirementFailed=1 applyWork=2/);
  assert.match(output, /reservation retirement candidates: 2/);
  assert.match(output, /reservation retirement results: 2/);
  assert.match(output, /reservationPhase=active .*safety ref preserved=true/);
  assert.match(output, /reservationPhase=pending-proof .*safety-ref proof absent\/pending/);
  assert.match(output, /fresh plan required before cleanup/);
});

test("guardian_done retirement evidence deduplicates production-shaped nested reservations", () => {
  const reservation = {
    remote: "origin",
    remoteBranch: "guardian/duplicate",
    head: "abcdef1234567890",
    observedHead: "fedcba0987654321",
    reservationPhase: "active",
    safetyRef: "refs/opencode-guardian/duplicate",
    action: "retire",
    remoteBranchPresent: true,
  };
  const distinctReservation = { ...reservation, remoteBranch: "guardian/distinct", head: "1122334455667788" };
  const deferred = {
    kind: "reservation-retirement",
    status: "blocked",
    reason: "pending proof",
    reservationRetirementCandidates: [reservation],
  };
  const output = formatGuardianOutput("guardian_done", {
    ok: false,
    status: "partial",
    lane: "done-all",
    cleanupSweep: {
      preflight: { reservationRetirementCandidateCount: 1, reservationRetirementResultCount: 1 },
      reservationRetirementCandidates: [reservation],
      reservationRetirementResults: [{ ...reservation, status: "blocked" }],
      remaining: [deferred, { ...deferred, reservationRetirementCandidates: [distinctReservation] }],
      plan: {
        reservationRetirementCandidates: [{ ...reservation }],
        apply: {
          reservationRetirementResults: [{ ...reservation, status: "blocked" }],
          remaining: [{ ...deferred, reservationRetirementCandidates: [{ ...reservation }] }],
        },
      },
      apply: {
        reservationRetirementCandidates: [{ ...reservation }],
        reservationRetirementResults: [{ ...reservation, status: "retired" }],
        remaining: [{ ...deferred, reservationRetirementCandidates: [{ ...reservation }] }],
      },
    },
  });

  assert.match(output, /reservation retirement candidates: 1/);
  assert.match(output, /reservation retirement results: 1/);
  assert.match(output, /deferred cleanup: 2/);
  assert.match(output, /status=retired .*remoteBranch=guardian\/duplicate/);
  assert.doesNotMatch(output, /status=blocked .*remoteBranch=guardian\/duplicate/);
  assert.equal((output.match(/remoteBranch=guardian\/duplicate/g) ?? []).length, 2);
});

test("guardian_done readable output warns about advisory stash inventory", () => {
  const output = formatGuardianOutput("guardian_done", {
    ok: true,
    status: "planned",
    lane: "primary-main-publish",
    preflight: { currentBranch: "main", baseBranch: "main" },
    stashCount: 1,
    dirtySnapshot: { paths: ["src/example.ts"] },
  });

  assert.match(output, /\[WARN\] repository stash inventory: 1/);
  assert.match(output, /Guardian will not mutate stashes/);
});

test("guardian_done readable output shows selected target and dirty target choices", () => {
  const selected = formatGuardianOutput("guardian_done", {
    ok: true,
    status: "planned",
    lane: "session-finish",
    branch: "guardian/session-ses-selected",
    worktreePath: "/repo/.worktrees/repo/selected",
    dirtyFiles: ["feature.txt"],
    selectedTarget: {
      targetKind: "session",
      sessionId: "ses_selected",
      branch: "guardian/session-ses-selected",
      worktreePath: "/repo/.worktrees/repo/selected",
      dirtyFiles: ["feature.txt"],
    },
  });
  const ambiguous = formatGuardianOutput("guardian_done", {
    ok: false,
    status: "needs-selection",
    lane: "select-target",
    reason: "multiple dirty implementation targets require an explicit guardian_done target",
    candidates: [
      { targetKind: "primary", branch: "main", worktreePath: "/repo", dirtyFiles: ["primary.txt"] },
      { targetKind: "session", sessionId: "ses_dirty", branch: "guardian/session-ses-dirty", worktreePath: "/repo/.worktrees/repo/dirty", dirtyFiles: ["session.txt"] },
    ],
    suggestedCommands: ["guardian_done primary=true commitMessage=...", "guardian_done branch=guardian/session-ses-dirty commitMessage=..."],
  });

  assert.match(selected, /selectedTarget: session/);
  assert.match(selected, /session=ses_selected/);
  assert.match(selected, /dirty=1/);
  assert.match(ambiguous, /dirty target candidates: 2/);
  assert.match(ambiguous, /target=primary/);
  assert.match(ambiguous, /target=session/);
  assert.match(ambiguous, /guardian_done primary=true commitMessage=\.\.\./);
});

test("guardian_done readable output shows hygiene guidance for local artifacts", () => {
  const output = formatGuardianOutput("guardian_done", {
    ok: false,
    status: "blocked-workspace-hygiene-required",
    lane: "session-finish",
    branch: "guardian/session-ses-hygiene",
    dirtyFiles: [".omc/session.json", "export.tsv", "people-counter-report.csv", "nested-clone/file.txt"],
    reason: "dirty session work is limited to hygiene or generated local artifacts; clean, delete, or ignore them before guardian_done",
    knownCleanablePaths: ["export.tsv"],
    reviewablePaths: ["people-counter-report.csv"],
    ignoreCandidates: [".omc"],
    manualReviewCandidates: ["nested-clone"],
    hygienePlan: { ok: true, status: "planned", targets: [{ path: "export.tsv" }], blockers: [] },
    deletePathsPlan: { ok: true, status: "planned", targets: [{ path: "people-counter-report.csv" }], blockers: [] },
    nextActions: [
      "plan/apply guardian_hygiene for known-cleanable paths",
      "plan/apply guardian_delete_paths for generated reviewable artifacts",
      "rerun guardian_done after cleanup or ignore rules are in place",
    ],
  });

  assert.match(output, /guardian_done blocked-workspace-hygiene-required/);
  assert.match(output, /guardian_hygiene candidates:/);
  assert.match(output, /export.tsv/);
  assert.match(output, /guardian_delete_paths candidates:/);
  assert.match(output, /people-counter-report.csv/);
  assert.match(output, /ignore candidates:/);
  assert.match(output, /\.omc/);
  assert.match(output, /manual review candidates:/);
  assert.match(output, /nested-clone/);
  assert.match(output, /hygienePlan: planned targets=1 blockers=0/);
  assert.match(output, /deletePathsPlan: planned targets=1 blockers=0/);
  assert.match(output, /next actions:/);
  assert.doesNotMatch(output, /commitMessage is required/);
});

test("guardian_done tool execute treats empty optional strings as absent", async () => {
  const { createRepoWithOrigin } = await import("./helpers.ts");
  const path = await import("node:path");
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "contract-empty-args.txt"), "done\n");
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  context.sessionID = "ses_empty_optional";
  const execute = hooks.tool.guardian_done.execute;

  const result = await runTool(execute, {
    repoRoot: "",
    cwd: "",
    sessionId: "",
    branch: "",
    targetPath: "",
    worktreePath: "",
    confirmToken: "",
    mode: "plan",
    cleanupPaths: [],
    allowCategories: [],
    commitMessage: "feat: empty optional args",
  }, context);

  assert.equal(result.metadata.status, "planned");
  assert.equal(result.metadata.lane, "primary-main-publish");
  assert.equal(result.metadata.preflight.repoRoot, repo);
  assert.equal(result.metadata.preflight.currentWorktree, repo);
  assert.doesNotMatch(result.output, /confirmToken|sessionId/);
});
