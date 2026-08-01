import {
  advanceBase,
  assert,
  branchExists,
  createGuardianWorktree,
  createRepoWithOrigin,
  DEFAULT_CONFIG,
  deleteWorktree,
  findSession,
  fs,
  fs as fixtureFs,
  git,
  guardianStatus,
  path,
  refExists,
  test,
  worktreePaths,
} from "./delete-fixtures.js";
import { guardianDeleteWorktree } from "../src/delete.ts";
import { guardianStart } from "../src/start.ts";
import { isRecordLike } from "../src/types.ts";

const ownedRoots: string[] = [];

async function commitUnmerged(worktree: string): Promise<string> {
  await fs.writeFile(path.join(worktree, "unmerged.txt"), "unmerged\n");
  await git(worktree, ["add", "unmerged.txt"]);
  await git(worktree, ["commit", "-m", "unmerged abandonment candidate"]);
  return (await git(worktree, ["rev-parse", "HEAD"])).stdout;
}

async function advancedCommit(repo: string, head: string): Promise<string> {
  const tree = (await git(repo, ["rev-parse", `${head}^{tree}`])).stdout;
  return (await git(repo, ["commit-tree", tree, "-p", head, "-m", "advance abandonment branch"])).stdout;
}

test.after(async () => {
  const remaining = await Promise.all(ownedRoots.map((root) => fs.access(root).then(() => root, () => null)));
  assert.deepEqual(remaining.filter((root): root is string => root !== null), []);
});

test("branch-only abandonment preserves a branch advanced after safety ref", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "final-review-branch-only-cas";
  const branch = "guardian/final-review-branch-only-cas";
  const started = await createGuardianWorktree(repo, sessionId, "branch-only CAS", branch);
  const head = await commitUnmerged(started.session.worktree_path);
  const advanced = await advancedCommit(repo, head);
  const retainRequest = { repoRoot: repo, cwd: repo, sessionId, deleteBranch: false, config: DEFAULT_CONFIG, timestamp: "20260730T020202" };
  const retainPlan = await deleteWorktree({ ...retainRequest, mode: "plan" });
  const retained = await deleteWorktree({ ...retainRequest, mode: "apply", confirmToken: retainPlan.confirmToken });
  assert.equal(retained.ok, true, JSON.stringify(retained));
  assert.equal(await branchExists(repo, branch), true);

  const request = { repoRoot: repo, cwd: repo, sessionId, deleteBranch: true, abandonUnmerged: true, config: DEFAULT_CONFIG, timestamp: "20260730T030303" };
  const plan = await deleteWorktree({ ...request, mode: "plan" });
  const tools = path.join(base, "race-tools");
  await fs.mkdir(tools);
  await fs.writeFile(path.join(tools, "git"), `#!/bin/sh\nif [ "$3" = update-ref ]; then\n  for arg in "$@"; do\n    case "$arg" in\n      refs/opencode-guardian/*)\n        /usr/bin/git "$@" || exit $?\n        exec /usr/bin/git -C ${JSON.stringify(repo)} update-ref refs/heads/${branch} ${advanced}\n        ;;\n    esac\n  done\nfi\nexec /usr/bin/git "$@"\n`);
  await fs.chmod(path.join(tools, "git"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${tools}${path.delimiter}${originalPath ?? ""}`;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  const result = await deleteWorktree({ ...request, mode: "apply", confirmToken: plan.confirmToken });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.equal(result.worktreeRemoved, false);
  assert.equal(result.branchDeleted, false);
  assert.equal(await branchExists(repo, branch), true);
  assert.equal((await git(repo, ["rev-parse", `refs/heads/${branch}`])).stdout, advanced);
});

test("redundant dirty apply reports partial branch deletion failure with snapshot recovery", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_redundant_dirty_branch_partial", "redundant dirty branch partial", "guardian/redundant-dirty-branch-partial");
  await advanceBase(repo, "advance base for branch partial", [{ file: "README.md", content: "base branch partial\n" }]);
  await fs.writeFile(path.join(start.session.worktree_path, "README.md"), "base branch partial\n");
  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_branch_partial", allowRedundantDirtyPaths: true, deleteBranch: true, config: DEFAULT_CONFIG, timestamp: "20260601T211000" });
  assert.equal(plan.ok, true);
  const lockPath = path.join(repo, ".git", "refs", "heads", "guardian", "redundant-dirty-branch-partial.lock");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, "locked\n");

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId: "ses_redundant_dirty_branch_partial", allowRedundantDirtyPaths: true, deleteBranch: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T211000" });

  assert.equal(result.ok, false);
  assert.equal(result.status, "partial");
  assert.equal(result.branchDeleted, false);
  assert.equal(result.worktreeRemoved, true);
  assert.equal(typeof result.dirtySnapshotRef, "string");
  assert.equal(typeof result.dirtySnapshotCommit, "string");
  assert.equal(result.dirtySnapshotFileCount, 1);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), false);
  assert.equal(await branchExists(repo, "guardian/redundant-dirty-branch-partial"), true);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const session = findSession(status, "ses_redundant_dirty_branch_partial");
  assert.deepEqual(session.safety_refs, [result.safetyRef, result.dirtySnapshotRef]);
  assert.equal(session.branch_delete_failed, true);
});

test("redundant dirty apply blocks removal failure with snapshot recovery", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_redundant_dirty_remove_partial", "redundant dirty remove partial", "guardian/redundant-dirty-remove-partial");
  await advanceBase(repo, "advance base for remove partial", [{ file: "README.md", content: "base remove partial\n" }]);
  await fs.writeFile(path.join(start.session.worktree_path, "README.md"), "base remove partial\n");
  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_remove_partial", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG, timestamp: "20260601T212000" });
  assert.equal(plan.ok, true);
  await git(repo, ["worktree", "lock", "--reason", "test removal failure", start.session.worktree_path]);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId: "ses_redundant_dirty_remove_partial", allowRedundantDirtyPaths: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260601T212000" });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /worktree removal failed/);
  assert.equal(result.worktreeRemoved, false);
  assert.equal(typeof result.dirtySnapshotRef, "string");
  assert.equal(result.cleanedDirtyFileCount, 1);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const session = findSession(status, "ses_redundant_dirty_remove_partial");
  assert.deepEqual(session.safety_refs, [result.safetyRef, result.dirtySnapshotRef]);
});

test("redundant dirty fail closed when dirty content changes after planning", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_redundant_dirty_stale");
  await advanceBase(repo, "advance base for stale dirty", [{ file: "README.md", content: "base stale\n" }]);
  await fs.writeFile(path.join(start.session.worktree_path, "README.md"), "base stale\n");
  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_stale", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });
  assert.equal(plan.ok, true);
  await fs.writeFile(path.join(start.session.worktree_path, "README.md"), "local stale\n");

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId: "ses_redundant_dirty_stale", allowRedundantDirtyPaths: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /redundant dirty proof/i);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG })).safetyRefs.length, 0);
});

test("redundant dirty fail closed on symlink paths", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_redundant_dirty_symlink");
  await advanceBase(repo, "advance base with file", [{ file: "base-only.txt", content: "base file\n" }]);
  await fs.symlink("README.md", path.join(start.session.worktree_path, "base-only.txt"));

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_symlink", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /unsupported dirty path/i);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG })).safetyRefs.length, 0);
});

test("redundant dirty fail closed on rename conflict and directory type-change statuses", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  await advanceBase(repo, "seed type-change file", [{ file: "type-change.txt", content: "base file\n" }]);
  const renamed = await createGuardianWorktree(repo, "ses_redundant_dirty_rename");
  const conflicted = await createGuardianWorktree(repo, "ses_redundant_dirty_conflict", "conflict dirty", "guardian/redundant-dirty-conflict");
  const directory = await createGuardianWorktree(repo, "ses_redundant_dirty_directory");
  await advanceBase(repo, "advance base for unsupported statuses", [{ file: "README.md", content: "base unsupported\n" }]);
  await git(renamed.session.worktree_path, ["mv", "README.md", "RENAMED.md"]);

  await fs.writeFile(path.join(conflicted.session.worktree_path, "README.md"), "local conflict\n");
  await git(conflicted.session.worktree_path, ["add", "README.md"]);
  await git(conflicted.session.worktree_path, ["commit", "-m", "local conflict"]);
  await assert.rejects(git(conflicted.session.worktree_path, ["merge", "origin/main"]));

  await fs.rm(path.join(directory.session.worktree_path, "type-change.txt"));
  await fs.mkdir(path.join(directory.session.worktree_path, "type-change.txt"));
  await fs.writeFile(path.join(directory.session.worktree_path, "type-change.txt", "nested.txt"), "nested\n");

  const renameResult = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_rename", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });
  const conflictResult = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_conflict", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });
  const directoryResult = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_redundant_dirty_directory", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });

  assert.equal(renameResult.ok, false);
  assert.match(renameResult.reason, /unsupported dirty status/i);
  assert.equal(conflictResult.ok, false);
  assert.match(conflictResult.reason, /unsupported dirty status|redundant dirty proof/i);
  assert.equal(directoryResult.ok, false);
  assert.match(directoryResult.reason, /redundant dirty proof|unsupported dirty path/i);
  assert.equal((await worktreePaths(repo)).includes(renamed.session.worktree_path), true);
  assert.equal((await worktreePaths(repo)).includes(conflicted.session.worktree_path), true);
  assert.equal((await worktreePaths(repo)).includes(directory.session.worktree_path), true);
});

test("reference transaction hook blocks redundant-dirty snapshot apply before either ref", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  ownedRoots.push(base);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "hook-redundant-dirty", taskName: "hook-redundant-dirty", createWorktree: true, config: DEFAULT_CONFIG });
  assert.equal(started.ok, true, JSON.stringify(started));
  await fs.writeFile(path.join(repo, "README.md"), "base advance\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "advance base"]);
  await git(repo, ["push", "origin", "main"]);
  await fs.writeFile(path.join(started.session.worktree_path, "README.md"), "base advance\n", "utf8");
  const plan = await guardianDeleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "hook-redundant-dirty", allowRedundantDirtyPaths: true, config: DEFAULT_CONFIG });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const marker = path.join(base, "snapshot-hook-ran");
  const hooks = path.join(repo, "reference-transaction-hooks");
  await fs.mkdir(hooks, { recursive: true });
  await fs.writeFile(path.join(hooks, "reference-transaction"), `#!/bin/sh\nprintf hook > ${JSON.stringify(marker)}\n`, "utf8");
  await fs.chmod(path.join(hooks, "reference-transaction"), 0o755);
  await git(started.session.worktree_path, ["config", "core.hooksPath", hooks]);

  const result = await guardianDeleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId: "hook-redundant-dirty", allowRedundantDirtyPaths: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false, JSON.stringify(result));
  await assert.rejects(fs.access(marker));
  assert.equal((await git(repo, ["for-each-ref", "refs/opencode-guardian"])).stdout, "");
  assert.equal((await git(repo, ["worktree", "list", "--porcelain"])).stdout.includes(started.session.worktree_path), true);
});

test("Guardian preserves a raced ignored worktree and blocks reappearing content at deletion boundary", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fixtureFs.rm(base, { recursive: true, force: true }));
  const sessionId = "ses_deletion_fingerprint_race";
  const branch = "guardian/deletion-fingerprint-race";
  const start = await createGuardianWorktree(repo, sessionId, "deletion fingerprint race", branch);
  const worktree = start.session.worktree_path;
  const ignoredDirectory = path.join(worktree, "ignored-output");
  await fixtureFs.writeFile(path.join(worktree, ".gitignore"), "ignored-output/\n");
  await git(worktree, ["add", ".gitignore"]);
  await git(worktree, ["commit", "-m", "ignore deletion fingerprint output"]);
  await fixtureFs.mkdir(ignoredDirectory);
  await fixtureFs.writeFile(path.join(ignoredDirectory, "planned.log"), "planned\n");

  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, deleteBranch: false, allowIgnoredFiles: true, config: DEFAULT_CONFIG, timestamp: "20260729T180000" });

  assert.equal(plan.ok, true, JSON.stringify(plan));
  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId, deleteBranch: false, allowIgnoredFiles: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG, timestamp: "20260729T180000" }, {
    beforeWorktreeRemoval: async () => {
      await fixtureFs.writeFile(path.join(ignoredDirectory, "reappeared.log"), "reappeared\n");
    },
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /ignored-file consent changed at deletion boundary/i);
  assert.equal(result.requiresFreshPlan, true);
  assert.equal(result.report.action, "blocked");
  assert.notEqual(JSON.stringify(result.ignoredFileFingerprint), JSON.stringify(plan.preflight.ignoredFileFingerprint));
  assert.equal((await worktreePaths(repo)).includes(worktree), true);
  assert.equal(await branchExists(repo, branch), true);
  assert.equal(await refExists(repo, String(result.safetyRef)), true);
  const session = findSession(await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG }), sessionId);
  assert.equal(session.status, "active");
  assert.equal(session.safety_refs?.includes(String(result.safetyRef)), true);
  assert.equal(Object.hasOwn(session, "worktree_delete_failed"), false);
});

test("redundant dirty deletion blocks overlapping trusted remote namespaces before base proof", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "authority-overlap-dirty", taskName: "authority overlap dirty", createWorktree: true, config: DEFAULT_CONFIG });
  assert.equal(started.ok, true, JSON.stringify(started));
  await fs.writeFile(path.join(started.session.worktree_path, "redundant.txt"), "dirty\n");
  const config = { ...DEFAULT_CONFIG, trustedUpstreamRemotes: ["origin/main"] };

  const result = await guardianDeleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "authority-overlap-dirty", deleteBranch: true, allowRedundantDirtyPaths: true, config });
  const preflight = isRecordLike(result.preflight) ? result.preflight : {};

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(String(result.error), /remote namespaces overlap/);
  assert.equal(preflight.baseRefOid, null);
});
