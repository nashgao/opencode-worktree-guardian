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
  const { branch } = await makeBranchCommit(repo, "guardian/preserve");
  await recordCurrentSession(repo, "ses_preserve", branch);

  const result = await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "ses_preserve", config: DEFAULT_CONFIG, timestamp: "20260513T120000" });
  assert.equal(result.ok, true);
  assert.equal(result.status, "preserved");
  assert.match(result.safetyRef, /^refs\/opencode-guardian\/ses_preserve\/guardian\/preserve\//);

  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.sessions.find((session: Record<string, any>) => session.session_id === "ses_preserve").status, "preserved");
  assert.equal(status.safetyRefs.length, 1);
  assert.equal(status.worktrees.some((worktree: Record<string, any>) => worktree.path === repo), true);
});

test("finish refuses dirty worktrees before creating risk", async () => {
  const repo = await createRepo();
  const { branch } = await makeBranchCommit(repo, "guardian/dirty");
  await recordCurrentSession(repo, "ses_dirty", branch);
  await fs.writeFile(path.join(repo, "dirty.txt"), "not committed\n");

  const result = await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "ses_dirty", config: DEFAULT_CONFIG });
  assert.equal(result.ok, false);
  assert.match(result.reason, /uncommitted/);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.safetyRefs.length, 0);
});

test("create-pr mode pushes branch and returns a PR suggestion", async () => {
  const { repo, remote } = await createRepoWithOrigin();
  const config = { ...DEFAULT_CONFIG, finishMode: "create-pr" };
  const { branch } = await makeBranchCommit(repo, "guardian/pr");
  await recordCurrentSession(repo, "ses_pr", branch, config);

  const result = await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "ses_pr", config });
  assert.equal(result.ok, true);
  assert.equal(result.status, "pr-suggested");
  assert.match(result.suggestedCommand, /gh pr create/);
  const refs = await git(remote, ["show-ref", "refs/heads/guardian/pr"]);
  assert.match(refs.stdout, /refs\/heads\/guardian\/pr/);
});

test("merge-to-base requires explicit mode and ancestry proof", async () => {
  const { repo } = await createRepoWithOrigin();
  const config = { ...DEFAULT_CONFIG, finishMode: "merge-to-base" };
  const { branch, commit } = await makeBranchCommit(repo, "guardian/merge");
  await recordCurrentSession(repo, "ses_merge", branch, config);

  const refused = await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "ses_merge", config });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /allowMergeToBase/);

  const result = await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "ses_merge", config, allowMergeToBase: true });
  assert.equal(result.ok, true);
  assert.equal(result.status, "merged");
  const ancestry = await git(repo, ["merge-base", "--is-ancestor", commit, "origin/main"]).then(() => true, () => false);
  assert.equal(ancestry, true);
});

test("recover/status are read-only inventories with suggestions", async () => {
  const repo = await createRepo();
  const { branch } = await makeBranchCommit(repo, "guardian/recover");
  await recordCurrentSession(repo, "ses_recover", branch);
  await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "ses_recover", config: DEFAULT_CONFIG });

  await recordSession(repo, DEFAULT_CONFIG, {
    session_id: "ses_orphan",
    status: "active",
    branch: "guardian/orphan",
    worktree_path: path.join(repo, ".missing-worktree"),
    base_ref: "origin/main",
    safety_refs: [],
  });

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

test("invisible policy helper injects policy but does not enable auto-finish by default", () => {
  const output = { system: ["existing"] };
  assert.equal(injectInvisiblePolicy(output, DEFAULT_CONFIG), true);
  assert.equal(output.system.length, 2);
  assert.match(output.system[1], /auto-finish is disabled/);
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

test("invisible auto-start creates distinct worktrees for two sessions and is idempotent", async () => {
  const { repo } = await createRepoWithOrigin();
  const first = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_one", taskName: "one", createWorktree: true, config: DEFAULT_CONFIG });
  const repeated = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_one", taskName: "one", createWorktree: true, config: DEFAULT_CONFIG });
  const second = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_two", taskName: "two", createWorktree: true, config: DEFAULT_CONFIG });
  assert.equal(repeated.existing, true);
  assert.notEqual(first.session.worktree_path, repo);
  assert.notEqual(second.session.worktree_path, repo);
  assert.notEqual(first.session.worktree_path, second.session.worktree_path);
});
