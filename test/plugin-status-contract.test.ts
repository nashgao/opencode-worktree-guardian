import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import plugin from "../src/index.ts";
import { createToolContext, metadataRecord, runTool } from "./plugin-contract-helpers.ts";
import { createRepo, seedSession } from "./helpers.ts";

async function seedProjectIntelligenceArtifacts(repo: string): Promise<void> {
  await fs.mkdir(`${repo}/definition`, { recursive: true });
  await fs.writeFile(`${repo}/definition/roadmap.md`, "# Project Roadmap\n\n## Now\n\n### Phase 1\n\n- [x] Ready\n");
  await fs.mkdir(`${repo}/.omo/plans`, { recursive: true });
  await fs.writeFile(`${repo}/.omo/plans/demo.md`, "# Demo Plan\n\n## TL;DR\nDemo\n\n## Todos\n- [ ] Ship\n\n## Final verification wave\n");
}

test("guardian_project_status returns project snapshot metadata and readable output", async () => {
  const repo = await createRepo();
  await seedProjectIntelligenceArtifacts(repo);
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  const result = await runTool(hooks.tool.guardian_project_status.execute, { repoRoot: repo }, { ...context, directory: repo, worktree: repo });

  assert.equal(result.title, "guardian_project_status");
  assert.equal(result.metadata.ok, true);
  assert.equal(result.metadata.schemaVersion, "project-snapshot/v1");
  assert.equal(metadataRecord(result.metadata, "summary").projectCount, 1);
  assert.equal(metadataRecord(result.metadata, "summary").roadmapCount, 1);
  assert.equal(metadataRecord(result.metadata, "summary").omoPlanCount, 1);
  assert.equal(result.metadata.reportPath, undefined);
  assert.equal(await fs.access(`${repo}/.git/opencode-guardian/project-report.html`).then(() => true, () => false), false);
  assert.match(result.output, /Project Intelligence/);
  assert.match(result.output, /\[(GOOD|WARN)\] guardian_project_status snapshot/);
  assert.match(result.output, /Project Roadmap/);
  assert.doesNotMatch(result.output, /confirmToken|confirmDelete|mode=apply|guardian_delete|rm -rf|git clean/);
});

test("guardian_status tool execute returns readable output with raw metadata", async () => {
  const repo = await createRepo();
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { recordSession } = await import("../src/state.ts");
  const { git } = await import("./helpers.ts");
  const { stdout: head } = await git(repo, ["rev-parse", "HEAD"]);
  await seedSession(repo, {
    session_id: "ses_contract_status_active",
    status: "active",
    branch: "guardian/contract-status-active",
    worktree_path: repo,
    base_ref: "origin/main",
    head_commit: head,
    safety_refs: [],
  });
  await recordSession(repo, DEFAULT_CONFIG, {
    session_id: "ses_contract_status_terminal",
    status: "preserved",
    branch: "guardian/contract-status-terminal",
    worktree_path: `${repo}/.worktrees/opencode-worktree-guardian/contract-status-terminal`,
    base_ref: "origin/main",
    head_commit: head,
    safety_refs: [],
  });
  await seedSession(repo, {
    session_id: "ses_contract_status_deleted",
    status: "deleted",
    branch: "guardian/contract-status-deleted",
    worktree_path: `${repo}/.worktrees/opencode-worktree-guardian/contract-status-deleted`,
    base_ref: "origin/main",
    head_commit: head,
    safety_refs: [],
  });
  await seedSession(repo, {
    session_id: "ses_contract_status_finished",
    status: "finished",
    branch: "guardian/contract-status-finished",
    worktree_path: `${repo}/.worktrees/opencode-worktree-guardian/contract-status-finished`,
    base_ref: "origin/main",
    head_commit: head,
    safety_refs: [],
  });
  await seedSession(repo, {
    session_id: "ses_contract_status_superseded",
    status: "superseded",
    branch: "guardian/contract-status-superseded",
    worktree_path: `${repo}/.worktrees/opencode-worktree-guardian/contract-status-superseded`,
    base_ref: "origin/main",
    head_commit: head,
    safety_refs: [],
  });
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context, metadataCalls } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_status.execute;
  const result = await runTool(execute, { repoRoot: repo }, context);
  assert.equal(typeof result.output, "string");
  assert.equal(typeof result.metadata, "object");
  assert.deepEqual(metadataCalls, [{ title: "guardian_status" }]);
  assert.equal(result.metadata.repoRoot, repo);
  assert.match(result.output, /^\[FAIL\] Guardian Status: Needs attention/m);
  assert.doesNotMatch(result.output, /guardian_status snapshot/);
  assert.match(result.output, /Repo\n  /);
  assert.match(result.output, /Work Now\n  Active sessions: 1\n  Worktrees: \d+\n  Dirty files: 0\n  Stashes: 0\n  Orphaned sessions: 0\n  Poisoned sessions: 1\n  Recovery candidates: 0/);
  assert.match(result.output, /Problems\n  Poisoned sessions: 1\n    - ses_contract_status_active/);
  assert.match(result.output, /History\n  Retained terminal sessions: 4\n  deleted: 1\n  finished: 1\n  preserved: 1\n  superseded: 1\n  Safety refs: 0\n  Preserved refs: 0/);
  assert.match(result.output, /Active Sessions\n  ses_contract_status_active active guardian\/contract-status-active/);
  assert.doesNotMatch(result.output, /\[INFO\] terminal sessions:/);
  assert.doesNotMatch(result.output, /ses_contract_status_terminal/);
  assert.match(result.output, /Current Worktrees\n  main /);
});

test("unrelated lifecycle tools ignore project status schema fields", async () => {
  const repo = await createRepo();
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;

  const result = await runTool(hooks.tool.guardian_status.execute, {
    repoRoot: repo,
    projectRoots: ["/tmp/should-not-be-scanned"],
    writeReport: true,
  }, context);

  assert.equal(result.title, "guardian_status");
  assert.equal(result.metadata.repoRoot, repo);
  assert.equal(result.metadata.schemaVersion, undefined);
  assert.equal(result.metadata.reportPath, undefined);
  assert.equal(await fs.access(`${repo}/.git/opencode-guardian/project-report.html`).then(() => true, () => false), false);
  assert.match(result.output, /^\[GOOD\] Guardian Status: Clean/m);
  assert.doesNotMatch(result.output, /guardian_status snapshot/);
  assert.doesNotMatch(result.output, /Project Intelligence|guardian_project_status|Roadmaps|ULW loops|project-report\.html/);
});

test("guardian_recover tool execute returns readable output with raw metadata", async () => {
  const repo = await createRepo();
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_recover.execute;
  const result = await runTool(execute, { repoRoot: repo }, context);
  assert.equal(typeof result.output, "string");
  assert.equal(typeof result.metadata, "object");
  assert.equal(result.metadata.repoRoot, repo);
  assert.match(result.output, /\[GOOD\] guardian_recover snapshot/);
  assert.match(result.output, /Recovery candidates: 0/);
  assert.match(result.output, /Suggested Commands/);
});

test("guardian_report_html tool execute writes report and returns readable output with raw metadata", async () => {
  const repo = await createRepo();
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  const execute = hooks.tool.guardian_report_html.execute;
  const result = await runTool(execute, { repoRoot: repo }, context);
  assert.equal(typeof result.output, "string");
  assert.equal(typeof result.metadata, "object");
  assert.equal(result.metadata.ok, true);
  assert.match(String(result.metadata.reportPath), /\.git\/opencode-guardian\/report\.html$/);
  assert.equal(typeof result.metadata.status, "object");
  assert.equal(typeof result.metadata.recover, "object");
  assert.match(result.output, /\[GOOD\] guardian_report_html wrote offline report/);
  assert.match(result.output, /reportPath:/);
});
