import path from "node:path";
import {
  assert,
  branchExists,
  createMergedBranch,
  createRepoWithOrigin,
  createSafetyRef,
  createUnmergedBranch,
  DEFAULT_CONFIG,
  fs,
  git,
  guardianFinishWorkflow,
  remoteBranchExists,
  test,
  workflowResult,
} from "./workflow-test-support.js";
import { createSessionLandCleanConfirmToken, deriveBatchExecutionToken } from "../src/done-land-clean-consent.ts";
import { guardianFinish } from "../src/finish.ts";
import { buildSafetyRef, createOrReuseSafetyRef, pushBranchWithLease } from "../src/git.ts";
import { guardianStart } from "../src/start.ts";

test("batch token replaces only the authorized base and rejects plan drift", () => {
  const input = { action: "land-and-clean", context: { input: {}, repoRoot: "/repo", sessionId: "session" }, preflight: { branch: "guardian/session", worktreePath: "/repo/.worktrees/session", head: "head", dirtyFiles: [], snapshot: { entries: [], paths: [], fingerprints: [] }, remote: "origin", baseBranch: "main", baseRef: "origin/main", baseRefOid: "next-base", remoteBranchOid: null, safetyRef: "refs/guardian/session", ignoredFiles: [], ignoredFileFingerprint: [], sourceIndexTree: "index", candidateTree: "candidate" }, commitMessage: "" } as const;
  const authorization = { kind: "done-all" as const, originalConfirmToken: createSessionLandCleanConfirmToken({ ...input, preflight: { ...input.preflight, baseRefOid: "original-base" } }), originalBaseRefOid: "original-base", authorizedBaseRefOid: "next-base" };
  assert.deepEqual(deriveBatchExecutionToken(input, authorization), { ok: true, token: createSessionLandCleanConfirmToken(input) });
  assert.deepEqual(deriveBatchExecutionToken({ ...input, preflight: { ...input.preflight, head: "drift" } }, authorization), { ok: false, code: "original-token-mismatch" });
  assert.deepEqual(deriveBatchExecutionToken({ ...input, preflight: { ...input.preflight, baseRefOid: "other-base" } }, authorization), { ok: false, code: "authorized-base-mismatch" });
  for (const preflight of [
    { ...input.preflight, remoteBranchOid: "remote-drift" },
    { ...input.preflight, candidateTree: "candidate-drift" },
    { ...input.preflight, ignoredFileFingerprint: [{ path: "ignored", kind: "file", size: 1, hash: "hash" }] },
  ] as const) assert.deepEqual(deriveBatchExecutionToken({ ...input, preflight }, authorization), { ok: false, code: "original-token-mismatch" });
});

test("guardian_finish_workflow plans cleanly when no cleanup candidates exist", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(typeof plan.confirmToken, "string");
  assert.equal(typeof plan.preflight.baseRefOid, "string");
  assert.equal(plan.preflight.candidateCount, 0);
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.blockers, []);
});

test("guardian_finish_workflow cleans merged remote Guardian branches", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-remote-merged";
  const rescueBranch = "rescue/workflow-remote-merged";
  const unmergedBranch = "guardian/workflow-remote-unmerged";
  const head = await createMergedBranch(repo, branch, "workflow-remote-merged.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["branch", "-d", branch]);
  await createMergedBranch(repo, rescueBranch, "workflow-rescue-merged.txt");
  await git(repo, ["push", "origin", rescueBranch]);
  await git(repo, ["branch", "-d", rescueBranch]);
  await createUnmergedBranch(repo, unmergedBranch, "workflow-remote-unmerged.txt");
  await git(repo, ["push", "origin", unmergedBranch]);
  await git(repo, ["branch", "-D", unmergedBranch]);
  await git(repo, ["fetch", "origin"]);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.status, "planned-partial");
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].kind, "remote-branch");
  assert.equal(plan.candidates[0].targetKind, "remote-branch");
  assert.equal(plan.candidates[0].remote, "origin");
  assert.equal(plan.candidates[0].remoteBranch, branch);
  assert.equal(plan.candidates[0].head, head);
  assert.equal(plan.remaining.some((entry) => entry.kind === "final-postflight"), true);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken }));

  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(apply.status, "partial");
  assert.equal(apply.results.length, 1);
  assert.equal(apply.results[0].remoteBranchDeleted, true);
  assert.equal(apply.remaining.some((entry) => entry.kind === "final-postflight"), true);
  assert.equal(await remoteBranchExists(repo, branch), false);
  assert.equal(await remoteBranchExists(repo, rescueBranch), true);
  assert.equal(await remoteBranchExists(repo, unmergedBranch), true);
});

test("guardian_finish_workflow cleans same-name local and remote Guardian branches with ancestry proof", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-same-name";
  const head = await createMergedBranch(repo, branch, "workflow-same-name.txt");
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

test("guardian_finish_workflow cleans unowned merged local Guardian branches with ancestry proof", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-unowned-merged-local";
  const head = await createMergedBranch(repo, branch, "workflow-unowned-merged-local.txt");

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.status, "planned");
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].kind, "branch");
  assert.equal(plan.candidates[0].targetKind, "merged-branch");
  assert.equal(plan.candidates[0].branch, branch);
  assert.equal(plan.candidates[0].head, head);
  assert.equal(plan.blockers.length, 0);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken }));

  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.equal(apply.results.length, 1);
  assert.equal(apply.results[0].branchDeleted, true);
  assert.equal(apply.results[0].worktreeRemoved, false);
  assert.equal(await branchExists(repo, branch), false);
});

test("guardian_finish_workflow cleans same-name local and remote Guardian branches when both are safe", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-same-name-owned";
  const head = await createMergedBranch(repo, branch, "workflow-same-name-owned.txt");
  await createSafetyRef(repo, { sessionId: "workflow-same-name-owned", branch, commit: head, timestamp: "20260610T070707" });
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["fetch", "origin"]);

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.candidates.length, 2);
  assert.deepEqual(plan.candidates.map((candidate) => candidate.targetKind).sort(), ["remote-branch", "stale-branch"]);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken }));

  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.equal(apply.results.length, 2);
  assert.equal(await branchExists(repo, branch), false);
  assert.equal(await remoteBranchExists(repo, branch), false);
});

test("guardian_finish_workflow preserves merged local rescue branches by default", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "rescue/workflow-local-rescue";
  await createMergedBranch(repo, branch, "workflow-local-rescue.txt");

  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan" }));

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.candidates.length, 0);
  assert.equal(await branchExists(repo, branch), true);
});

test("guardian_finish_workflow rejects remote cleanup timestamp drift", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-remote-timestamp";
  await createMergedBranch(repo, branch, "workflow-remote-timestamp.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["branch", "-d", branch]);
  await git(repo, ["fetch", "origin"]);
  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", timestamp: "20260727T050505" }));

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken, timestamp: "20260727T060606" }));

  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.match(String(apply.reason), /confirm token mismatch/);
  assert.equal(await remoteBranchExists(repo, branch), true);
});

test("guardian_finish_workflow preserves a colliding planned remote cleanup safety ref", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-remote-ref-collision";
  const head = await createMergedBranch(repo, branch, "workflow-remote-ref-collision.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["branch", "-d", branch]);
  await git(repo, ["fetch", "origin"]);
  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", timestamp: "20260727T070707" }));
  const safetyRef = plan.candidates[0].safetyRef;
  assert.equal(typeof safetyRef, "string");
  await git(repo, ["update-ref", String(safetyRef), head]);

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirmToken: plan.confirmToken, timestamp: "20260727T070707" }));

  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(await remoteBranchExists(repo, branch), true);
  assert.equal((await git(repo, ["rev-parse", String(safetyRef)])).stdout, head);
});

test("createOrReuseSafetyRef rejects a different-target collision", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const expectedCommit = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  const otherCommit = (await git(repo, ["commit-tree", `${expectedCommit}^{tree}`, "-p", expectedCommit, "-m", "different safety target"])).stdout;
  const timestamp = "20260728T121212";
  const ref = buildSafetyRef("retry-collision", "guardian/retry-collision", timestamp);
  await git(repo, ["update-ref", ref, otherCommit]);

  await assert.rejects(createOrReuseSafetyRef(repo, { sessionId: "retry-collision", branch: "guardian/retry-collision", commit: expectedCommit, timestamp }));

  assert.equal((await git(repo, ["rev-parse", ref])).stdout, otherCommit);
});

test("guardian_finish rejects an owned retry when its same-OID safety ref is symbolic", async (t) => {
  // Given
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_symbolic_safety_ref", taskName: "symbolic safety ref retry", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  const branch = started.session.branch;
  await fs.writeFile(path.join(worktree, "symbolic-safety-ref.txt"), "retry\n");
  await git(worktree, ["add", "symbolic-safety-ref.txt"]);
  await git(worktree, ["commit", "-m", "symbolic safety ref retry"]);
  const commit = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  const timestamp = "20260730T120000";
  await git(repo, ["remote", "set-url", "origin", path.join(base, "missing-origin")]);
  const initial = await guardianFinish({ repoRoot: repo, cwd: worktree, sessionId: started.session.session_id, timestamp });
  assert.equal(initial.ok, false, JSON.stringify(initial));
  if (typeof initial.safetyRef !== "string") throw new Error("blocked finish did not return a safety ref");
  const targetRef = "refs/heads/symbolic-safety-ref-target";
  await git(repo, ["update-ref", targetRef, commit]);
  await git(repo, ["symbolic-ref", initial.safetyRef, targetRef]);
  await git(repo, ["remote", "set-url", "origin", remote]);

  // When
  const retried = await guardianFinish({ repoRoot: repo, cwd: worktree, sessionId: started.session.session_id, timestamp });

  // Then
  assert.equal(retried.ok, false, JSON.stringify(retried));
  assert.equal(retried.status, "blocked");
  assert.equal(retried.reason, "safety ref creation failed");
  assert.equal((await git(repo, ["symbolic-ref", "--no-recurse", initial.safetyRef])).stdout, targetRef);
  assert.equal((await git(repo, ["rev-parse", targetRef])).stdout, commit);
  assert.equal((await git(repo, ["rev-parse", `refs/heads/${branch}`])).stdout, commit);
  await assert.rejects(() => git(remote, ["rev-parse", "--verify", `refs/heads/${branch}`]));
});

test("pushBranchWithLease publishes the approved object and rejects a stale remote head", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/exact-oid";
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, "approved.txt"), "approved\n");
  await git(repo, ["add", "approved.txt"]);
  await git(repo, ["commit", "-m", "approved"]);
  const approved = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  await fs.writeFile(path.join(repo, "later.txt"), "later\n");
  await git(repo, ["add", "later.txt"]);
  await git(repo, ["commit", "-m", "later"]);
  const later = (await git(repo, ["rev-parse", "HEAD"])).stdout;

  await pushBranchWithLease(repo, "origin", branch, approved, null);

  assert.equal((await git(remote, ["rev-parse", `refs/heads/${branch}`])).stdout, approved);
  const advanced = (await git(repo, ["commit-tree", `${approved}^{tree}`, "-p", approved, "-m", "advance remote"])).stdout;
  await git(repo, ["push", remote, `${advanced}:refs/heads/${branch}`]);

  await assert.rejects(pushBranchWithLease(repo, "origin", branch, later, approved));

  assert.equal((await git(remote, ["rev-parse", `refs/heads/${branch}`])).stdout, advanced);
});
