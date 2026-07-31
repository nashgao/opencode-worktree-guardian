import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianHygiene } from "../src/hygiene.ts";
import { guardianStart } from "../src/tools.ts";
import { isRecordLike, type RecordLike } from "../src/types.ts";
import { guardianFinishWorkflow } from "../src/workflow.ts";
import { createRepo, createRepoWithOrigin, git } from "./helpers.ts";

function record(value: unknown): RecordLike {
  return isRecordLike(value) ? value : {};
}

function records(value: unknown): readonly RecordLike[] {
  return Array.isArray(value) ? value.filter(isRecordLike) : [];
}

async function createMergedBranch(repo: string, branch: string, fileName: string) {
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, fileName), `${branch}\n`);
  await git(repo, ["add", fileName]);
  await git(repo, ["commit", "-m", `add ${fileName}`]);
  await git(repo, ["checkout", "main"]);
  await git(repo, ["merge", "--no-ff", branch, "-m", `merge ${branch}`]);
  await git(repo, ["push", "origin", "main"]);
  const { stdout: head } = await git(repo, ["rev-parse", branch]);
  return head;
}

function branchExists(repo: string, branch: string) {
  return git(repo, ["rev-parse", "--verify", branch]).then(() => true, () => false);
}

function pathExists(filePath: string) {
  return fs.access(filePath).then(() => true, () => false);
}

async function writeArtifact(repo: string, relative: string) {
  const target = path.join(repo, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "artifact\n");
}

test("guardian_finish_workflow dirty primary candidate scan includes read-only candidate inventory", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-dirty-primary-candidate";
  const head = await createMergedBranch(repo, branch, "workflow-dirty-primary-candidate.txt");
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), "workflow-dirty-primary-candidate");
  const dirtyPrimaryPath = path.join(repo, "dirty-primary.txt");
  await git(repo, ["worktree", "add", worktreePath, branch]);
  await fs.writeFile(dirtyPrimaryPath, "dirty\n");

  const plan = record(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));
  const planPreflight = record(plan.preflight);
  const planCandidates = records(plan.candidates);
  const planRemaining = records(plan.remaining);

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned-partial");
  assert.equal(typeof plan.confirmToken, "string");
  assert.equal(planPreflight.candidateScanStatus, "completed");
  assert.equal(planPreflight.candidateCount, 1);
  assert.equal(planCandidates.length, 1);
  const [candidate] = planCandidates;
  assert.ok(candidate);
  assert.equal(candidate.branch, branch);
  assert.equal(candidate.head, head);
  assert.equal(records(plan.blockers).length, 0);
  assert.equal(planRemaining.some((remaining) => remaining.kind === "primary-dirty"), true);

  const staleApply = record(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: "0".repeat(64) }));
  assert.equal(staleApply.ok, false);
  assert.equal(staleApply.confirmToken, undefined);
  assert.equal(await pathExists(worktreePath), true);
  assert.equal(await branchExists(repo, branch), true);

  const apply = record(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken }));
  const applyResults = records(apply.results);
  const applyRemaining = records(apply.remaining);

  assert.equal(apply.ok, false);
  assert.equal(apply.status, "partial");
  assert.equal(applyResults.length, 1);
  const [result] = applyResults;
  assert.ok(result);
  assert.equal(result.worktreeRemoved, true);
  assert.equal(result.branchDeleted, true);
  assert.equal(applyRemaining.some((remaining) => remaining.kind === "base-sync-skipped"), true);
  assert.equal(await pathExists(dirtyPrimaryPath), true);
  assert.equal(await pathExists(worktreePath), false);
  assert.equal(await branchExists(repo, branch), false);
});

test("guardian_finish_workflow scan failed suite keeps dirty primary inventory", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "dirty-primary-failed-scan.txt"), "dirty\n");
  const missingCwd = path.join(repo, "missing-cwd");

  const plan = record(await guardianFinishWorkflow({ repoRoot: repo, cwd: missingCwd, mode: "plan" }));
  const preflight = record(plan.preflight);

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.equal(preflight.candidateScanStatus, "failed");
  assert.equal(preflight.candidateScanFailedReason, "candidate-discovery-failed");
  assert.match(String(plan.reason), /candidate discovery failed/);
  assert.equal(preflight.blockingDirtyFileCount, 1);
  assert.deepEqual(preflight.blockingDirtyFiles, ["dirty-primary-failed-scan.txt"]);
});

test("hygiene cleanup blocks unsafe selected cleanup roots", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "librarian-mixed/tracked.txt");
  await git(repo, ["add", "librarian-mixed/tracked.txt"]);
  await git(repo, ["commit", "-m", "track mixed cleanup root"]);
  await writeArtifact(repo, "librarian-mixed/extra.txt");
  await fs.symlink("README.md", path.join(repo, "librarian-link"));
  await writeArtifact(repo, "node_modules/librarian-protected/file.txt");

  const plan = await guardianHygiene({
    repoRoot: repo,
    config: DEFAULT_CONFIG,
    mode: "plan",
    cleanupPaths: [
      "librarian-mixed",
      "librarian-link",
      "node_modules/librarian-protected",
      "librarian-missing",
      path.join(repo, "..", "outside-cleanup"),
      ".git",
    ],
  });

  const reasons = (plan.blockers as Array<Record<string, unknown>>).map((blocker) => String(blocker.reason)).join("\n");
  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.match(reasons, /tracked files/);
  assert.match(reasons, /symlink cleanup roots/);
  assert.match(reasons, /protected node_modules directory/);
  assert.match(reasons, /missing/);
  assert.match(reasons, /outside the repository root/);
  assert.match(reasons, /\.git metadata/);
});

test("hygiene cleanup blocks dirty nested git repositories even when category is explicitly allowed", async () => {
  const repo = await createRepo();
  const nested = path.join(repo, "research-clone");
  await fs.mkdir(nested, { recursive: true });
  await git(nested, ["init", "-b", "main"]);
  await git(nested, ["config", "user.email", "guardian@example.test"]);
  await git(nested, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(nested, "README.md"), "nested\n");
  await git(nested, ["add", "README.md"]);
  await git(nested, ["commit", "-m", "nested initial"]);
  await fs.writeFile(path.join(nested, "dirty.txt"), "dirty\n");

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", cleanupPaths: ["research-clone"], allowCategories: ["nested-git"] });

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.equal((plan.blockers as Array<Record<string, unknown>>).some((blocker) => /dirty nested Git/.test(String(blocker.reason)) && blocker.fatal === true), true);
  assert.equal(await pathExists(nested), true);
});

test("hygiene cleanup can explicitly plan dirty nested git repositories", async () => {
  const repo = await createRepo();
  const nested = path.join(repo, "guardian-dirty-trash");
  await fs.mkdir(nested, { recursive: true });
  await git(nested, ["init", "-b", "main"]);
  await git(nested, ["config", "user.email", "guardian@example.test"]);
  await git(nested, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(nested, "README.md"), "nested\n");
  await git(nested, ["add", "README.md"]);
  await git(nested, ["commit", "-m", "nested initial"]);
  await fs.writeFile(path.join(nested, "dirty.txt"), "dirty\n");

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", cleanupPaths: ["guardian-dirty-trash"], allowCategories: ["nested-git"], allowDirtyNestedGit: true });

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.deepEqual((plan.targets as Array<Record<string, unknown>>).map((target) => target.path), ["guardian-dirty-trash"]);
});

test("hygiene cleanup blocks configured and registered Guardian worktree roots", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_hygiene_cleanup_worktree", taskName: "hygiene cleanup worktree", createWorktree: true, config: DEFAULT_CONFIG });
  const relativeWorktree = path.relative(repo, started.session.worktree_path);

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", cleanupPaths: [relativeWorktree] });

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal((plan.blockers as Array<Record<string, unknown>>).some((blocker) => /Guardian worktree root|registered/.test(String(blocker.reason))), true);
  assert.equal(await pathExists(started.session.worktree_path), true);
});

test("hygiene cleanup blocks invalid modes without removing anything", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "librarian-mode/file.txt");

  const result = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "delete" });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(String(result.reason), /mode must be plan or apply/);
  assert.equal(result.confirmToken, undefined);
  assert.equal(await pathExists(path.join(repo, "librarian-mode")), true);
});

test("hygiene cleanup rejects unsupported allowCategories entries as fatal blockers", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "librarian-categories/file.txt");

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", allowCategories: ["known-cleanable", "everything"] });

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.equal((plan.blockers as Array<Record<string, unknown>>).some((blocker) => blocker.fatal === true && /unsupported allowCategories entry: everything/.test(String(blocker.reason))), true);
  assert.equal(await pathExists(path.join(repo, "librarian-categories")), true);
});

test("hygiene cleanup blocks overlapping cleanup targets", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "guardian-overlap/root-file.txt");
  await writeArtifact(repo, "guardian-overlap/librarian-x/file.txt");

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", allowCategories: ["known-cleanable", "suspicious"] });

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.equal((plan.blockers as Array<Record<string, unknown>>).some((blocker) => blocker.fatal === true && /cleanup paths overlap/.test(String(blocker.reason))), true);
  assert.equal(await pathExists(path.join(repo, "guardian-overlap")), true);
});

test("hygiene cleanup applies dirty nested git repositories with the explicit override", async () => {
  const repo = await createRepo();
  const nested = path.join(repo, "guardian-dirty-apply");
  await fs.mkdir(nested, { recursive: true });
  await git(nested, ["init", "-b", "main"]);
  await git(nested, ["config", "user.email", "guardian@example.test"]);
  await git(nested, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(nested, "README.md"), "nested\n");
  await git(nested, ["add", "README.md"]);
  await git(nested, ["commit", "-m", "nested initial"]);
  await fs.writeFile(path.join(nested, "dirty.txt"), "dirty\n");

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", cleanupPaths: ["guardian-dirty-apply"], allowCategories: ["nested-git"], allowDirtyNestedGit: true });
  assert.equal(plan.status, "planned");

  const apply = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "apply", cleanupPaths: ["guardian-dirty-apply"], allowCategories: ["nested-git"], allowDirtyNestedGit: true, confirmToken: plan.confirmToken });

  assert.equal(apply.ok, true);
  assert.equal(apply.status, "cleaned");
  assert.deepEqual((apply.removedTargets as Array<Record<string, unknown>>).map((target) => target.path), ["guardian-dirty-apply"]);
  assert.equal(await pathExists(nested), false);
});

test("guardian_hygiene plans and applies cleanup for approved target files and directories", async () => {
  const repo = await createRepo();
  await fs.writeFile(path.join(repo, "node-compile-cache"), "cache-blob\n");
  await writeArtifact(repo, "librarian-hygiene/file.txt");

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan" });

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.deepEqual((plan.targets as Array<Record<string, unknown>>).map((target) => [target.path, target.kind]), [["librarian-hygiene", "directory"], ["node-compile-cache", "file"]]);

  const apply = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "apply", confirmToken: plan.confirmToken });

  assert.equal(apply.ok, true);
  assert.equal(apply.status, "cleaned");
  assert.deepEqual((apply.removedTargets as Array<Record<string, unknown>>).map((target) => target.path), ["librarian-hygiene", "node-compile-cache"]);
  assert.equal(await pathExists(path.join(repo, "librarian-hygiene")), false);
  assert.equal(await pathExists(path.join(repo, "node-compile-cache")), false);
});
