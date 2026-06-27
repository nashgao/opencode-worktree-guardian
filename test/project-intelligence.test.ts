import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildProjectSnapshot, collectProjectSnapshot } from "../src/project/index.ts";
import { getGuardianPaths, readState } from "../src/state.ts";
import { createRepo, createTempDir, git } from "./helpers.ts";

function warningText(snapshot: { readonly warnings: readonly { readonly code: string; readonly message: string; readonly path?: string }[] }): string {
  return snapshot.warnings.map((warning) => `${warning.code} ${warning.path ?? ""} ${warning.message}`).join("\n");
}

async function seedProjectArtifacts(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "definition"), { recursive: true });
  await fs.writeFile(path.join(root, "definition", "roadmap.md"), [
    "# Infrastructure Definition Roadmap",
    "",
    "## Completed Phases",
    "",
    "### Phase 1: Schema Design",
    "",
    "- [x] Lock schema",
    "",
    "## Next Phases",
    "",
    "### Phase 2: Calibration",
    "",
    "- [ ] Tune evidence gates",
    "",
  ].join("\n"));

  await fs.mkdir(path.join(root, ".milestones", "reviews"), { recursive: true });
  await fs.writeFile(path.join(root, ".milestones", "reviews", "milestone-local-docker-cicd-impl-rating-20260621.md"), [
    "# Local Docker CICD Rating",
    "",
    "Generated: 2026-06-21",
    "",
    "Score: 96/100",
    "",
    "| Dimension | Status | Notes |",
    "| --- | --- | --- |",
    "| Tests | pass | suite green |",
    "",
  ].join("\n"));

  await fs.mkdir(path.join(root, ".omo", "plans"), { recursive: true });
  await fs.writeFile(path.join(root, ".omo", "plans", "local-docker-cicd-100-readiness.md"), [
    "# Local Docker CICD 100 Readiness",
    "",
    "## TL;DR",
    "Make local docker CICD fully ready.",
    "",
    "## Scope",
    "",
    "## Todos",
    "- [x] Baseline",
    "- [ ] Final gate",
    "",
    "## Final verification wave",
    "",
    "## Success criteria",
    "",
  ].join("\n"));

  const loopRoot = path.join(root, ".omo", "ulw-loop", "019ed89a-4841-7461-b1ec-c33d39aecc74");
  await fs.mkdir(loopRoot, { recursive: true });
  await fs.writeFile(path.join(loopRoot, "goals.json"), JSON.stringify({
    goals: [
      { id: "G001", title: "Active goal", objective: "ship feature", status: "in_progress" },
      { id: "G002", title: "Pending goal", objective: "verify feature", status: "pending" },
    ],
  }, null, 2));
  await fs.writeFile(path.join(loopRoot, "ledger.jsonl"), [
    JSON.stringify({ kind: "plan_created", at: "2026-06-21T00:00:00.000Z", goalId: "G001", message: "created" }),
    "{bad json",
    JSON.stringify({ kind: "evidence_recorded", at: "2026-06-21T00:01:00.000Z", goalId: "G001", message: "pass" }),
    "",
  ].join("\n"));
}

async function gitState(repo: string): Promise<Record<string, string>> {
  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });
  return {
    head: (await git(repo, ["rev-parse", "HEAD"])).stdout,
    status: (await git(repo, ["status", "--short"])).stdout,
    branches: (await git(repo, ["branch", "--format=%(refname:short)"])).stdout,
    worktrees: (await git(repo, ["worktree", "list", "--porcelain"])).stdout,
    refs: (await git(repo, ["for-each-ref", "refs/opencode-guardian", "--format=%(refname) %(objectname)"])).stdout,
    stashes: (await git(repo, ["stash", "list"])).stdout,
    guardianStateVersion: String(state.state_version),
  };
}

test("project snapshot parses roadmap milestone plan and ulw-loop artifacts", async () => {
  const repo = await createRepo();
  await seedProjectArtifacts(repo);

  const snapshot = await collectProjectSnapshot({
    repoRoot: repo,
    cwd: repo,
    projectRoots: [repo],
    generatedAt: "2026-06-24T00:00:00.000Z",
  });

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.schemaVersion, "project-snapshot/v1");
  assert.equal(snapshot.generatedAt, "2026-06-24T00:00:00.000Z");
  assert.equal(snapshot.summary.projectCount, 1);
  assert.equal(snapshot.summary.roadmapCount, 1);
  assert.equal(snapshot.summary.milestoneReviewCount, 1);
  assert.equal(snapshot.summary.omoPlanCount, 1);
  assert.equal(snapshot.summary.omoLoopCount, 1);
  assert.equal(snapshot.projects.length, 1);

  const [project] = snapshot.projects;
  assert.ok(project);
  assert.equal(project.git.available, true);
  assert.equal(project.roadmaps[0]?.title, "Infrastructure Definition Roadmap");
  assert.deepEqual(project.roadmaps[0]?.phases.map((phase) => phase.title), ["Phase 1: Schema Design", "Phase 2: Calibration"]);
  assert.equal(project.milestoneReviews[0]?.score, 96);
  assert.deepEqual(project.milestoneReviews[0]?.tableRows, ["| Dimension | Status | Notes |", "| Tests | pass | suite green |"]);
  assert.equal(project.omoPlans[0]?.todoCount.total, 2);
  assert.equal(project.omoPlans[0]?.todoCount.done, 1);
  assert.equal(project.omoPlans[0]?.hasFinalVerification, true);
  assert.equal(project.omoLoops[0]?.goalStatusCounts.in_progress, 1);
  assert.equal(project.omoLoops[0]?.goalStatusCounts.pending, 1);
  assert.deepEqual(project.omoLoops[0]?.ledgerEvents.map((event) => event.kind), ["plan_created", "evidence_recorded"]);
  assert.match(snapshot.warnings.map((warning) => warning.message).join("\n"), /Malformed JSONL/);
});

test("project snapshot rejects unsafe artifact paths and invalid roots without crashing", async () => {
  const repo = await createRepo();
  const nested = path.join(repo, "nested-project");
  const nongit = await createTempDir("guardian-project-nongit-");
  const outside = await createTempDir("guardian-project-outside-");
  await seedProjectArtifacts(nested);
  await fs.mkdir(path.join(nongit, "definition"), { recursive: true });
  await fs.writeFile(path.join(nongit, "definition", "roadmap.md"), "# Non Git Roadmap\n\n## Now\n\n### Phase A\n");
  await fs.writeFile(path.join(outside, "roadmap.md"), "# Outside Roadmap\n");
  await fs.symlink(outside, path.join(repo, "definition"));
  const fileRoot = path.join(repo, "not-a-root.txt");
  await fs.writeFile(fileRoot, "file root\n");
  const symlinkRoot = path.join(repo, "linked-root");
  await fs.symlink(nongit, symlinkRoot);

  const snapshot = await buildProjectSnapshot({
    repoRoot: repo,
    cwd: repo,
    projectRoots: [repo, "nested-project", nested, "", 42, "missing-root", fileRoot, symlinkRoot, nongit],
    generatedAt: "2026-06-24T00:00:00.000Z",
  });
  const warnings = warningText(snapshot);

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.summary.projectCount, 3);
  assert.equal(snapshot.projects.some((project) => project.root === nested), true);
  assert.equal(snapshot.projects.some((project) => project.root === nongit && project.git.available === false), true);
  assert.equal(snapshot.projects.find((project) => project.root === repo)?.roadmaps.length, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /Outside Roadmap/);
  assert.match(warnings, /root_duplicate/);
  assert.match(warnings, /root_empty/);
  assert.match(warnings, /root_invalid_type/);
  assert.match(warnings, /Project root does not exist/);
  assert.match(warnings, /Project root is not a directory/);
  assert.match(warnings, /Project root is a symlink/);
  assert.match(warnings, /symlinked parent/);
  assert.match(warnings, /root_not_git/);
});

test("project snapshot reports missing optional malformed and oversized artifacts", async () => {
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, ".omo", "plans"), { recursive: true });
  await fs.writeFile(path.join(repo, ".omo", "plans", "huge.md"), "x".repeat(1024 * 1024 + 1));
  const loopRoot = path.join(repo, ".omo", "ulw-loop", "bad-loop");
  await fs.mkdir(loopRoot, { recursive: true });
  await fs.writeFile(path.join(loopRoot, "goals.json"), "{bad json");
  await fs.writeFile(path.join(loopRoot, "ledger.jsonl"), "{bad json\n");

  const snapshot = await collectProjectSnapshot({
    repoRoot: repo,
    cwd: repo,
    projectRoots: [repo],
    generatedAt: "2026-06-24T00:00:00.000Z",
  });
  const warnings = warningText(snapshot);

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.summary.roadmapCount, 0);
  assert.equal(snapshot.summary.omoPlanCount, 0);
  assert.equal(snapshot.summary.omoLoopCount, 1);
  assert.match(warnings, /artifact_missing definition\/roadmap\.md/);
  assert.match(warnings, /artifact_missing \.milestones\/reviews/);
  assert.match(warnings, /artifact_oversized \.omo\/plans\/huge\.md/);
  assert.match(warnings, /goals_json_malformed \.omo\/ulw-loop\/bad-loop\/goals\.json/);
  assert.match(warnings, /ledger_jsonl_malformed \.omo\/ulw-loop\/bad-loop\/ledger\.jsonl/);
});

test("project snapshot caps explicit roots at ten", async () => {
  const repo = await createRepo();
  const roots: string[] = [];
  for (let index = 0; index < 11; index += 1) {
    const root = path.join(repo, `project-${String(index).padStart(2, "0")}`);
    await fs.mkdir(root, { recursive: true });
    roots.push(path.relative(repo, root));
  }

  const snapshot = await collectProjectSnapshot({
    repoRoot: repo,
    cwd: repo,
    projectRoots: roots,
    generatedAt: "2026-06-24T00:00:00.000Z",
  });

  assert.equal(snapshot.summary.projectCount, 10);
  assert.equal(snapshot.projectRoots.some((root) => root.endsWith("project-10")), false);
  assert.match(warningText(snapshot), /root_limit/);
});

test("project snapshot collection is read-only by default", async () => {
  const repo = await createRepo();
  await seedProjectArtifacts(repo);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "seed project intelligence fixtures"]);
  const before = await gitState(repo);

  const snapshot = await collectProjectSnapshot({
    repoRoot: repo,
    cwd: repo,
    projectRoots: [repo],
    generatedAt: "2026-06-24T00:00:00.000Z",
  });

  const after = await gitState(repo);
  assert.equal(snapshot.ok, true);
  assert.deepEqual(after, before);
});
