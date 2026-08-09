import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, expandWorktreeRoot } from "../src/config.ts";
import { formatGuardianStatusOutput } from "../src/plugin/readable-output-status.ts";
import { guardianStatus } from "../src/recover.ts";
import { createRepo, git, seedSession } from "./helpers.ts";

test("Given an unowned terminal Guardian worktree, when status is read, then it recommends a reattach plan", async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const branch = "guardian/status-terminal-reattach";
  const worktreePath = path.join(repo, expandWorktreeRoot(DEFAULT_CONFIG.worktreeRoot, repo), "terminal-reattach");
  await git(repo, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
  const { stdout: head } = await git(worktreePath, ["rev-parse", "HEAD"]);
  await seedSession(repo, {
    session_id: "ses_terminal_reattach",
    status: "finished",
    branch,
    worktree_path: worktreePath,
    base_ref: "origin/main",
    head_commit: head,
    safety_refs: [],
  });

  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(status.terminalRecoveryActionCount, 1);
  assert.equal(status.terminalRecoveryActionOmittedCount, 0);
  assert.deepEqual(status.terminalRecoveryActions, [{
    kind: "reattach",
    sessionId: "ses_terminal_reattach",
    status: "finished",
    branch,
    head,
    worktreePath,
    command: `guardian_done cwd=${worktreePath} mode=plan`,
  }]);
  const output = formatGuardianStatusOutput("guardian_status", status);
  assert.match(output, /Terminal Recovery Plans\n  Available plans: 1 \| omitted: 0\n  - guardian_done cwd=/);
});

test("Given terminal-owned stale branches, when status is read, then it recommends only bounded direct cleanup plans", async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const terminalStatuses = ["deleted", "abandoned", "finished", "preserved", "deleted", "abandoned"] as const;

  for (const [index, terminalStatus] of terminalStatuses.entries()) {
    const branch = `guardian/status-terminal-${index}`;
    const sessionId = `ses_status_terminal_${index}`;
    await git(repo, ["branch", branch, "main"]);
    const { stdout: head } = await git(repo, ["rev-parse", branch]);
    await seedSession(repo, {
      session_id: sessionId,
      status: terminalStatus,
      branch,
      worktree_path: `${repo}/.worktrees/opencode-worktree-guardian/${sessionId}`,
      base_ref: "origin/main",
      head_commit: head,
      safety_refs: [],
    });
  }

  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(status.terminalRecoveryActionCount, 6);
  assert.equal(status.terminalRecoveryActionOmittedCount, 1);
  assert.equal(status.terminalRecoveryActions.length, 5);
  assert.deepEqual(new Set(status.terminalRecoveryActions.map((action) => action.status)), new Set(["deleted", "abandoned", "finished", "preserved"]));
  for (const action of status.terminalRecoveryActions) {
    assert.equal(action.kind, "cleanup");
    assert.match(action.command, /^guardian_delete_worktree mode=plan sessionId=ses_status_terminal_\d deleteBranch=true$/);
  }
  const output = formatGuardianStatusOutput("guardian_status", status);
  assert.match(output, /Terminal Recovery Plans\n  Available plans: 6 \| omitted: 1/);
  assert.doesNotMatch(output, /rm -rf|git branch -D|git worktree remove/);
});

test("Given protected and rescue terminal branches, when status is read, then it omits only the protected cleanup plan", async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const protectedBranch = "guardian/status-protected-terminal";
  const rescueBranch = "rescue/status-terminal";
  const config = { ...DEFAULT_CONFIG, protectedBranches: [...DEFAULT_CONFIG.protectedBranches, protectedBranch] };

  for (const [branch, sessionId] of [[protectedBranch, "ses_status_protected_terminal"], [rescueBranch, "ses_status_rescue_terminal"]]) {
    await git(repo, ["branch", branch, "main"]);
    const { stdout: head } = await git(repo, ["rev-parse", branch]);
    await seedSession(repo, {
      session_id: sessionId,
      status: "deleted",
      branch,
      worktree_path: `${repo}/.worktrees/opencode-worktree-guardian/${sessionId}`,
      base_ref: "origin/main",
      head_commit: head,
      safety_refs: [],
    }, config);
  }

  const status = await guardianStatus({ repoRoot: repo, config });

  assert.deepEqual(status.terminalRecoveryActions.map((action) => action.command), ["guardian_delete_worktree mode=plan sessionId=ses_status_rescue_terminal deleteBranch=true"]);
});

test("Given active and terminal sessions share a stale branch, when status is read, then it does not recommend cleanup", async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const branch = "guardian/status-active-owner";
  const { stdout: head } = await git(repo, ["rev-parse", "main"]);
  await git(repo, ["branch", branch, head]);
  await seedSession(repo, {
    session_id: "ses_status_active_owner",
    status: "active",
    branch,
    worktree_path: `${repo}/.worktrees/opencode-worktree-guardian/active-owner`,
    base_ref: "origin/main",
    head_commit: head,
    safety_refs: [],
  });
  await seedSession(repo, {
    session_id: "ses_status_terminal_owner",
    status: "deleted",
    branch,
    worktree_path: `${repo}/.worktrees/opencode-worktree-guardian/terminal-owner`,
    base_ref: "origin/main",
    head_commit: head,
    safety_refs: [],
  });

  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(status.terminalRecoveryActionCount, 0);
  assert.deepEqual(status.terminalRecoveryActions, []);
});

test("Given duplicate terminal targets, when status is read, then unique plans are counted before the display bound", async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const reattachBranch = "guardian/status-duplicate-reattach";
  const reattachWorktree = path.join(repo, expandWorktreeRoot(DEFAULT_CONFIG.worktreeRoot, repo), "duplicate-reattach");
  await git(repo, ["worktree", "add", "-b", reattachBranch, reattachWorktree, "HEAD"]);
  const { stdout: reattachHead } = await git(reattachWorktree, ["rev-parse", "HEAD"]);
  for (const sessionId of ["ses_duplicate_reattach_a", "ses_duplicate_reattach_b"]) {
    await seedSession(repo, {
      session_id: sessionId,
      status: "finished",
      branch: reattachBranch,
      worktree_path: reattachWorktree,
      base_ref: "origin/main",
      head_commit: reattachHead,
      safety_refs: [],
    });
  }
  const cleanupBranch = "guardian/status-duplicate-cleanup";
  const { stdout: cleanupHead } = await git(repo, ["rev-parse", "main"]);
  await git(repo, ["branch", cleanupBranch, cleanupHead]);
  for (const index of [0, 1, 2, 3, 4, 5]) {
    await seedSession(repo, {
      session_id: `ses_duplicate_cleanup_0${index}`,
      status: "deleted",
      branch: cleanupBranch,
      worktree_path: `${repo}/.worktrees/opencode-worktree-guardian/duplicate-cleanup-${index}`,
      base_ref: "origin/main",
      head_commit: cleanupHead,
      safety_refs: [],
    });
  }
  for (const index of [0, 1, 2, 3, 4]) {
    const branch = `guardian/status-unique-cleanup-${index}`;
    await git(repo, ["branch", branch, cleanupHead]);
    await seedSession(repo, {
      session_id: `ses_unique_cleanup_${index}`,
      status: "preserved",
      branch,
      worktree_path: `${repo}/.worktrees/opencode-worktree-guardian/unique-cleanup-${index}`,
      base_ref: "origin/main",
      head_commit: cleanupHead,
      safety_refs: [],
    });
  }

  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(status.terminalRecoveryActionCount, 7);
  assert.equal(status.terminalRecoveryActionOmittedCount, 2);
  assert.deepEqual(status.terminalRecoveryActions.map((action) => action.sessionId), ["ses_duplicate_cleanup_00", "ses_duplicate_reattach_a", "ses_unique_cleanup_0", "ses_unique_cleanup_1", "ses_unique_cleanup_2"]);
});
