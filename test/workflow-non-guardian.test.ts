import {
  assert,
  branchExists,
  createMergedBranch,
  createRepoWithOrigin,
  createUnmergedBranch,
  deleteRemoteBranch,
  fs,
  git,
  guardianFinishWorkflow,
  path,
  remoteBranchExists,
  test,
  workflowResult,
} from "./workflow-test-support.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDoneAll } from "../src/done-all.ts";
import { sessionLandCleanPreflight } from "../src/done-land-clean-consent.ts";
import { resolveRemoteAuthority } from "../src/git-authority.ts";
import { guardianStart } from "../src/start.ts";
import type { GuardianConfig } from "../src/types.ts";
import { createGuardianWorktree } from "./delete-fixtures.ts";
import { createTempDir } from "./helpers.ts";

const execFileAsync = promisify(execFile);

test("guardian_finish_workflow cleans merged non-Guardian local and remote branches", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "feat/workflow-non-guardian";
  const head = await createMergedBranch(repo, branch, "workflow-non-guardian.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["fetch", "origin"]);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.status, "planned");
  assert.equal(plan.candidates.length, 2);
  assert.deepEqual(plan.candidates.map((candidate) => candidate.targetKind).sort(), ["merged-branch", "remote-branch"]);
  assert.equal(plan.candidates.some((candidate) => candidate.branch === branch && candidate.head === head), true);
  assert.equal(plan.blockers.length, 0);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken }));

  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.equal(await branchExists(repo, branch), false);
  assert.equal(await remoteBranchExists(repo, branch), false);
});

test("guardian_finish_workflow excludes unmerged non-Guardian local branches", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "feat/workflow-non-guardian-unmerged";
  await createUnmergedBranch(repo, branch, "workflow-non-guardian-unmerged.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["fetch", "origin"]);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", abandonUnmerged: true }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.candidates.some((candidate) => candidate.branch === branch), false);
  assert.equal(await branchExists(repo, branch), true);
  assert.equal(await remoteBranchExists(repo, branch), true);
});

test("guardian_finish_workflow preserves merged non-Guardian rescue remote branches", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "rescue/workflow-non-guardian-remote-rescue";
  await createMergedBranch(repo, branch, "workflow-non-guardian-remote-rescue.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["branch", "-d", branch]);
  await git(repo, ["fetch", "origin"]);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.candidates.some((candidate) => candidate.remoteBranch === branch), false);
  assert.equal(await remoteBranchExists(repo, branch), true);
});

test("deleteRemoteBranch blocks when remote branch advanced after discovery", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-remote-lease";
  const oldHead = await createMergedBranch(repo, branch, "workflow-remote-lease.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["checkout", branch]);
  await fs.writeFile(path.join(repo, "workflow-remote-lease-advanced.txt"), "advanced\n");
  await git(repo, ["add", "workflow-remote-lease-advanced.txt"]);
  await git(repo, ["commit", "-m", "advance workflow remote lease"]);
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["checkout", "main"]);

  await assert.rejects(() => deleteRemoteBranch(repo, "origin", branch, oldHead));
  assert.equal(await remoteBranchExists(repo, branch), true);
});

test("workflow candidate discovery ignores a local origin/main shadow", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "authority-workflow", taskName: "authority workflow", createWorktree: true, config: DEFAULT_CONFIG });
  assert.equal(started.ok, true, JSON.stringify(started));
  await fs.writeFile(path.join(started.session.worktree_path, "workflow.txt"), "workflow\n");
  await git(started.session.worktree_path, ["add", "workflow.txt"]);
  await git(started.session.worktree_path, ["commit", "-m", "workflow authority"]);
  const head = (await git(started.session.worktree_path, ["rev-parse", "HEAD"])).stdout;
  await git(repo, ["update-ref", "refs/heads/origin/main", head]);

  const result = await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", config: DEFAULT_CONFIG });
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  const blockers = Array.isArray(result.blockers) ? result.blockers : [];

  assert.equal(candidates.length, 0, JSON.stringify(result));
  assert.equal(blockers.some((blocker) => typeof blocker === "object" && blocker !== null && "branch" in blocker && blocker.branch === started.session.branch), true, JSON.stringify(result));
});

test("workflow blocks overlapping trusted remote namespaces before fetching the base", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const result = await guardianFinishWorkflow({
    repoRoot: repo,
    cwd: repo,
    mode: "plan",
    config: { ...DEFAULT_CONFIG, trustedUpstreamRemotes: ["origin/main"] },
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(String(result.error), /remote namespaces overlap/);
});

test("remote authority rejects overlapping trusted remote namespaces while preserving distinct slash remotes", () => {
  assert.throws(
    () => resolveRemoteAuthority("origin/main/release", { remote: "origin", trustedUpstreamRemotes: ["origin/main"] }),
    { message: "Trusted upstream remote namespaces overlap: origin and origin/main" },
  );

  const authority = resolveRemoteAuthority("trusted/team/release/nested", { remote: "origin", trustedUpstreamRemotes: ["trusted/team"] });
  assert.deepEqual(authority, {
    remote: "trusted/team",
    branch: "release/nested",
    displayRef: "trusted/team/release/nested",
    authorityRef: "refs/remotes/trusted/team/release/nested",
  });
});

async function withFetchMarker<T>(marker: string, action: () => Promise<T>): Promise<T> {
  const tools = await createTempDir("guardian-fetch-marker-");
  const realGit = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
  await fs.writeFile(path.join(tools, "git"), `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = fetch ]; then : > ${JSON.stringify(marker)}; fi\ndone\nexec ${JSON.stringify(realGit)} "$@"\n`);
  await fs.chmod(path.join(tools, "git"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${tools}${path.delimiter}${originalPath ?? ""}`;
  try {
    return await action();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await fs.rm(tools, { recursive: true, force: true });
  }
}

test("session land-clean blocks a malformed base branch before fetch", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await createGuardianWorktree(repo, "final-review-session-base");
  const marker = path.join(base, "session-fetch-ran");
  const config = { ...DEFAULT_CONFIG, baseBranch: "main..malformed" } satisfies GuardianConfig;
  const result = await withFetchMarker(marker, () => sessionLandCleanPreflight({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: started.session.session_id, input: {}, session: started.session, config }));
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /base|ref/i);
  await assert.rejects(fs.access(marker));
});

test("done-all blocks a malformed base branch before fetch", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const marker = path.join(base, "done-all-fetch-ran");
  const config = { ...DEFAULT_CONFIG, baseBranch: "main..malformed" } satisfies GuardianConfig;
  const result = await withFetchMarker(marker, () => guardianDoneAll({ repoRoot: repo, cwd: repo, mode: "plan", config }));
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /base|ref/i);
  await assert.rejects(fs.access(marker));
});

test("guardian_finish_workflow scan skipped for invalid mode without completed candidate evidence", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "preview" }));
  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.lane, "finish-workflow");
  assert.equal(plan.remoteRefresh, "skipped");
  assert.equal(plan.preflight.candidateScanStatus, "skipped");
  assert.equal(plan.preflight.candidateScanSkippedReason, "invalid-mode");
});

test("guardian_finish_workflow scan skipped for base-unavailable without completed candidate evidence", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await git(repo, ["branch", "--unset-upstream", "main"]);
  const config = { ...DEFAULT_CONFIG, remote: "missing-origin" };
  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", config }));
  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.equal(plan.preflight.candidateScanStatus, "skipped");
  assert.equal(plan.preflight.candidateScanSkippedReason, "base-unavailable");
  assert.equal(plan.preflight.candidateCount, undefined);
  assert.equal(plan.preflight.maxCandidateCount, 25);
});

test("session land-clean blocks overlapping trusted remote namespaces before fetch", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await createGuardianWorktree(repo, "final-review-overlapping-session");
  const marker = path.join(base, "session-overlap-fetch-ran");
  const config = { ...DEFAULT_CONFIG, trustedUpstreamRemotes: ["origin/main"] } satisfies GuardianConfig;
  const result = await withFetchMarker(marker, () => sessionLandCleanPreflight({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: started.session.session_id, input: {}, session: started.session, config }));
  assert.equal(result.ok, false);
  assert.match(String(result.error), /remote namespaces overlap/);
  await assert.rejects(fs.access(marker));
});

test("done-all blocks overlapping trusted remote namespaces before fetch", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const marker = path.join(base, "done-all-overlap-fetch-ran");
  const config = { ...DEFAULT_CONFIG, trustedUpstreamRemotes: ["origin/main"] } satisfies GuardianConfig;
  const result = await withFetchMarker(marker, () => guardianDoneAll({ repoRoot: repo, cwd: repo, mode: "plan", config }));
  assert.equal(result.ok, false);
  assert.match(String(result.error), /remote namespaces overlap/);
  await assert.rejects(fs.access(marker));
});

test("session land-clean ignores a local origin/main shadow", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await createGuardianWorktree(repo, "final-review-origin-shadow");
  const remoteBase = (await git(repo, ["rev-parse", "refs/remotes/origin/main"])).stdout;
  const tree = (await git(repo, ["rev-parse", "HEAD^{tree}"])).stdout;
  const shadow = (await git(repo, ["commit-tree", tree, "-m", "local origin main shadow"])).stdout;
  await git(repo, ["update-ref", "refs/heads/origin/main", shadow]);
  const result = await sessionLandCleanPreflight({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: started.session.session_id, input: {}, session: started.session, config: DEFAULT_CONFIG });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) assert.equal(result.baseRefOid, remoteBase);
});

test("session land-clean qualifies slash remote and nested branch authorities", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const remoteName = "trusted/team";
  const baseBranch = "release/nested";
  const featureBranch = "guardian/final/review";
  await git(repo, ["remote", "add", remoteName, remote]);
  await git(repo, ["push", remoteName, `main:refs/heads/${baseBranch}`]);
  await git(repo, ["push", remoteName, `main:refs/heads/${featureBranch}`]);
  const started = await createGuardianWorktree(repo, "final-review-slash-remote", "slash remote", featureBranch);
  const remoteBase = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  const tree = (await git(repo, ["rev-parse", "HEAD^{tree}"])).stdout;
  const shadow = (await git(repo, ["commit-tree", tree, "-m", "nested authority shadow"])).stdout;
  await git(repo, ["update-ref", `refs/heads/${remoteName}/${baseBranch}`, shadow]);
  await git(repo, ["update-ref", `refs/heads/${remoteName}/${featureBranch}`, shadow]);
  const config = { ...DEFAULT_CONFIG, remote: remoteName, baseBranch, trustedUpstreamRemotes: [remoteName] } satisfies GuardianConfig;
  const result = await sessionLandCleanPreflight({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: started.session.session_id, input: {}, session: started.session, config });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.equal(result.baseRef, `${remoteName}/${baseBranch}`);
    assert.equal(result.baseRefOid, remoteBase);
    assert.equal(result.remoteBranchOid, remoteBase);
  }
});
