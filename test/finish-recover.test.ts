import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianFinish } from "../src/finish.ts";
import { guardianRecover, guardianStatus } from "../src/recover.ts";
import { collectKnownWorktreePaths, guardianStart, injectInvisiblePolicy, recordLastSafeState, runGuardianTool } from "../src/tools.ts";
import { recordSession } from "../src/state.ts";
import { createRepo, createRepoWithOrigin, git, makeBranchCommit } from "./helpers.ts";

async function recordCurrentSession(repo: string, sessionId: string, branch: string, config: Record<string, any> = DEFAULT_CONFIG) {
  const { stdout: commit } = await git(repo, ["rev-parse", "HEAD"]);
  await recordSession(repo, config, {
    session_id: sessionId,
    status: "active",
    branch,
    worktree_path: repo,
    base_ref: `${config.remote}/${config.baseBranch}`,
    head_commit: commit,
    safety_refs: [],
  });
}

async function worktreePaths(repo: string) {
  const result = await git(repo, ["worktree", "list", "--porcelain"]);
  return result.stdout.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
}

test("guardian_start records current worktree ownership", async () => {
  const repo = await createRepo();
  await makeBranchCommit(repo, "guardian/start");
  const result = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_start", config: DEFAULT_CONFIG });
  assert.equal(result.ok, true);
  assert.equal(result.session.branch, "guardian/start");
  assert.equal(result.session.worktree_path, repo);
});

test("guardian_start rejects custom worktree paths outside configured root", async () => {
  const repo = await createRepoWithOrigin().then((result) => result.repo);
  await assert.rejects(
    () => guardianStart({
      repoRoot: repo,
      cwd: repo,
      sessionId: "ses_escape",
      taskName: "escape",
      createWorktree: true,
      worktreePath: path.join(path.dirname(repo), "outside-worktree"),
      config: DEFAULT_CONFIG,
    }),
    /worktreePath must stay inside/,
  );
});

test("preserve-only finish gates ownership and creates a safety ref without cleanup", async () => {
  const repo = await createRepo();
  const config: Record<string, any> = { ...DEFAULT_CONFIG, finishMode: "preserve-only" };
  const { branch } = await makeBranchCommit(repo, "guardian/preserve");
  await recordCurrentSession(repo, "ses_preserve", branch, config);

  const result = await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "ses_preserve", config, timestamp: "20260513T120000" });
  assert.equal(result.ok, true);
  assert.equal(result.status, "preserved");
  assert.match(result.safetyRef, /^refs\/opencode-guardian\/ses_preserve\/guardian\/preserve\//);
  assert.equal(result.preflight.sessionRecorded, true);
  assert.equal(result.preflight.sessionOwnedWorktree, true);
  assert.equal(result.preflight.branchProtected, false);
  assert.equal(result.preflight.dirtyFileCount, 0);
  assert.equal(result.preflight.stashCount, 0);
  assert.equal(result.preflight.safetyRef, result.safetyRef);
  assert.equal(result.report.action, "preserved");
  assert.equal(result.report.remote, config.remote);
  assert.equal(result.report.baseBranch, config.baseBranch);

  const status = await guardianStatus({ repoRoot: repo, config });
  assert.equal(status.sessions.find((session: Record<string, any>) => session.session_id === "ses_preserve").status, "preserved");
  assert.equal(status.safetyRefs.length, 1);
  assert.equal(status.worktrees.some((worktree: Record<string, any>) => worktree.path === repo), true);
});

test("preserve-only finish is idempotent for already preserved sessions", async () => {
  const repo = await createRepo();
  const config: Record<string, any> = { ...DEFAULT_CONFIG, finishMode: "preserve-only" };
  const { branch } = await makeBranchCommit(repo, "guardian/preserve-repeat");
  await recordCurrentSession(repo, "ses_preserve_repeat", branch, config);

  const first = await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "ses_preserve_repeat", config, timestamp: "20260513T140000" });
  const second = await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "ses_preserve_repeat", config, timestamp: "20260513T140100" });
  assert.equal(second.ok, true);
  assert.equal(second.status, "preserved");
  assert.equal(second.idempotent, true);
  assert.equal(second.safetyRef, first.safetyRef);
  assert.equal(second.report.action, "already-preserved");

  const status = await guardianStatus({ repoRoot: repo, config });
  const session = status.sessions.find((candidate: Record<string, any>) => candidate.session_id === "ses_preserve_repeat");
  assert.deepEqual(session.safety_refs, [first.safetyRef]);
  assert.equal(status.safetyRefs.length, 1);
});

test("finish refuses dirty worktrees before creating risk", async () => {
  const repo = await createRepo();
  const { branch } = await makeBranchCommit(repo, "guardian/dirty");
  await recordCurrentSession(repo, "ses_dirty", branch);
  await fs.writeFile(path.join(repo, "dirty.txt"), "not committed\n");

  const result = await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "ses_dirty", config: DEFAULT_CONFIG });
  assert.equal(result.ok, false);
  assert.match(result.reason, /uncommitted/);
  assert.equal(result.preflight.dirtyFileCount, 1);
  assert.deepEqual(result.report.blockers, ["worktree has uncommitted changes"]);
  assert.equal(result.report.action, "blocked");
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.safetyRefs.length, 0);
});

test("finish tolerates configured runtime dirty paths without cleaning them", async () => {
  const repo = await createRepo();
  const { branch } = await makeBranchCommit(repo, "guardian/allowed-dirty");
  await fs.mkdir(path.join(repo, ".claude", "stats"), { recursive: true });
  await fs.writeFile(path.join(repo, ".claude", "stats", "commits.json"), "{\"commits\":[]}\n");
  await git(repo, ["add", ".claude/stats/commits.json"]);
  await git(repo, ["commit", "-m", "track runtime stats"]);
  const config: Record<string, any> = { ...DEFAULT_CONFIG, finishMode: "preserve-only", allowDirtyPaths: [".claude/stats/**", ".omx/**"] };
  await recordCurrentSession(repo, "ses_allowed_dirty", branch, config);
  await fs.writeFile(path.join(repo, ".claude", "stats", "commits.json"), "{\"commits\":[\"local\"]}\n");
  await fs.mkdir(path.join(repo, ".omx"), { recursive: true });
  await fs.writeFile(path.join(repo, ".omx", "state.json"), "{\"local\":true}\n");

  const result = await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "ses_allowed_dirty", config, timestamp: "20260513T150000" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "preserved");
  assert.equal(result.preflight.dirtyFileCount, 2);
  assert.equal(result.preflight.allowedDirtyFileCount, 2);
  assert.equal(result.preflight.blockingDirtyFileCount, 0);
  assert.deepEqual(result.preflight.blockingDirtyFiles, []);
  assert.equal(result.report.allowedDirtyFileCount, 2);
  assert.equal(result.report.blockingDirtyFileCount, 0);
  assert.equal(await fs.readFile(path.join(repo, ".claude", "stats", "commits.json"), "utf8"), "{\"commits\":[\"local\"]}\n");
  assert.equal(await fs.readFile(path.join(repo, ".omx", "state.json"), "utf8"), "{\"local\":true}\n");
});

test("finish still blocks mixed dirty files outside configured runtime paths", async () => {
  const repo = await createRepo();
  const { branch } = await makeBranchCommit(repo, "guardian/mixed-dirty");
  await fs.mkdir(path.join(repo, ".claude", "logs"), { recursive: true });
  await fs.writeFile(path.join(repo, ".claude", "logs", "hooks.log"), "tracked\n");
  await git(repo, ["add", ".claude/logs/hooks.log"]);
  await git(repo, ["commit", "-m", "track runtime log"]);
  const config = { ...DEFAULT_CONFIG, allowDirtyPaths: [".claude/logs/**"] };
  await recordCurrentSession(repo, "ses_mixed_dirty", branch, config);
  await fs.writeFile(path.join(repo, ".claude", "logs", "hooks.log"), "local\n");
  await fs.writeFile(path.join(repo, ".gitignore"), "*.tmp\n");

  const result = await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "ses_mixed_dirty", config });

  assert.equal(result.ok, false);
  assert.match(result.reason, /uncommitted/);
  assert.equal(result.preflight.allowedDirtyFileCount, 1);
  assert.deepEqual(result.preflight.allowedDirtyFiles, [".claude/logs/hooks.log"]);
  assert.equal(result.preflight.blockingDirtyFileCount, 1);
  assert.deepEqual(result.preflight.blockingDirtyFiles, [".gitignore"]);
  assert.deepEqual(result.dirtyFiles, [".gitignore"]);
  const status = await guardianStatus({ repoRoot: repo, config });
  assert.equal(status.safetyRefs.length, 0);
});

test("finish matches file-specific allowDirtyPaths inside untracked runtime directories", async () => {
  const repo = await createRepo();
  const { branch } = await makeBranchCommit(repo, "guardian/file-runtime-dirty");
  const config = {
    ...DEFAULT_CONFIG,
    allowDirtyPaths: [
      ".claude/logs/hooks.log",
      ".claude/stats/commits.json",
      ".serena/project.yml",
      ".omx/state.json",
    ],
  };
  await recordCurrentSession(repo, "ses_file_runtime_dirty", branch, config);
  await fs.mkdir(path.join(repo, ".claude", "logs"), { recursive: true });
  await fs.mkdir(path.join(repo, ".claude", "stats"), { recursive: true });
  await fs.mkdir(path.join(repo, ".serena"), { recursive: true });
  await fs.mkdir(path.join(repo, ".omx"), { recursive: true });
  await fs.writeFile(path.join(repo, ".claude", "logs", "hooks.log"), "runtime log\n");
  await fs.writeFile(path.join(repo, ".claude", "stats", "commits.json"), "{}\n");
  await fs.writeFile(path.join(repo, ".serena", "project.yml"), "name: test\n");
  await fs.writeFile(path.join(repo, ".omx", "state.json"), "{}\n");
  await fs.writeFile(path.join(repo, ".gitignore"), "*.tmp\n");

  const result = await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "ses_file_runtime_dirty", config });

  assert.equal(result.ok, false);
  assert.match(result.reason, /uncommitted/);
  assert.deepEqual(result.preflight.allowedDirtyFiles.sort(), [
    ".claude/logs/hooks.log",
    ".claude/stats/commits.json",
    ".omx/state.json",
    ".serena/project.yml",
  ].sort());
  assert.deepEqual(result.preflight.blockingDirtyFiles, [".gitignore"]);
  assert.equal(result.preflight.allowedDirtyFileCount, 4);
  assert.equal(result.preflight.blockingDirtyFileCount, 1);
  const status = await guardianStatus({ repoRoot: repo, config });
  assert.equal(status.safetyRefs.length, 0);
});

test("finish blocks renames from allowed runtime paths into source paths", async () => {
  const repo = await createRepo();
  const { branch } = await makeBranchCommit(repo, "guardian/rename-dirty");
  await fs.mkdir(path.join(repo, ".claude", "logs"), { recursive: true });
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  await fs.writeFile(path.join(repo, ".claude", "logs", "hooks.log"), "tracked\n");
  await git(repo, ["add", ".claude/logs/hooks.log"]);
  await git(repo, ["commit", "-m", "track runtime log"]);
  const config = { ...DEFAULT_CONFIG, allowDirtyPaths: [".claude/logs/**"] };
  await recordCurrentSession(repo, "ses_rename_dirty", branch, config);
  await git(repo, ["mv", ".claude/logs/hooks.log", "src/hooks.log"]);

  const result = await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "ses_rename_dirty", config });

  assert.equal(result.ok, false);
  assert.match(result.reason, /uncommitted/);
  assert.equal(result.preflight.allowedDirtyFileCount, 1);
  assert.deepEqual(result.preflight.allowedDirtyFiles, [".claude/logs/hooks.log"]);
  assert.equal(result.preflight.blockingDirtyFileCount, 1);
  assert.deepEqual(result.preflight.blockingDirtyFiles, ["src/hooks.log"]);
  const status = await guardianStatus({ repoRoot: repo, config });
  assert.equal(status.safetyRefs.length, 0);
});

test("merge-to-base skips cleanup when allowed dirty files are present", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const config = { ...DEFAULT_CONFIG, finishMode: "merge-to-base", allowDirtyPaths: [".omx/**"] };
  const start = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_merge_allowed_dirty", taskName: "merge allowed dirty", createWorktree: true, config });
  await fs.writeFile(path.join(start.session.worktree_path, "merged.txt"), "merged\n");
  await git(start.session.worktree_path, ["add", "merged.txt"]);
  await git(start.session.worktree_path, ["commit", "-m", "add merged file"]);
  await fs.mkdir(path.join(start.session.worktree_path, ".omx"), { recursive: true });
  await fs.writeFile(path.join(start.session.worktree_path, ".omx", "state.json"), "{\"local\":true}\n");

  const result = await guardianFinish({ repoRoot: repo, cwd: start.session.worktree_path, sessionId: "ses_merge_allowed_dirty", config, allowMergeToBase: true, allowCleanup: true });

  assert.equal(result.ok, true);
  assert.equal(result.status, "merged");
  assert.equal(result.cleaned, false);
  assert.equal(result.cleanupSkippedReason, "allowed dirty files are present");
  assert.equal(result.preflight.allowedDirtyFileCount, 1);
  assert.equal(result.report.cleanupSkippedReason, "allowed dirty files are present");
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal(await fs.readFile(path.join(start.session.worktree_path, ".omx", "state.json"), "utf8"), "{\"local\":true}\n");
  await git(repo, ["merge-base", "--is-ancestor", result.commit, "origin/main"]);
});

test("push-branch finish reports push failures without cleanup", async () => {
  const repo = await createRepo();
  const config = { ...DEFAULT_CONFIG, finishMode: "push-branch" };
  const { branch } = await makeBranchCommit(repo, "guardian/push-failure");
  await recordCurrentSession(repo, "ses_push_failure", branch, config);

  const result = await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "ses_push_failure", config, timestamp: "20260513T130000" });
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /push failed/i);
  assert.match(result.safetyRef, /^refs\/opencode-guardian\/ses_push_failure\/guardian\/push-failure\//);
  assert.equal(result.preflight.safetyRef, result.safetyRef);
  assert.equal(result.report.safetyRef, result.safetyRef);
  assert.equal(result.report.action, "blocked");

  const status = await guardianStatus({ repoRoot: repo, config });
  const session = status.sessions.find((candidate: Record<string, any>) => candidate.session_id === "ses_push_failure");
  assert.equal(session.status, "active");
  assert.deepEqual(session.safety_refs, [result.safetyRef]);
  assert.equal(status.safetyRefs.length, 1);
  assert.equal(status.worktrees.some((worktree: Record<string, any>) => worktree.path === repo), true);
});

test("default finish mode pushes branch and returns a PR suggestion", async () => {
  const { repo, remote } = await createRepoWithOrigin();
  const config = DEFAULT_CONFIG;
  const { branch } = await makeBranchCommit(repo, "guardian/pr");
  await recordCurrentSession(repo, "ses_pr", branch, config);

  const result = await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "ses_pr", config });
  assert.equal(result.ok, true);
  assert.equal(result.status, "pr-suggested");
  assert.match(result.suggestedCommand, /gh pr create/);
  assert.equal(result.report.action, "pushed-and-suggested-pr");
  assert.equal(result.report.suggestedCommand, result.suggestedCommand);
  const refs = await git(remote, ["show-ref", "refs/heads/guardian/pr"]);
  assert.match(refs.stdout, /refs\/heads\/guardian\/pr/);
  const status = await guardianStatus({ repoRoot: repo, config });
  const session = status.sessions.find((candidate: Record<string, any>) => candidate.session_id === "ses_pr");
  assert.equal(session.status, "preserved");
});

test("merge-to-base requires explicit mode and ancestry proof", async () => {
  const { repo } = await createRepoWithOrigin();
  const config = { ...DEFAULT_CONFIG, finishMode: "merge-to-base" };
  const { branch, commit } = await makeBranchCommit(repo, "guardian/merge");
  await recordCurrentSession(repo, "ses_merge", branch, config);

  const refused = await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "ses_merge", config });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /allowMergeToBase/);
  assert.equal(refused.preflight.safetyRef, refused.safetyRef);
  assert.equal(refused.report.action, "requires-explicit-merge-approval");

  const result = await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "ses_merge", config, allowMergeToBase: true });
  assert.equal(result.ok, true);
  assert.equal(result.status, "merged");
  const ancestry = await git(repo, ["merge-base", "--is-ancestor", commit, "origin/main"]).then(() => true, () => false);
  assert.equal(ancestry, true);
});

test("recover/status are read-only inventories with suggestions", async () => {
  const repo = await createRepo();
  const config: Record<string, any> = { ...DEFAULT_CONFIG, finishMode: "preserve-only" };
  const { branch } = await makeBranchCommit(repo, "guardian/recover");
  await recordCurrentSession(repo, "ses_recover", branch, config);

  await recordSession(repo, DEFAULT_CONFIG, {
    session_id: "ses_orphan",
    status: "active",
    branch: "guardian/orphan",
    worktree_path: path.join(repo, ".missing-worktree"),
    base_ref: "origin/main",
    safety_refs: [],
  });

  await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "ses_recover", config });

  await git(repo, ["branch", "guardian/branch-only"]);
  const unmanagedWorktree = path.join(path.dirname(repo), `${path.basename(repo)}-unmanaged-worktree`);
  await git(repo, ["worktree", "add", "-b", "guardian/unmanaged-worktree", unmanagedWorktree, "HEAD"]);
  const before = await git(repo, ["rev-parse", "HEAD"]);
  const recovery = await guardianRecover({ repoRoot: repo, config: DEFAULT_CONFIG });
  const after = await git(repo, ["rev-parse", "HEAD"]);
  assert.equal(before.stdout, after.stdout);
  assert.equal(recovery.orphanedSessions.some((session: Record<string, any>) => session.session_id === "ses_orphan"), true);
  assert.equal(recovery.branchesWithoutWorktrees.some((branch: Record<string, any>) => branch.name === "guardian/branch-only"), true);
  assert.equal(recovery.worktreesWithoutState.length >= 1, true);
  assert.equal(recovery.stateBranchesWithoutWorktrees.includes("guardian/orphan"), true);
  assert.equal(recovery.safetyRefs.length >= 1, true);
  assert.equal(recovery.suggestedCommands.some((command: string) => command.startsWith("git branch recovery/")), true);
});

test("guardian_status classifies external temp worktrees without Guardian state", async () => {
  const repo = await createRepo();
  const tempRoot = await fs.mkdtemp(path.join(path.dirname(repo), "opencode-temp-"));
  const externalWorktree = path.join(tempRoot, "emqx-compaction-deploy-20260522T140221Z");
  await git(repo, ["worktree", "add", "-b", "deploy/compaction-full-day-20260522T140221Z", externalWorktree, "HEAD"]);

  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const finding = status.worktreesWithoutState.find((worktree: Record<string, any>) => worktree.path === externalWorktree);
  assert.equal(finding?.category, "external-temp-worktree");
  assert.equal(finding?.severity, "fail");
  assert.match(finding?.reason, /outside Guardian/);
  assert.equal(finding?.metadata?.commonGitDir, path.join(repo, ".git"));
});

test("invisible policy helper injects policy but does not enable auto-finish by default", () => {
  const output = { system: ["existing"] };
  assert.equal(injectInvisiblePolicy(output, DEFAULT_CONFIG), true);
  assert.equal(output.system.length, 2);
  assert.match(output.system[1], /auto-finish is disabled/);
  assert.match(output.system[1], /guardian_finish/);
  assert.match(output.system[1], /protected branches/);
});

test("guardian tool dispatcher exposes internal functions", async () => {
  const repo = await createRepo();
  const result = await runGuardianTool("guardian_status", { repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(result.repoRoot, repo);
  await assert.rejects(() => runGuardianTool("unknown", {}), /Unknown guardian tool/);
});


test("tool-after recording updates last safe session state", async () => {
  const repo = await createRepo();
  const { branch } = await makeBranchCommit(repo, "guardian/after");
  const result = await recordLastSafeState({ repoRoot: repo, cwd: repo, sessionID: "ses_after", tool: "bash", config: DEFAULT_CONFIG });
  assert.equal(result.ok, true);
  assert.equal(result.session.branch, branch);
  assert.equal(result.session.status, "active");
});


test("known worktree path collection includes sibling worktrees and configured root", async () => {
  const { repo } = await createRepoWithOrigin();
  const a = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_a", taskName: "a", createWorktree: true, config: DEFAULT_CONFIG });
  const b = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_b", taskName: "b", createWorktree: true, config: DEFAULT_CONFIG });
  const paths = await collectKnownWorktreePaths({ repoRoot: repo, cwd: a.session.worktree_path, currentWorktree: a.session.worktree_path, config: DEFAULT_CONFIG });
  assert.equal(paths.includes(a.session.worktree_path), true);
  assert.equal(paths.includes(b.session.worktree_path), true);
  assert.equal(paths.some((candidate: string) => candidate.endsWith(".worktrees/" + path.basename(repo))), true);
});

test("explicit guardian start creates distinct worktrees for two sessions and is idempotent", async () => {
  const { repo } = await createRepoWithOrigin();
  const first = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_one", taskName: "one", createWorktree: true, config: DEFAULT_CONFIG });
  const repeated = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_one", taskName: "one", createWorktree: true, config: DEFAULT_CONFIG });
  const second = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_two", taskName: "two", createWorktree: true, config: DEFAULT_CONFIG });
  assert.equal(repeated.existing, true);
  assert.notEqual(first.session.worktree_path, repo);
  assert.notEqual(second.session.worktree_path, repo);
  assert.notEqual(first.session.worktree_path, second.session.worktree_path);
});
