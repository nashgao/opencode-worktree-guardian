import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { buildDirtySessionCommitCandidate, commitDirtySessionWork } from "../src/done-land-clean-commit.ts";
import { sessionLandCleanPreflight } from "../src/done-land-clean-consent.ts";
import { buildSafetyRef, createSafetyRef, promoteGitArtifactSandboxTree, runGitInArtifactSandbox, withGitArtifactSandbox } from "../src/git.ts";
import { getGuardianPaths, readState, updateState } from "../src/state.ts";
import { guardianStart } from "../src/tools.ts";
import { createRepo, createRepoWithOrigin, git } from "./helpers.ts";
import { installMultiBranchFakeGh } from "./workflow-test-support.ts";

type LooseRecord = Record<string, unknown>;
type WorktreeCommit = { readonly file: string; readonly content: string; readonly message: string };
type MergedWorktree = { readonly branch: string; readonly worktreeName: string; readonly fileName: string };

async function pathExists(target: string) {
  return fs.access(target).then(() => true, () => false);
}

async function commitInWorktree(worktree: string, commit: WorktreeCommit) {
  await fs.writeFile(path.join(worktree, commit.file), commit.content);
  await git(worktree, ["add", commit.file]);
  await git(worktree, ["commit", "-m", commit.message]);
}

async function createMergedGuardianWorktree(repo: string, worktree: MergedWorktree) {
  await git(repo, ["checkout", "-b", worktree.branch]);
  await fs.writeFile(path.join(repo, worktree.fileName), `${worktree.branch}\n`);
  await git(repo, ["add", worktree.fileName]);
  await git(repo, ["commit", "-m", `add ${worktree.fileName}`]);
  await git(repo, ["checkout", "main"]);
  await git(repo, ["merge", "--no-ff", worktree.branch, "-m", `merge ${worktree.branch}`]);
  await git(repo, ["push", "origin", "main"]);
  const worktreePath = path.join(repo, ".worktrees", path.basename(repo), worktree.worktreeName);
  await git(repo, ["worktree", "add", worktreePath, worktree.branch]);
  return { worktreePath };
}

async function prepareDirtyCommit(t: TestContext) {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const dirtyPath = "transaction.txt";
  await fs.writeFile(path.join(repo, dirtyPath), "transaction\n");
  const head = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  const candidate = await buildDirtySessionCommitCandidate(repo, [dirtyPath]);
  const indexPath = (await git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout;
  const sessionId = "commit-transaction";
  const safetyRef = buildSafetyRef(sessionId, "main", "20260727T000000");
  const confirmToken = "commit-transaction-confirm-token";
  await updateState(repo, DEFAULT_CONFIG, (state) => {
    state.sessions[sessionId] = {
      session_id: sessionId,
      status: "active",
      branch: "main",
      worktree_path: repo,
      head_commit: head,
      safety_refs: [safetyRef],
      dirty_commit_safety_ref_reservation: {
        session_id: sessionId,
        branch: "main",
        expected_head: head,
        safety_ref: safetyRef,
        confirm_token: confirmToken,
        reserved_at: "2026-07-27T00:00:00.000Z",
      },
    };
    return state;
  });
  return {
    repo,
    head,
    indexPath,
    context: { repoRoot: repo, cwd: repo, sessionId, config: DEFAULT_CONFIG, input: { timestamp: "20260727T000000", confirmToken } },
    preflight: { branch: "main", head, dirtyFiles: [dirtyPath], ...candidate, stashCount: 0, stashes: [], safetyRef },
  };
}

test("guardian_done all=true honors allowIgnoredFiles for stale Guardian cleanup", async (t) => {
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, ".gitignore"), "ignored-residue/\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "add ignored residue rule"]);
  await git(repo, ["push", "origin", "main"]);
  const staleBranch = "guardian/done-all-ignored-stale-worktree";
  const stale = await createMergedGuardianWorktree(repo, { branch: staleBranch, worktreeName: "done-all-ignored-stale-worktree", fileName: "done-all-ignored-stale-worktree.txt" });
  await fs.mkdir(path.join(stale.worktreePath, "ignored-residue"), { recursive: true });
  await fs.writeFile(path.join(stale.worktreePath, "ignored-residue", "cache.bin"), "ignored residue\n");
  const session = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_all_allow_ignored_cleanup", taskName: "allow ignored cleanup", createWorktree: true, config: DEFAULT_CONFIG });
  await commitInWorktree(session.session.worktree_path, { file: "feat-allow-ignored-cleanup.txt", content: "session work\n", message: "feat allow ignored cleanup" });
  await installMultiBranchFakeGh(t, { repo, remote });

  const request = { repoRoot: repo, cwd: repo, all: true, allowIgnoredFiles: true, timestamp: "20260610T121212" };
  const plan = await guardianDone({ ...request, mode: "plan" }) as LooseRecord;

  assert.equal(plan.ok, true, JSON.stringify(plan));
  const cleanupPlan = plan.cleanupPlan as LooseRecord;
  assert.equal((cleanupPlan.candidates as LooseRecord[]).some((candidate) => candidate.branch === staleBranch), true, JSON.stringify(cleanupPlan));
  assert.equal((cleanupPlan.blockers as LooseRecord[]).some((blocker) => blocker.branch === staleBranch), false, JSON.stringify(cleanupPlan));

  const apply = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: plan.confirmToken }) as LooseRecord;

  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.equal(apply.status, "finished");
  const cleanupSweep = apply.cleanupSweep as LooseRecord;
  assert.equal(cleanupSweep.cleanedCount, 2);
  assert.equal((cleanupSweep.preSession as LooseRecord).cleanedCount, 1);
  assert.equal((cleanupSweep.postSession as LooseRecord).cleanedCount, 1);
  assert.equal(await pathExists(stale.worktreePath), false);
  await assert.rejects(git(repo, ["rev-parse", "--verify", staleBranch]));
});

test("commit transaction preserves a pre-existing foreign index lock", async (t) => {
  const fixture = await prepareDirtyCommit(t);
  const lockPath = `${fixture.indexPath}.lock`;
  await fs.writeFile(lockPath, "foreign lock\n");

  const result = await commitDirtySessionWork(fixture.context, fixture.preflight, "fix: transaction");

  if (result.ok) assert.fail("foreign index lock must block the transaction");
  assert.equal(result.result.status, "blocked");
  assert.equal(await fs.readFile(lockPath, "utf8"), "foreign lock\n");
  assert.equal((await git(fixture.repo, ["rev-parse", "HEAD"])).stdout, fixture.head);
});

test("artifact promotion installs only the approved candidate-tree closure", async (t) => {
  // Given
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const approvedPath = "approved.txt"; const unrelatedPath = "unrelated.txt";
  await fs.writeFile(path.join(repo, approvedPath), "approved\n", "utf8");
  await fs.writeFile(path.join(repo, unrelatedPath), "unrelated sandbox object\n", "utf8");
  let candidateTree = ""; let unrelatedObject = "";

  // When
  await withGitArtifactSandbox(repo, async (sandbox) => {
    candidateTree = (await runGitInArtifactSandbox(repo, ["write-tree"], sandbox)).stdout;
    await runGitInArtifactSandbox(repo, ["add", "--", approvedPath], sandbox);
    candidateTree = (await runGitInArtifactSandbox(repo, ["write-tree"], sandbox)).stdout;
    unrelatedObject = (await runGitInArtifactSandbox(repo, ["hash-object", "-w", "--", unrelatedPath], sandbox)).stdout;
    await promoteGitArtifactSandboxTree(repo, sandbox, candidateTree);
  });

  // Then
  await git(repo, ["cat-file", "-e", `${candidateTree}^{tree}`]);
  await assert.rejects(git(repo, ["cat-file", "-e", `${unrelatedObject}^{blob}`]));
});

test("locked-index drift blocks before safety-ref reservation or publication", async (t) => {
  // Given
  const fixture = await prepareDirtyCommit(t);
  await fs.writeFile(path.join(fixture.repo, "index-drift.txt"), "drift\n", "utf8");
  await git(fixture.repo, ["add", "index-drift.txt"]);

  // When
  const result = await commitDirtySessionWork(fixture.context, fixture.preflight, "fix: transaction");

  // Then
  if (result.ok) assert.fail("locked-index drift must block the transaction");
  assert.equal(result.result.status, "blocked");
  await assert.rejects(git(fixture.repo, ["rev-parse", "--verify", fixture.preflight.safetyRef]));
  assert.equal((await git(fixture.repo, ["rev-parse", "HEAD"])).stdout, fixture.head);
});

test("commit transaction leaves a foreign lock created after index installation untouched", async (t) => {
  const fixture = await prepareDirtyCommit(t);
  const lockPath = `${fixture.indexPath}.lock`;

  const result = await commitDirtySessionWork(fixture.context, fixture.preflight, "fix: transaction", {
    afterIndexInstall: async ({ indexLockPath }: { readonly indexLockPath: string }) => fs.writeFile(indexLockPath, "foreign lock\n"),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(await fs.readFile(lockPath, "utf8"), "foreign lock\n");
});

test("commit transaction atomically blocks publication when a reused safety ref changes before branch CAS", async (t) => {
  // Given
  const fixture = await prepareDirtyCommit(t);
  const safetyRef = fixture.preflight.safetyRef;
  await createSafetyRef(fixture.repo, { sessionId: fixture.context.sessionId, branch: fixture.preflight.branch, commit: fixture.head, ref: safetyRef });
  const otherHead = (await git(fixture.repo, ["commit-tree", `${fixture.head}^{tree}`, "-p", fixture.head, "-m", "retarget safety ref"])).stdout;
  const sourceIndexTree = (await git(fixture.repo, ["write-tree"])).stdout;

  // When
  const result = await commitDirtySessionWork(fixture.context, fixture.preflight, "fix: transaction", {
    beforeBranchPublication: async () => { await git(fixture.repo, ["update-ref", safetyRef, otherHead, fixture.head]); },
  });

  // Then
  if (result.ok) assert.fail("retargeted reused safety ref must block publication");
  assert.equal(result.result.status, "blocked");
  assert.equal((await git(fixture.repo, ["rev-parse", "HEAD"])).stdout, fixture.head);
  assert.equal((await git(fixture.repo, ["write-tree"])).stdout, sourceIndexTree);
  assert.equal((await git(fixture.repo, ["rev-parse", safetyRef])).stdout, otherHead);
});

test("land-clean preflight blocks a pre-existing symbolic session branch", async (t) => {
  const fixture = await prepareDirtyCommit(t);
  const protectedBranch = "protected";
  await git(fixture.repo, ["branch", protectedBranch, fixture.head]);
  await git(fixture.repo, ["symbolic-ref", "refs/heads/main", `refs/heads/${protectedBranch}`]);
  const paths = await getGuardianPaths(fixture.repo);
  const session = (await readState(paths, { repoRoot: fixture.repo, config: DEFAULT_CONFIG })).sessions[fixture.context.sessionId];
  if (!session) throw new Error("commit session must remain in state");

  const result = await sessionLandCleanPreflight({ ...fixture.context, input: {}, session });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.match(String(result.reason), /session branch.*symbolic/i);
  assert.equal((await git(fixture.repo, ["symbolic-ref", "--no-recurse", "refs/heads/main"])).stdout, `refs/heads/${protectedBranch}`);
  assert.equal((await git(fixture.repo, ["rev-parse", `refs/heads/${protectedBranch}`])).stdout, fixture.head);
});

test("commit transaction replaces a racing symbolic session branch without mutating its protected referent", async (t) => {
  const fixture = await prepareDirtyCommit(t);
  const protectedBranch = "protected";
  await git(fixture.repo, ["branch", protectedBranch, fixture.head]);

  const result = await commitDirtySessionWork(fixture.context, fixture.preflight, "fix: transaction", {
    beforeBranchPublication: async () => {
      await git(fixture.repo, ["symbolic-ref", "refs/heads/main", `refs/heads/${protectedBranch}`]);
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) assert.fail("the branch publication should replace only the racing symbolic ref");
  assert.equal((await git(fixture.repo, ["rev-parse", "refs/heads/main"])).stdout, result.head);
  assert.equal((await git(fixture.repo, ["rev-parse", `refs/heads/${protectedBranch}`])).stdout, fixture.head);
});

test("commit transaction CAS-rolls back a branch when index installation fails after publication", async (t) => {
  const fixture = await prepareDirtyCommit(t);

  const result = await commitDirtySessionWork(fixture.context, fixture.preflight, "fix: transaction", {
    afterBranchUpdate: async ({ indexLockPath }: { readonly indexLockPath: string }) => fs.rm(indexLockPath),
  });

  if (result.ok) assert.fail("post-publication index failure must not report success");
  assert.equal(result.result.status, "blocked");
  assert.equal(result.result.rollback, "restored");
  assert.equal((await git(fixture.repo, ["rev-parse", "HEAD"])).stdout, fixture.head);
});

test("commit transaction preserves recovery state when completion persistence fails after index installation", async (t) => {
  const fixture = await prepareDirtyCommit(t);
  const paths = await getGuardianPaths(fixture.repo);

  const result = await commitDirtySessionWork(fixture.context, fixture.preflight, "fix: transaction", {
    afterBranchUpdate: async () => {
      await fs.rm(paths.eventsPath, { force: true });
      await fs.writeFile(`${paths.eventsPath}.target`, "", "utf8");
      await fs.symlink(`${paths.eventsPath}.target`, paths.eventsPath);
    },
  });

  if (result.ok) assert.fail("completion persistence failure must not report success");
  assert.equal(result.result.status, "partial");
  assert.equal(result.result.transactionPhase, "index-installed");
  assert.equal(result.result.rollback, "not-attempted");
  assert.equal((await git(fixture.repo, ["rev-parse", "HEAD"])).stdout, result.result.newHead);
  assert.equal((await git(fixture.repo, ["write-tree"])).stdout, fixture.preflight.candidateTree);
  const session = (await readState(paths, { repoRoot: fixture.repo, config: DEFAULT_CONFIG })).sessions[fixture.context.sessionId];
  if (!session) throw new Error("commit session must remain in state");
  assert.equal(session.head_commit, fixture.head);
  const reservation = session.dirty_commit_safety_ref_reservation;
  if (!reservation) throw new Error("matching reservation must remain after completion persistence failure");
  assert.equal(reservation.session_id, fixture.context.sessionId);
  assert.equal(reservation.branch, fixture.preflight.branch);
  assert.equal(reservation.expected_head, fixture.head);
  assert.equal(reservation.safety_ref, fixture.preflight.safetyRef);
  assert.equal(reservation.confirm_token, fixture.context.input.confirmToken);
});

test("commit transaction reports partial recovery facts when branch rollback conflicts", async (t) => {
  const fixture = await prepareDirtyCommit(t);
  let advancedHead = "";

  const result = await commitDirtySessionWork(fixture.context, fixture.preflight, "fix: transaction", {
    afterBranchUpdate: async ({ indexLockPath, newHead }: { readonly indexLockPath: string; readonly newHead: string }) => {
      const tree = (await git(fixture.repo, ["rev-parse", `${newHead}^{tree}`])).stdout;
      advancedHead = (await git(fixture.repo, ["commit-tree", tree, "-p", newHead, "-m", "advance branch"])).stdout;
      await git(fixture.repo, ["update-ref", "refs/heads/main", advancedHead, newHead]);
      await fs.rm(indexLockPath);
    },
  });

  if (result.ok) assert.fail("rollback conflict must not report success");
  assert.equal(result.result.status, "partial");
  assert.equal(result.result.oldHead, fixture.head);
  assert.equal(result.result.currentHead, advancedHead);
  assert.equal(typeof result.result.newHead, "string");
  assert.equal(typeof result.result.safetyRef, "string");
  assert.equal((await git(fixture.repo, ["rev-parse", "HEAD"])).stdout, advancedHead);
});
