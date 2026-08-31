import {
  assert,
  branchExists,
  createMergedBranch,
  createRepoWithOrigin,
  createSafetyRef,
  DEFAULT_CONFIG,
  fs,
  git,
  guardianFinishWorkflow,
  pathExists,
  remoteBranchExists,
  test,
  workflowResult,
} from "./workflow-test-support.js";
import path from "node:path";
import { guardianDone } from "../src/done.ts";
import { finalPostflightCommitsFromCleanupSweep } from "../src/done-cleanup-sweep.ts";
import { observeBaseTransition } from "../src/done-all-cleanup.ts";
import { guardianStart } from "../src/start.ts";
import { batchChildFailureCanContinue, classifyLandBaseTransition } from "../src/done-land-clean-consent.ts";
import { isRecordLike } from "../src/types.ts";
import { installFakeGh } from "./delete-fixtures.ts";
import { installMultiBranchFakeGh } from "./workflow-test-support.ts";

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(`${name} must be a non-empty string`);
}

async function commitInWorktree(worktree: string, file: string, content: string, message: string) {
  await fs.writeFile(path.join(worktree, file), content);
  await git(worktree, ["add", file]);
  await git(worktree, ["commit", "-m", message]);
}

test("cleanup sweep final postflight commits include nested deleted heads", () => {
  const commits = finalPostflightCommitsFromCleanupSweep({ ok: true, preSession: { apply: { results: [{ ok: true, branchDeleted: true, branch: "guardian/pre", head: "abc123" }, { ok: false, branchDeleted: true, branch: "guardian/failed", head: "def456" }] } }, postSession: { apply: { results: [{ ok: true, remoteBranchDeleted: true, remote: "origin", remoteBranch: "guardian/post", head: "789abc" }] } } });
  assert.deepEqual(commits.map((entry) => ({ commit: entry.commit, source: entry.source })), [{ commit: "abc123", source: "guardian/pre" }, { commit: "789abc", source: "origin/guardian/post" }]);
});

test("guardian_done all=true apply requires confirm=true", async (t) => {
  const { base, repo } = await createRepoWithOrigin(); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const a = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_all_confirm", taskName: "confirm", createWorktree: true, config: DEFAULT_CONFIG }); await commitInWorktree(a.session.worktree_path, "feat-a.txt", "a\n", "feat a");
  const plan = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan" }) as Record<string, unknown>; const apply = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "apply", confirmToken: plan.confirmToken as string }) as Record<string, unknown>;
  assert.equal(apply.ok, false); assert.equal(apply.status, "blocked"); assert.equal(apply.confirmationRequired, true); assert.equal(apply.tokenChecked, false); assert.equal(apply.remoteRefresh, "skipped"); assert.match(apply.reason as string, /confirm=true/);
});

test("guardian_done all=true apply blocks a stale confirm token after a session goes dirty", async (t) => {
  const { base, repo } = await createRepoWithOrigin(); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const a = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_all_stale", taskName: "stale", createWorktree: true, config: DEFAULT_CONFIG }); await commitInWorktree(a.session.worktree_path, "feat-a.txt", "a\n", "feat a");
  const plan = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan" }) as Record<string, unknown>; await fs.writeFile(path.join(a.session.worktree_path, "late.txt"), "late\n");
  const apply = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "apply", confirm: true, confirmToken: plan.confirmToken as string }) as Record<string, unknown>;
  assert.equal(apply.ok, false); assert.equal(apply.status, "blocked"); assert.match(apply.reason as string, /confirm token mismatch/);
});

test("batch ratchet accepts only the approved base topology", () => {
  const base = { before: "base", approvedHead: "head", approvedHeadIsAncestor: true, beforeIsAncestor: true, approvedTreeMatches: false, pullRequestMergeMethod: "merge" as const };
  for (const [input, expected] of [
    [{ ...base, after: "base", parents: [] }, { ok: true, kind: "unchanged-approved" }],
    [{ ...base, after: "head", parents: [] }, { ok: true, kind: "fast-forward" }],
    [{ ...base, after: "merge", parents: ["base", "head"] }, { ok: true, kind: "merge" }],
    [{ ...base, after: "squash", parents: ["base"], approvedTreeMatches: true, pullRequestMergeMethod: "squash" }, { ok: true, kind: "squash" }],
    [{ ...base, after: "squash", parents: ["base"], approvedTreeMatches: true }, { ok: false, code: "unauthorized-base-transition" }],
    [{ ...base, after: "merge", parents: ["base", "head"], approvedTreeMatches: true, pullRequestMergeMethod: "squash" }, { ok: false, code: "unauthorized-base-transition" }],
    [{ ...base, after: "head", parents: [], approvedTreeMatches: true, pullRequestMergeMethod: "squash" }, { ok: false, code: "unauthorized-base-transition" }],
    [{ ...base, after: "squash", parents: ["base"], pullRequestMergeMethod: "squash" }, { ok: false, code: "unauthorized-base-transition" }],
    [{ ...base, after: "base", parents: [], approvedHeadIsAncestor: false }, { ok: false, code: "approved-head-not-landed" }],
    [{ ...base, after: "head", parents: [], beforeIsAncestor: false }, { ok: false, code: "external-before" }],
    [{ ...base, after: "merge", parents: ["head", "base"] }, { ok: false, code: "unauthorized-base-transition" }],
    [{ ...base, after: "descendant", parents: ["base"] }, { ok: false, code: "unauthorized-base-transition" }],
    [{ ...base, after: "octopus", parents: ["base", "head", "other"] }, { ok: false, code: "unauthorized-base-transition" }],
    [{ ...base, after: "unrelated", parents: ["other", "head"] }, { ok: false, code: "unauthorized-base-transition" }],
  ] as const) assert.deepEqual(classifyLandBaseTransition(input), expected);
});

test("batch ratchet enforces the configured merge method when observing the remote base", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const before = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  await git(repo, ["checkout", "-b", "guardian/batch-squash-observation"]);
  await fs.writeFile(path.join(repo, "batch-squash.txt"), "batch squash\n");
  await git(repo, ["add", "batch-squash.txt"]);
  await git(repo, ["commit", "-m", "add batch squash fixture"]);
  const approvedHead = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  await git(repo, ["checkout", "main"]);
  await git(repo, ["merge", "--squash", "guardian/batch-squash-observation"]);
  await git(repo, ["commit", "-m", "squash batch fixture"]);
  await git(repo, ["push", "origin", "main"]);

  const transition = await observeBaseTransition(repo, "refs/remotes/origin/main", "origin", before, approvedHead, "merge");

  assert.equal(transition.ok, false, JSON.stringify(transition));
  assert.equal(transition.code, "unauthorized-base-transition");
});

test("batch ratchet rejects a fast-forward when squash is configured", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const before = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  await git(repo, ["checkout", "-b", "guardian/batch-fast-forward-observation"]);
  await fs.writeFile(path.join(repo, "batch-fast-forward.txt"), "batch fast-forward\n");
  await git(repo, ["add", "batch-fast-forward.txt"]);
  await git(repo, ["commit", "-m", "add batch fast-forward fixture"]);
  const approvedHead = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  await git(repo, ["checkout", "main"]);
  await git(repo, ["merge", "--ff-only", "guardian/batch-fast-forward-observation"]);
  await git(repo, ["push", "origin", "main"]);

  const transition = await observeBaseTransition(repo, "refs/remotes/origin/main", "origin", before, approvedHead, "squash");

  assert.equal(transition.ok, false, JSON.stringify(transition));
  assert.equal(transition.code, "unauthorized-base-transition");
});

test("batch child failure continues only when the base did not move", () => {
  assert.equal(batchChildFailureCanContinue(false, "base", "base"), true);
  assert.equal(batchChildFailureCanContinue(false, "base", "advanced"), false);
  assert.equal(batchChildFailureCanContinue(true, "base", "base"), false);
});

test("guardianDone all stops after a landed child post-merge fetch failure", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const a = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_all_cleanup_a", taskName: "cleanup a", createWorktree: true, config: DEFAULT_CONFIG });
  const b = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_all_cleanup_b", taskName: "cleanup b", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(a.session.worktree_path, "feat-a.txt"), "a\n");
  await git(a.session.worktree_path, ["add", "feat-a.txt"]);
  await git(a.session.worktree_path, ["commit", "-m", "feat a"]);
  const aHead = (await git(a.session.worktree_path, ["rev-parse", "HEAD"])).stdout;
  await fs.writeFile(path.join(b.session.worktree_path, "feat-b.txt"), "b\n");
  await git(b.session.worktree_path, ["add", "feat-b.txt"]);
  await git(b.session.worktree_path, ["commit", "-m", "feat b"]);
  const fakeGh = await installMultiBranchFakeGh(t, { repo, remote });
  const plan = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan" });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(typeof plan.confirmToken, "string");
  const invalidOrigin = path.join(base, "post-merge-fetch-failure.git");
  const postReceiveHook = `#!/bin/sh
while read -r _ _ ref; do
  if [ "$ref" = "refs/heads/main" ]; then
    unset GIT_DIR
    git -C "${repo}" remote set-url origin "${invalidOrigin}"
  fi
done
`;
  const hookPath = path.join(remote, "hooks", "post-receive");
  await fs.writeFile(hookPath, postReceiveHook);
  await fs.chmod(hookPath, 0o755);
  const apply = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "apply", confirm: true, confirmToken: plan.confirmToken, timestamp: "20260727T010101" });
  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(apply.status, "blocked");
  assert.match(String(apply.reason), /failed child base observation/);
  const results = Array.isArray(apply.results) ? apply.results : [];
  assert.equal(results.length, 1);
  const result = results[0];
  assert.equal(result && typeof result === "object" && "session_id" in result ? result.session_id : undefined, a.session.session_id);
  await git(remote, ["merge-base", "--is-ancestor", aHead, "main"]);
  assert.equal(await pathExists(b.session.worktree_path), true);
  assert.equal(await branchExists(repo, b.session.branch), true);
  const ghLog = await fs.readFile(fakeGh.logPath, "utf8");
  assert.equal(ghLog.includes(a.session.branch), true);
  assert.equal(ghLog.includes(b.session.branch), false);
});

test("guardian_done all=true plans every active feature session", async (t) => {
  const { base, repo } = await createRepoWithOrigin(); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const a = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_all_a", taskName: "all a", createWorktree: true, config: DEFAULT_CONFIG }); const b = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_all_b", taskName: "all b", createWorktree: true, config: DEFAULT_CONFIG });
  for (const [session, file, content, message] of [[a, "feat-a.txt", "a\n", "feat a"], [b, "feat-b.txt", "b\n", "feat b"]] as const) { await fs.writeFile(path.join(session.session.worktree_path, file), content); await git(session.session.worktree_path, ["add", file]); await git(session.session.worktree_path, ["commit", "-m", message]); }
  const result = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan" }) as Record<string, unknown>; const summary = result.summary as Record<string, unknown>;
  assert.equal(result.ok, true); assert.equal(result.lane, "done-all"); assert.equal(result.status, "planned"); assert.equal(summary.total, 2); assert.equal(summary.finishable, 2); assert.equal(summary.dirtySkipped, 0); assert.equal(typeof result.confirmToken, "string"); assert.match(result.nextAction as string, /all=true mode=apply confirm=true/);
});

test("guardian_done all=true classifies dirty sessions as skipped", async (t) => {
  const { base, repo } = await createRepoWithOrigin(); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const a = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_all_clean", taskName: "clean", createWorktree: true, config: DEFAULT_CONFIG }); const b = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_all_dirty", taskName: "dirty", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(a.session.worktree_path, "feat-a.txt"), "a\n"); await git(a.session.worktree_path, ["add", "feat-a.txt"]); await git(a.session.worktree_path, ["commit", "-m", "feat a"]); await fs.writeFile(path.join(b.session.worktree_path, "uncommitted.txt"), "dirty\n");
  const result = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan" }) as Record<string, unknown>; const summary = result.summary as Record<string, unknown>; const remaining = result.remaining as Record<string, unknown>[];
  assert.equal(summary.finishable, 1); assert.equal(summary.dirtySkipped, 1); assert.equal(remaining.length, 1); assert.equal(remaining[0].branch, b.session.branch); assert.equal(remaining[0].disposition, "dirty-skipped");
});

test("guardian_finish_workflow skipFinalPostflight skips plan-mode final postflight blockers", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "rescue/workflow-skip-plan-postflight";
  await createMergedBranch(repo, branch, "workflow-skip-plan-postflight.txt");

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", skipFinalPostflight: true }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.status, "planned");
  assert.equal(plan.candidates.length, 0);
  assert.deepEqual(plan.remaining, []);
  assert.equal(plan.finalPostflight?.status, "skipped");
  assert.equal(await branchExists(repo, branch), true);
});

test("guardian_finish_workflow cleans configured-prefix local branches with ancestry proof", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "agent/workflow-custom-prefix";
  const head = await createMergedBranch(repo, branch, "workflow-custom-prefix.txt");
  const config = { ...DEFAULT_CONFIG, branchPrefix: "agent/" };

  const unproven = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", config }));

  assert.equal(unproven.ok, true, JSON.stringify(unproven));
  assert.equal(unproven.status, "planned");
  assert.equal(unproven.candidates.length, 1);
  assert.equal(unproven.candidates[0].kind, "branch");
  assert.equal(unproven.candidates[0].targetKind, "merged-branch");
  assert.equal(unproven.candidates[0].branch, branch);
  assert.equal(unproven.candidates[0].head, head);
  assert.equal(await branchExists(repo, branch), true);

  await createSafetyRef(repo, { sessionId: "workflow-custom-prefix", branch, commit: head, timestamp: "20260610T080808" });
  const proven = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", config }));

  assert.equal(proven.ok, true, JSON.stringify(proven));
  assert.equal(proven.candidates.length, 1);
  assert.equal(proven.candidates[0].targetKind, "stale-branch");
});

test("guardian_finish_workflow ignores stale deleted remote tracking refs after prune", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-stale-remote-tracking";
  await createMergedBranch(repo, branch, "workflow-stale-remote-tracking.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["branch", "-d", branch]);
  await git(repo, ["fetch", "origin"]);
  assert.equal(await remoteBranchExists(repo, branch), true);
  await git(remote, ["update-ref", "-d", "refs/heads/" + branch]);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.candidates.some((candidate) => candidate.remoteBranch === branch), false);
});

test("guardian_done apply lands a staged rename of a tracked ignored stats file and cleans up", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "land-clean-tracked-ignored-rename-session";
  const commitMessage = "fix: rename tracked ignored stats";
  const oldStatsPath = path.join(repo, ".claude", "stats", "old.json");
  await fs.mkdir(path.dirname(oldStatsPath), { recursive: true });
  await fs.writeFile(oldStatsPath, "{\"commits\":[]}\n", "utf8");
  await git(repo, ["add", ".claude/stats/old.json"]);
  await git(repo, ["commit", "-m", "track guardian stats fixture"]);
  await fs.writeFile(path.join(repo, ".gitignore"), ".claude/\n", "utf8");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore guardian runtime state"]);
  await git(repo, ["push", "origin", "main"]);
  const started = await guardianStart({
    repoRoot: repo,
    cwd: repo,
    sessionId,
    taskName: "land staged tracked ignored rename",
    createWorktree: true,
    config: DEFAULT_CONFIG,
  });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");
  await git(worktree, ["mv", "--", ".claude/stats/old.json", ".claude/stats/new.json"]);
  await installFakeGh(t, { repo, branch, dynamicHead: true });

  // When
  const request = {
    repoRoot: repo,
    cwd: worktree,
    sessionId,
    commitMessage,
    timestamp: "2026-06-19T00:00:00.000Z",
    config: DEFAULT_CONFIG,
  };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");
  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });

  // Then
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "landed-and-cleaned");
  const commit = requireString(result.commit, "result.commit");
  await git(repo, ["fetch", "origin", "main"]);
  await git(repo, ["merge-base", "--is-ancestor", commit, "origin/main"]);
  await git(repo, ["cat-file", "-e", `${commit}:.claude/stats/new.json`]);
  await assert.rejects(git(repo, ["cat-file", "-e", `${commit}:.claude/stats/old.json`]));
  assert.equal(result.worktreeRemoved, true);
  assert.equal(result.branchDeleted, true);
  await assert.rejects(fs.access(worktree));
  await assert.rejects(git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]));
});
