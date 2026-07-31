import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { guardianFinish } from "../src/finish.ts";
import { scanWorkspaceHygiene } from "../src/hygiene.ts";
import { guardianRecover, guardianStatus } from "../src/recover.ts";
import { updateState } from "../src/state.ts";
import { guardianStart, runGuardianTool } from "../src/tools.ts";
import { createRepo, createRepoWithOrigin, git } from "./helpers.ts";

async function writeArtifact(repo: string, relative: string) {
  const target = path.join(repo, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "artifact\n");
}

function recordField(record: Record<string, unknown>, key: string) {
  return record[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pathsFromRecords(records: unknown) {
  if (!Array.isArray(records)) {
    throw new TypeError("expected records array");
  }
  return records.map((entry) => {
    if (!isRecord(entry)) {
      throw new TypeError("expected record entry");
    }
    return entry.path;
  }).sort();
}

function hasFatalBlocker(records: unknown, predicate: (entry: Record<string, unknown>) => boolean) {
  if (!Array.isArray(records)) {
    throw new TypeError("expected blocker records array");
  }
  return records.some((entry) => {
    if (!isRecord(entry)) {
      throw new TypeError("expected blocker record entry");
    }
    return entry.fatal === true && predicate(entry);
  });
}

type DoneResult = Record<string, unknown> & {
  readonly branch?: string;
  readonly commit?: string;
  readonly lane?: string;
  readonly localUntrackedFileCount?: number;
  readonly safetyRef?: string;
  readonly status?: string;
};

function asDone(result: Record<string, unknown>): DoneResult {
  return result as DoneResult;
}

test("guardian_status excludes the primary checkout from worktrees without state through path aliases", { skip: process.platform === "win32" }, async () => {
  const repo = await createRepo();
  const repoAlias = path.join(path.dirname(repo), `${path.basename(repo)}-alias`);
  await fs.symlink(repo, repoAlias, "dir");

  const status = await guardianStatus({ repoRoot: repoAlias, config: DEFAULT_CONFIG });

  assert.deepEqual(status.worktreesWithoutState, []);
});

test("guardian status and recover classify a primary-worktree alias as poisoned", { skip: process.platform === "win32" }, async () => {
  const repo = await createRepo();
  const primaryAlias = path.join(path.dirname(repo), `${path.basename(repo)}-primary-alias`);
  await fs.symlink(repo, primaryAlias, "dir");
  await updateState(repo, DEFAULT_CONFIG, (state) => {
    state.sessions.ses_primary_alias = {
      session_id: "ses_primary_alias",
      status: "active",
      branch: "guardian/primary-alias",
      worktree_path: primaryAlias,
      base_ref: "origin/main",
      safety_refs: [],
    };
    return state;
  });

  const [status, recover] = await Promise.all([
    guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG }),
    guardianRecover({ repoRoot: repo, config: DEFAULT_CONFIG }),
  ]);

  assert.equal(status.poisonedSessions.some((session) => session.session_id === "ses_primary_alias"), true);
  assert.equal(recover.poisonedSessions.some((session) => session.session_id === "ses_primary_alias"), true);
});

test("hygiene scanner exposes reviewable scan inventory separately from cleanup findings", async () => {
  const repo = await createRepo();
  await fs.writeFile(path.join(repo, ".gitignore"), "*.log\nlogs/\nnode_modules/\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "add hygiene fixture ignores"]);
  await writeArtifact(repo, ".omo/run-continuation/session.json");
  await writeArtifact(repo, "node_modules/pkg/index.js");
  await writeArtifact(repo, "logs/run.log");
  await writeArtifact(repo, "plain.log");
  for (const relative of ["aaa.txt", "bbb.txt", "ccc.txt", "ddd.txt", "eee.txt", "fff.txt", "ggg.txt", "hhh.txt", "iii.txt", "jjj.txt", "yyy.txt", "zzz.txt"]) {
    await writeArtifact(repo, relative);
  }

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.deepEqual(pathsFromRecords(result.findings), []);
  assert.deepEqual(pathsFromRecords(result.exclusions), [".omo", "node_modules"]);
  assert.deepEqual(
    { summary: { candidateCount: result.summary.candidateCount, findingCount: result.summary.findingCount, exclusionCount: result.summary.exclusionCount, reviewableCandidateCount: recordField(result.summary, "reviewableCandidateCount"), reviewableShownCount: recordField(result.summary, "reviewableShownCount"), reviewableOmittedCount: recordField(result.summary, "reviewableOmittedCount"), reviewableTruncated: recordField(result.summary, "reviewableTruncated") }, reviewableCandidates: recordField(result, "reviewableCandidates") },
    { summary: { candidateCount: 16, findingCount: 0, exclusionCount: 2, reviewableCandidateCount: 14, reviewableShownCount: 12, reviewableOmittedCount: 2, reviewableTruncated: true }, reviewableCandidates: [
      { path: "aaa.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["aaa.txt"]' }, { path: "bbb.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["bbb.txt"]' }, { path: "ccc.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["ccc.txt"]' }, { path: "ddd.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["ddd.txt"]' }, { path: "eee.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["eee.txt"]' }, { path: "fff.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["fff.txt"]' }, { path: "ggg.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["ggg.txt"]' }, { path: "hhh.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["hhh.txt"]' }, { path: "iii.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["iii.txt"]' }, { path: "jjj.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["jjj.txt"]' }, { path: "logs", status: "ignored", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["logs"] allowRecursive=true' }, { path: "plain.log", status: "ignored", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["plain.log"]' },
    ] },
  );
});

test("guardian_status includes hygiene metadata without changing dirty files", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "librarian-status/file.txt");

  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(Array.isArray(status.dirtyFiles), true);
  assert.equal(status.dirtyFiles.some((entry: string) => entry.startsWith("librarian-status")), true);
  assert.equal(status.hygiene.ok, true);
  assert.ok(status.hygiene.summary);
  assert.equal(status.hygiene.summary.findingCount, 1);
  assert.equal(status.hygiene.findings[0].path, "librarian-status");
});

test("hygiene cleanup preflight blocks reviewable scan-only candidates", async () => {
  const repo = await createRepo();
  await fs.writeFile(path.join(repo, ".gitignore"), "*.log\nlogs/\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "add reviewable fixture ignores"]);
  await writeArtifact(repo, "librarian-reviewable-clean/file.txt");
  await writeArtifact(repo, "plain.log");
  await writeArtifact(repo, "logs/run.log");

  const defaultPlan = await runGuardianTool("guardian_hygiene", { repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan" });
  assert.equal(defaultPlan.ok, true);
  assert.equal(defaultPlan.status, "planned");
  assert.equal(typeof defaultPlan.confirmToken, "string");
  assert.deepEqual(pathsFromRecords(defaultPlan.targets), ["librarian-reviewable-clean"]);
  assert.equal(pathsFromRecords(defaultPlan.targets).includes("plain.log"), false);
  assert.equal(pathsFromRecords(defaultPlan.targets).includes("logs"), false);
  assert.equal(recordField(defaultPlan, "reviewableCandidates"), undefined);

  const explicitReviewable = await runGuardianTool("guardian_hygiene", { repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", cleanupPaths: ["plain.log"] });
  assert.equal(explicitReviewable.ok, false);
  assert.equal(explicitReviewable.status, "blocked");
  assert.equal(explicitReviewable.confirmToken, undefined);
  assert.deepEqual(pathsFromRecords(explicitReviewable.targets), []);
  assert.equal(hasFatalBlocker(explicitReviewable.blockers, (blocker) => blocker.path === "plain.log" && /not a current guardian_hygiene finding/.test(String(blocker.reason))), true);

  const unsupportedCategory = await runGuardianTool("guardian_hygiene", { repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", allowCategories: ["reviewable"] });
  assert.equal(unsupportedCategory.ok, false);
  assert.equal(unsupportedCategory.status, "blocked");
  assert.equal(unsupportedCategory.confirmToken, undefined);
  assert.deepEqual(pathsFromRecords(unsupportedCategory.targets), []);
  assert.equal(hasFatalBlocker(unsupportedCategory.blockers, (blocker) => blocker.category === "reviewable" && /unsupported allowCategories entry: reviewable/.test(String(blocker.reason))), true);

  const selectedPlan = await runGuardianTool("guardian_hygiene", { repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", cleanupPaths: ["librarian-reviewable-clean"] });
  await fs.writeFile(path.join(repo, "plain.log"), "changed reviewable file\n");
  await writeArtifact(repo, "logs/other.log");
  const afterReviewableChange = await runGuardianTool("guardian_hygiene", { repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", cleanupPaths: ["librarian-reviewable-clean"] });

  assert.equal(selectedPlan.ok, true);
  assert.equal(afterReviewableChange.ok, true);
  assert.equal(typeof selectedPlan.confirmToken, "string");
  assert.equal(afterReviewableChange.confirmToken, selectedPlan.confirmToken);
  assert.deepEqual(pathsFromRecords(afterReviewableChange.targets), ["librarian-reviewable-clean"]);
});

test("guardian_done is a no-op after the session was already preserved", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_preserved", taskName: "done preserved", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  await fs.writeFile(path.join(worktree, "feature.txt"), "feature\n");
  await git(worktree, ["add", "feature.txt"]);
  await git(worktree, ["commit", "-m", "complete feature"]);
  const finished = await guardianFinish({ repoRoot: repo, cwd: worktree, sessionId: "ses_done_preserved", finishMode: "preserve-only", config: DEFAULT_CONFIG });
  assert.equal(finished.status, "preserved");
  const { stdout: head } = await git(worktree, ["rev-parse", "HEAD"]);

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: worktree }));

  assert.equal(result.ok, true);
  assert.equal(result.status, "no-op");
  assert.equal(result.lane, "already-preserved");
  assert.equal(result.branch, started.session.branch);
  assert.equal(result.commit, head);
  assert.equal(result.safetyRef, finished.safetyRef);
  assert.match(String(result.safetyRef), /^refs\/opencode-guardian\//);
});

test("guardian_done no-op keeps user-kept untracked notes without implying the preserved commit is unsafe", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_preserved_notes", taskName: "done preserved notes", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  await fs.writeFile(path.join(worktree, "feature.txt"), "feature\n");
  await git(worktree, ["add", "feature.txt"]);
  await git(worktree, ["commit", "-m", "complete feature"]);
  const finished = await guardianFinish({ repoRoot: repo, cwd: worktree, sessionId: "ses_done_preserved_notes", finishMode: "preserve-only", config: DEFAULT_CONFIG });
  assert.equal(finished.status, "preserved");
  await fs.mkdir(path.join(worktree, ".omo"), { recursive: true });
  await fs.writeFile(path.join(worktree, ".omo", "notepad.md"), "kept notes\n");
  await fs.writeFile(path.join(worktree, ".omo", "plan.md"), "kept plan\n");

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: worktree, sessionId: "ses_done_preserved_notes" }));

  assert.equal(result.ok, true);
  assert.equal(result.status, "no-op");
  assert.equal(result.lane, "already-preserved");
  assert.equal(result.safetyRef, finished.safetyRef);
  assert.equal(result.localUntrackedFileCount, 2);
});
