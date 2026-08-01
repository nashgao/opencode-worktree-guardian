import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianHygiene, scanWorkspaceHygiene } from "../src/hygiene.ts";
import { guardianFinishWorkflow } from "../src/workflow.ts";
import { createRepo, createRepoWithOrigin, createTempDir, git } from "./helpers.ts";

type WorkflowResult = {
  readonly ok: boolean;
  readonly status: string;
  readonly reason?: string;
  readonly confirmToken?: string;
  readonly candidates: readonly Record<string, unknown>[];
  readonly results: readonly Record<string, unknown>[];
  readonly remaining: readonly Record<string, unknown>[];
  readonly baseSync?: Record<string, unknown>;
};

function workflowResult(result: Record<string, unknown>): WorkflowResult {
  return result as WorkflowResult;
}

async function createMergedRemoteBranch(repo: string, branch: string) {
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, "remote-diverged-cleanup.txt"), `${branch}\n`);
  await git(repo, ["add", "remote-diverged-cleanup.txt"]);
  await git(repo, ["commit", "-m", "add remote cleanup branch"]);
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["checkout", "main"]);
  await git(repo, ["merge", "--no-ff", branch, "-m", "merge remote cleanup branch"]);
  await git(repo, ["push", "origin", "main"]);
  await git(repo, ["branch", "-d", branch]);
  await git(repo, ["fetch", "origin"]);
}

async function createLocalBranchMergedOnlyOnRemote(repo: string, remote: string, branch: string) {
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, "local-branch-remote-merged.txt"), `${branch}\n`);
  await git(repo, ["add", "local-branch-remote-merged.txt"]);
  await git(repo, ["commit", "-m", "add local branch merged on remote"]);
  await git(repo, ["push", "origin", branch]);
  const { stdout: head } = await git(repo, ["rev-parse", branch]);
  await git(repo, ["checkout", "main"]);
  const merger = await createTempDir("guardian-local-branch-merger-");
  await git(path.dirname(remote), ["clone", remote, merger]);
  await git(merger, ["config", "user.email", "guardian@example.test"]);
  await git(merger, ["config", "user.name", "Guardian Test"]);
  await git(merger, ["merge", "--no-ff", `origin/${branch}`, "-m", "merge local branch on remote"]);
  await git(merger, ["push", "origin", "main"]);
  await git(repo, ["fetch", "origin"]);
  return head;
}

async function divergeLocalAndRemoteMain(repo: string, remote: string) {
  await fs.writeFile(path.join(repo, "local-main-only.txt"), "local only\n");
  await git(repo, ["add", "local-main-only.txt"]);
  await git(repo, ["commit", "-m", "local main only"]);
  const updater = await createTempDir("guardian-remote-main-updater-");
  await git(path.dirname(remote), ["clone", remote, updater]);
  await git(updater, ["config", "user.email", "guardian@example.test"]);
  await git(updater, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(updater, "remote-main-only.txt"), "remote only\n");
  await git(updater, ["add", "remote-main-only.txt"]);
  await git(updater, ["commit", "-m", "remote main only"]);
  await git(updater, ["push", "origin", "main"]);
}

async function remoteBranchExists(repo: string, branch: string) {
  const result = await git(repo, ["ls-remote", "--heads", "origin", branch]);
  return result.stdout.length > 0;
}

function pathExists(filePath: string) {
  return fs.access(filePath).then(() => true, () => false);
}

async function hygienePathExists(candidate: string) {
  return fs.access(candidate).then(() => true, () => false);
}

async function writeArtifact(repo: string, relative: string) {
  const target = path.join(repo, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "artifact\n");
}

test("guardian_finish_workflow cleans safe remote branches when local main diverged", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-diverged-base-remote";
  await createMergedRemoteBranch(repo, branch);
  await divergeLocalAndRemoteMain(repo, remote);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.candidates.some((candidate) => candidate.branch === branch), true);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken }));

  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(apply.status, "partial");
  assert.equal(apply.results.some((result) => result.branch === branch && result.remoteBranchDeleted === true), true, JSON.stringify(apply.results));
  assert.equal(apply.remaining.some((entry) => entry.kind === "base-sync"), true, JSON.stringify(apply.remaining));
  assert.equal(apply.baseSync?.ok, false);
  assert.equal(await remoteBranchExists(repo, branch), false);
});

test("guardian_finish_workflow cleans safe local branches when local main diverged", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-diverged-base-local";
  const head = await createLocalBranchMergedOnlyOnRemote(repo, remote, branch);
  await divergeLocalAndRemoteMain(repo, remote);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.candidates.some((candidate) => candidate.branch === branch && candidate.head === head), true, JSON.stringify(plan.candidates));

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken }));

  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(apply.status, "partial");
  assert.equal(apply.results.some((result) => result.branch === branch && result.branchDeleted === true), true, JSON.stringify(apply.results));
  assert.equal(apply.remaining.some((entry) => entry.kind === "base-sync"), true, JSON.stringify(apply.remaining));
  assert.equal(apply.baseSync?.ok, false);
  await assert.rejects(() => git(repo, ["rev-parse", "--verify", branch]));
});

test("guardian_finish_workflow cleans safe worktrees when local main diverged", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-diverged-base-worktree";
  const head = await createLocalBranchMergedOnlyOnRemote(repo, remote, branch);
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), "workflow-diverged-base-worktree");
  await git(repo, ["worktree", "add", worktreePath, branch]);
  await divergeLocalAndRemoteMain(repo, remote);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.candidates.some((candidate) => candidate.branch === branch && candidate.head === head), true, JSON.stringify(plan.candidates));

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken }));

  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(apply.status, "partial");
  assert.equal(apply.results.some((result) => result.branch === branch && result.worktreeRemoved === true && result.branchDeleted === true), true, JSON.stringify(apply.results));
  assert.equal(apply.remaining.some((entry) => entry.kind === "base-sync"), true, JSON.stringify(apply.remaining));
  assert.equal(apply.baseSync?.ok, false);
  assert.equal(await pathExists(worktreePath), false);
  await assert.rejects(() => git(repo, ["rev-parse", "--verify", branch]));
});

test("hygiene cleanup plans and applies all default hygiene targets", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "librarian-clean/file.txt");
  await writeArtifact(repo, "node-compile-cache/cache.blob");
  await writeArtifact(repo, "node-coverage-456/coverage.json");
  await writeArtifact(repo, "research-dump/file.txt");
  await writeArtifact(repo, "tsx-501/runtime-cache.json");
  const nested = path.join(repo, "research-clone-clean");
  await fs.mkdir(nested, { recursive: true });
  await git(nested, ["init", "-b", "main"]);
  await git(nested, ["config", "user.email", "guardian@example.test"]);
  await git(nested, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(nested, "README.md"), "nested\n");
  await git(nested, ["add", "README.md"]);
  await git(nested, ["commit", "-m", "nested initial"]);

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan" });

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(typeof plan.confirmToken, "string");
  assert.deepEqual((plan.targets as Array<Record<string, unknown>>).map((target) => target.path), ["librarian-clean", "node-compile-cache", "node-coverage-456", "research-clone-clean", "research-dump", "tsx-501"]);
  assert.equal(await hygienePathExists(path.join(repo, "librarian-clean")), true);
  assert.equal(await hygienePathExists(path.join(repo, "node-compile-cache")), true);
  assert.equal(await hygienePathExists(path.join(repo, "node-coverage-456")), true);
  assert.equal(await hygienePathExists(path.join(repo, "research-clone-clean")), true);
  assert.equal(await hygienePathExists(path.join(repo, "research-dump")), true);
  assert.equal(await hygienePathExists(path.join(repo, "tsx-501")), true);

  const apply = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "apply", confirmToken: plan.confirmToken });

  assert.equal(apply.ok, true);
  assert.equal(apply.status, "cleaned");
  assert.deepEqual((apply.removedTargets as Array<Record<string, unknown>>).map((target) => target.path), ["librarian-clean", "node-compile-cache", "node-coverage-456", "research-clone-clean", "research-dump", "tsx-501"]);
  assert.equal(await hygienePathExists(path.join(repo, "librarian-clean")), false);
  assert.equal(await hygienePathExists(path.join(repo, "node-compile-cache")), false);
  assert.equal(await hygienePathExists(path.join(repo, "node-coverage-456")), false);
  assert.equal(await hygienePathExists(path.join(repo, "research-clone-clean")), false);
  assert.equal(await hygienePathExists(path.join(repo, "research-dump")), false);
  assert.equal(await hygienePathExists(path.join(repo, "tsx-501")), false);
});

test("hygiene cleanup plans residue roots when categories are allowed", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "guardian-clean/.opencode/worktree-guardian.json");
  await writeArtifact(repo, "guardian-origin-clean/remote.git/hooks/push-to-checkout.sample");
  const nested = path.join(repo, "opencode-temp-clean", "checkout");
  await fs.mkdir(nested, { recursive: true });
  await git(nested, ["init", "-b", "main"]);
  await git(nested, ["config", "user.email", "guardian@example.test"]);
  await git(nested, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(nested, "README.md"), "nested\n");
  await git(nested, ["add", "README.md"]);
  await git(nested, ["commit", "-m", "nested initial"]);

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", allowCategories: ["nested-git", "suspicious"] });

  assert.equal(plan.ok, true);
  assert.deepEqual((plan.targets as Array<Record<string, unknown>>).map((target) => target.path).sort(), ["guardian-clean", "guardian-origin-clean", "opencode-temp-clean"]);

  const apply = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "apply", allowCategories: ["nested-git", "suspicious"], confirmToken: plan.confirmToken });

  assert.equal(apply.ok, true);
  assert.equal(apply.status, "cleaned");
  assert.deepEqual((apply.removedTargets as Array<Record<string, unknown>>).map((target) => target.path).sort(), ["guardian-clean", "guardian-origin-clean", "opencode-temp-clean"]);
  assert.equal(await hygienePathExists(path.join(repo, "guardian-clean")), false);
  assert.equal(await hygienePathExists(path.join(repo, "guardian-origin-clean")), false);
  assert.equal(await hygienePathExists(path.join(repo, "opencode-temp-clean")), false);
});

test("hygiene cleanup removes file targets and fingerprints symlinked contents", async () => {
  const repo = await createRepo();
  await fs.writeFile(path.join(repo, "node-compile-cache"), "cache-blob\n");
  await writeArtifact(repo, "librarian-linked/file.txt");
  await fs.symlink("file.txt", path.join(repo, "librarian-linked", "link"));

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan" });

  assert.equal(plan.status, "planned");
  const targets = plan.targets as Array<Record<string, unknown>>;
  assert.deepEqual(targets.map((target) => [target.path, target.kind]), [["librarian-linked", "directory"], ["node-compile-cache", "file"]]);
  const linkedFingerprint = targets[0].fingerprint as Array<Record<string, unknown>>;
  assert.equal(linkedFingerprint.some((entry) => entry.kind === "symlink" && entry.target === "file.txt"), true);

  const apply = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "apply", confirmToken: plan.confirmToken });

  assert.equal(apply.status, "cleaned");
  assert.equal(await pathExists(path.join(repo, "node-compile-cache")), false);
  assert.equal(await pathExists(path.join(repo, "librarian-linked")), false);
});

test("hygiene scan reports failure metadata when the repo is unavailable", async () => {
  const dir = await createTempDir("guardian-hygiene-no-repo-");
  const result = await scanWorkspaceHygiene({ repoRoot: dir, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(typeof (result as Record<string, unknown>).reason, "string");
  assert.equal(result.failureReason, result.reason);
  assert.equal((result.summary as Record<string, unknown>).scanFailed, true);
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.findingCount, 0);
  assert.deepEqual(result.suggestedCommands, ["guardian_hygiene", "guardian_status"]);
});

test("hygiene cleanup apply blocks stale tokens when approved target contents change", async () => {
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, "librarian-stale"), { recursive: true });
  await fs.writeFile(path.join(repo, "librarian-stale", "file.txt"), "original\n");
  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", cleanupPaths: ["librarian-stale"] });
  assert.equal(plan.status, "planned");

  await fs.writeFile(path.join(repo, "librarian-stale", "file.txt"), "replaced\n");
  const apply = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "apply", cleanupPaths: ["librarian-stale"], confirmToken: plan.confirmToken });

  assert.equal(apply.ok, false);
  assert.equal(apply.status, "blocked");
  assert.match(String(apply.reason), /confirm token mismatch/);
  assert.equal(await hygienePathExists(path.join(repo, "librarian-stale")), true);
});
