import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { TOPOLOGY_MODES, buildOperationsCenterModel } from "../src/operations-center/model.ts";
import { guardianRecover, guardianStatus } from "../src/recover.ts";
import { guardianStart } from "../src/start.ts";
import { createRepoWithOrigin, git, seedSession } from "./helpers.ts";

const GENERATED_AT = "2026-08-13T12:00:00.000Z";

test("Given live Guardian status and recovery data, when building the operations model, then it maps ownership, base facts, risks, and observed events", async (t) => {
  // Given
  const fixture = await createRepoWithOrigin();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const started = await guardianStart({
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    sessionId: "ses_operations",
    taskName: "operations center model",
    createWorktree: true,
    config: DEFAULT_CONFIG,
  });
  const worktreePath = started.session.worktree_path;
  assert.equal(typeof worktreePath, "string");
  if (typeof worktreePath !== "string") throw new Error("expected Guardian start worktree path");
  await fs.writeFile(path.join(worktreePath, "ahead.txt"), "ahead\n");
  await git(worktreePath, ["add", "ahead.txt"]);
  await git(worktreePath, ["commit", "-m", "operations model base fact"]);
  const terminalBranch = "guardian/operations-terminal";
  await git(fixture.repo, ["branch", terminalBranch, "main"]);
  const { stdout: terminalHead } = await git(fixture.repo, ["rev-parse", terminalBranch]);
  await seedSession(fixture.repo, {
    session_id: "ses_operations_terminal",
    status: "finished",
    branch: terminalBranch,
    worktree_path: path.join(fixture.repo, ".worktrees", "operations-terminal"),
    head_commit: terminalHead,
    created_at: "2026-08-10T08:00:00.000Z",
    updated_at: "2026-08-11T08:00:00.000Z",
    superseded_at: "2026-08-12T08:00:00.000Z",
  });
  await fs.writeFile(path.join(fixture.repo, "dirty.txt"), "repo-wide dirty\n");

  // When
  const status = await guardianStatus({ repoRoot: fixture.repo, config: DEFAULT_CONFIG });
  const recover = await guardianRecover({ repoRoot: fixture.repo, config: DEFAULT_CONFIG });
  const model = buildOperationsCenterModel({
    reportPath: path.join(fixture.repo, ".git", "opencode-guardian", "report.html"),
    generatedAt: GENERATED_AT,
    status,
    recover,
  });

  // Then
  const owned = model.worktrees.find((worktree) => worktree.owner.sessionId === "ses_operations");
  assert.ok(owned);
  assert.equal(owned.owner.state, "owned");
  assert.equal(owned.flags.linked, true);
  assert.equal(owned.baseDistance.status, "available");
  if (owned.baseDistance.status === "available") {
    assert.equal(owned.baseDistance.relation, "ahead");
    assert.equal(owned.baseDistance.ahead, 1);
    assert.equal(owned.baseDistance.behind, 0);
  }
  assert.equal(model.metrics.riskCount > 0, true);
  assert.deepEqual(model.actions.map((action) => action.id), ["add", "sync", "fetch", "pull", "switch", "open", "terminal", "remove"]);
  assert.deepEqual(TOPOLOGY_MODES, ["metro", "radar", "timeline", "gittree", "sunburst", "swimlanes", "terminal"]);
  assert.equal(model.topology.nodes.length, status.worktrees.length);
  assert.ok(model.topology.edges.every((edge) => edge.verification === "unverified"));
  assert.ok(model.observedEvents.some((event) => event.sessionId === "ses_operations_terminal" && event.kind === "created"));
  assert.ok(model.observedEvents.some((event) => event.sessionId === "ses_operations_terminal" && event.kind === "superseded" && event.at === "2026-08-12T08:00:00.000Z"));
  assert.ok(model.observedEvents.some((event) => event.sessionId === "ses_operations_terminal" && event.kind === "terminal-recovery-action"));
  assert.ok(model.limitations.some((limitation) => limitation.code === "worktree-dirty-files-unavailable"));
});

test("Given malicious Guardian text and unmatched worktrees, when building the operations model, then it preserves data and declares unavailable facts", async (t) => {
  // Given
  const fixture = await createRepoWithOrigin();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const status = await guardianStatus({ repoRoot: fixture.repo, config: DEFAULT_CONFIG });
  const recover = await guardianRecover({ repoRoot: fixture.repo, config: DEFAULT_CONFIG });
  const malicious = "</script><img src=x onerror=alert(1)>";
  const shapedStatus = {
    ...status,
    worktrees: [...status.worktrees, {
      path: `/tmp/${malicious}`,
      branch: malicious,
      head: "deadbeef",
      detached: true,
      bare: true,
    }],
  };

  // When
  const model = buildOperationsCenterModel({ reportPath: malicious, generatedAt: GENERATED_AT, status: shapedStatus, recover });

  // Then
  const unmatched = model.worktrees.find((worktree) => worktree.branch === malicious);
  assert.ok(unmatched);
  assert.equal(unmatched.id.includes(malicious), false);
  assert.equal(unmatched.path, `/tmp/${malicious}`);
  assert.equal(unmatched.flags.detached, true);
  assert.equal(unmatched.flags.bare, true);
  assert.equal(unmatched.flags.linked, true);
  assert.equal(unmatched.owner.state, "unowned");
  assert.deepEqual(unmatched.baseDistance, { status: "unavailable", reason: "not-an-active-session-worktree" });
  assert.equal(JSON.stringify(model).includes(malicious), true);
  assert.equal(JSON.stringify(model).includes("&lt;"), false);
  assert.ok(model.limitations.some((limitation) => limitation.code === "commit-ancestry-unverified"));
  assert.ok(model.limitations.some((limitation) => limitation.code === "session-timestamps-unavailable"));
});

test("Given primary and terminal-risk worktrees, when building the operations model, then it retains proven non-active ownership and path-scoped risks", async (t) => {
  // Given
  const fixture = await createRepoWithOrigin();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const status = await guardianStatus({ repoRoot: fixture.repo, config: DEFAULT_CONFIG });
  const recover = await guardianRecover({ repoRoot: fixture.repo, config: DEFAULT_CONFIG });
  const terminalPath = path.join(fixture.repo, ".worktrees", "terminal");
  const poisonedPath = path.join(fixture.repo, ".worktrees", "poisoned");
  const terminal = { session_id: "ses_terminal", status: "finished" as const, branch: "guardian/terminal", worktree_path: terminalPath };
  const poisoned = { status: "finished" as const, branch: "guardian/poisoned", worktree_path: poisonedPath, severity: "fail" as const, reason: "proven terminal risk", suggestedCommand: "guardian_recover" };
  const shapedStatus = {
    ...status,
    sessions: [...status.sessions, terminal, poisoned],
    terminalSessions: [...status.terminalSessions, terminal, poisoned],
    orphanedSessions: [...status.orphanedSessions, terminal],
    poisonedSessions: [...status.poisonedSessions, poisoned],
    worktrees: [...status.worktrees, { path: terminalPath, branch: terminal.branch }, { path: poisonedPath, branch: poisoned.branch }],
  };

  // When
  const model = buildOperationsCenterModel({ reportPath: "report.html", generatedAt: GENERATED_AT, status: shapedStatus, recover });

  // Then
  const primary = model.worktrees.find((worktree) => worktree.flags.primary);
  const terminalWorktree = model.worktrees.find((worktree) => worktree.path === terminalPath);
  const poisonedWorktree = model.worktrees.find((worktree) => worktree.path === poisonedPath);
  assert.ok(primary);
  assert.equal(primary.flags.linked, false);
  assert.equal(primary.state, "primary");
  assert.ok(terminalWorktree);
  assert.equal(terminalWorktree.owner.sessionId, "ses_terminal");
  assert.equal(terminalWorktree.owner.status, "finished");
  assert.equal(terminalWorktree.tone, "bad");
  assert.equal(terminalWorktree.state, "orphaned");
  assert.ok(poisonedWorktree);
  assert.equal(poisonedWorktree.owner.status, "finished");
  assert.equal(poisonedWorktree.tone, "bad");
  assert.equal(poisonedWorktree.state, "poisoned");
  assert.equal("repoDirtyFileCount" in terminalWorktree.risk, false);
});

test("Given unannotated in-root and annotated external worktrees without state, when building the operations model, then only the external failure is risky", async (t) => {
  // Given
  const fixture = await createRepoWithOrigin();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const status = await guardianStatus({ repoRoot: fixture.repo, config: DEFAULT_CONFIG });
  const recover = await guardianRecover({ repoRoot: fixture.repo, config: DEFAULT_CONFIG });
  const unmanagedPath = path.join(fixture.repo, ".worktrees", "unmanaged");
  const externalPath = path.join(fixture.base, "external");
  const shapedStatus = {
    ...status,
    worktrees: [
      ...status.worktrees,
      { path: unmanagedPath, branch: "unmanaged" },
      { path: externalPath, branch: "external" },
    ],
    worktreesWithoutState: [
      ...status.worktreesWithoutState,
      { path: unmanagedPath, branch: "unmanaged" },
      {
        path: path.join(fixture.base, "temporary", "..", "external"),
        branch: "external",
        category: "external-worktree" as const,
        severity: "fail" as const,
      },
    ],
  };

  // When
  const model = buildOperationsCenterModel({ reportPath: "report.html", generatedAt: GENERATED_AT, status: shapedStatus, recover });

  // Then
  const unmanaged = model.worktrees.find((worktree) => worktree.path === unmanagedPath);
  const external = model.worktrees.find((worktree) => worktree.path === externalPath);
  assert.ok(unmanaged);
  assert.equal(unmanaged.state, "unmanaged");
  assert.equal(unmanaged.tone, "neutral");
  assert.deepEqual(unmanaged.risk, { orphaned: false, poisoned: false, external: false });
  assert.ok(external);
  assert.equal(external.state, "external");
  assert.equal(external.tone, "bad");
  assert.deepEqual(external.risk, { orphaned: false, poisoned: false, external: true });
});

test("Given symlinked path aliases across Operations Center evidence, when building the operations model, then canonical joins retain observed worktree paths", { skip: process.platform === "win32" }, async (t) => {
  // Given
  const fixture = await createRepoWithOrigin();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const repoAlias = path.join(path.dirname(fixture.repo), `${path.basename(fixture.repo)}-alias`);
  const worktreePath = path.join(fixture.base, "linked-worktree");
  const worktreeAlias = path.join(fixture.base, "linked-worktree-alias");
  await fs.mkdir(worktreePath);
  await Promise.all([fs.symlink(fixture.repo, repoAlias, "dir"), fs.symlink(worktreePath, worktreeAlias, "dir")]);
  const status = await guardianStatus({ repoRoot: fixture.repo, config: DEFAULT_CONFIG });
  const recover = await guardianRecover({ repoRoot: fixture.repo, config: DEFAULT_CONFIG });
  const shapedStatus = {
    ...status,
    repoRoot: repoAlias,
    sessions: [...status.sessions, { session_id: "ses_alias", status: "active" as const, branch: "guardian/alias", worktree_path: worktreePath }],
    activeSessionBaseDistances: [{
      status: "available" as const,
      sessionId: "ses_alias",
      worktreePath,
      baseRef: "origin/main",
      baseAuthorityRef: "refs/remotes/origin/main",
      baseRefOid: "base",
      head: "head",
      ahead: 1,
      behind: 0,
      relation: "ahead" as const,
      detached: false,
    }],
    worktrees: [...status.worktrees, { path: worktreeAlias, branch: "guardian/alias", head: "head" }],
    worktreesWithoutState: [...status.worktreesWithoutState, {
      path: worktreePath,
      branch: "guardian/alias",
      category: "external-worktree" as const,
      severity: "fail" as const,
    }],
  };

  // When
  const model = buildOperationsCenterModel({ reportPath: "report.html", generatedAt: GENERATED_AT, status: shapedStatus, recover });

  // Then
  const primary = model.worktrees.find((worktree) => worktree.path === fixture.repo);
  const aliasWorktree = model.worktrees.find((worktree) => worktree.path === worktreeAlias);
  assert.ok(primary);
  assert.equal(primary.flags.primary, true);
  assert.ok(aliasWorktree);
  assert.equal(aliasWorktree.path, worktreeAlias);
  assert.equal(aliasWorktree.owner.sessionId, "ses_alias");
  assert.deepEqual(aliasWorktree.baseDistance, shapedStatus.activeSessionBaseDistances[0]);
  assert.equal(aliasWorktree.state, "external");
  assert.deepEqual(aliasWorktree.risk, { orphaned: false, poisoned: false, external: true });
});
