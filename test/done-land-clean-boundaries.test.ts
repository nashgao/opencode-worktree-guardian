import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { buildDirtySessionDoneIntent } from "../src/done-intent.ts";
import { guardianStart } from "../src/start.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepoWithOrigin, git, rescueMutationSurface } from "./helpers.ts";
import { installFakeGh } from "./delete-fixtures.ts";

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(`${name} must be a non-empty string`);
}

function requireStringArray(value: unknown, name: string): readonly string[] {
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  throw new TypeError(`${name} must be an array of strings`);
}

function pathsFromRecordArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value.map((entry, index) => requireString(requireRecord(entry, `${name}[${index}]`).path, `${name}[${index}].path`));
}

async function createCommittedSession(sessionId: string, taskName: string) {
  const { repo } = await createRepoWithOrigin();
  const started = await guardianStart({
    repoRoot: repo,
    cwd: repo,
    sessionId,
    taskName,
    createWorktree: true,
    config: DEFAULT_CONFIG,
  });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");
  await fs.writeFile(path.join(worktree, `${taskName}.txt`), `${taskName}\n`, "utf8");
  await git(worktree, ["add", "."]);
  await git(worktree, ["commit", "-m", `add ${taskName}`]);
  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
  return { repo, worktree, branch, head };
}

async function assertWorktreePresent(repo: string, worktree: string): Promise<void> {
  const worktrees = (await git(repo, ["worktree", "list", "--porcelain"])).stdout;
  assert.match(worktrees, new RegExp(worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

test("guardian_done active-session plan is read-only and previews land-and-clean", async () => {
  const sessionId = "land-clean-plan";
  const { repo, worktree, branch, head } = await createCommittedSession(sessionId, "plan-preview");
  const result = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.equal(result.status, "planned");
  assert.equal(result.action, "land-and-clean");
  assert.equal(result.branch, branch);
  assert.equal(result.head, head);
  assert.equal(result.nextAction, "guardian_done mode=apply confirm=true");
  assert.equal(typeof result.confirmToken, "string");
  await assertWorktreePresent(repo, worktree);
  await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  await assert.rejects(git(repo, ["merge-base", "--is-ancestor", head, "origin/main"]));
});

test("dirty-session intent captures commit facts despite ignored residue without mutating Git", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, ".gitignore"), ".intent-state/\n", "utf8");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore intent state"]);
  await git(repo, ["push", "origin", "main"]);
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "done-intent-ignored", taskName: "done intent ignored", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  await fs.writeFile(path.join(worktree, "intent.txt"), "commit me\n", "utf8");
  await fs.mkdir(path.join(worktree, ".intent-state"));
  await fs.writeFile(path.join(worktree, ".intent-state", "state.json"), "{}\n", "utf8");

  const before = await rescueMutationSurface(repo, worktree);
  const first = await buildDirtySessionDoneIntent({ cwd: worktree, worktreePath: worktree });
  const second = await buildDirtySessionDoneIntent({ cwd: worktree, worktreePath: worktree });

  assert.deepEqual(first.snapshot.paths, ["intent.txt"]);
  assert.deepEqual(first.commitPaths, ["intent.txt"]);
  assert.deepEqual(first.ignoredFiles, [".intent-state/state.json"]);
  assert.equal(typeof first.sourceIndexTree, "string");
  assert.equal(typeof first.candidateTree, "string");
  assert.equal(first.digest, second.digest);
  assert.deepEqual(await rescueMutationSurface(repo, worktree), before);
  const normalDone = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId: "done-intent-ignored", mode: "plan", config: DEFAULT_CONFIG });
  assert.equal(normalDone.ok, false, JSON.stringify(normalDone));
  assert.match(String(normalDone.reason), /ignored files/);
});

test("guardian_done apply without confirm stops before land-clean preflight work", async (t) => {
  const sessionId = "land-clean-no-confirm-artifact-read-only"; const { repo, worktree, branch, head } = await createCommittedSession(sessionId, "no-confirm");
  const fakeGh = await installFakeGh(t, { repo, branch, head, dynamicHead: true }); const before = await rescueMutationSurface(repo);
  const result = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "apply", commitMessage: "feat: must not reach preflight", config: DEFAULT_CONFIG });
  assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.status, "blocked"); assert.match(String(result.reason), /confirm=true/);
  assert.deepEqual(await rescueMutationSurface(repo), before); assert.equal(await fs.access(fakeGh.logPath).then(() => true, () => false), false);
});


test("guardian_done cleans already-merged sessions without creating a PR", async (t) => {
  const sessionId = "land-clean-already-merged";
  const { repo, worktree, branch, head } = await createCommittedSession(sessionId, "already-merged");
  await git(repo, ["merge", "--ff-only", branch]);
  await git(repo, ["push", "origin", "main"]);
  const fakeGh = await installFakeGh(t, { repo, branch, head });
  const plan = requireRecord(await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "plan", config: DEFAULT_CONFIG, timestamp: "20260624T120000" }), "plan");

  const result = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken"), config: DEFAULT_CONFIG, timestamp: "20260624T120000" });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "already-landed-and-cleaned");
  assert.equal(result.worktreeRemoved, true);
  assert.equal(result.branchDeleted, true);
  const log = await fs.readFile(fakeGh.logPath, "utf8").catch(() => "");
  assert.equal(log, "");
  await assert.rejects(fs.access(worktree));
  await assert.rejects(git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]));
  assert.equal((await git(repo, ["merge-base", "--is-ancestor", head, "origin/main"]).then(() => true, () => false)), true);
});

test("guardian_done reuses an existing open PR before cleanup", async (t) => {
  const sessionId = "land-clean-existing-pr";
  const { repo, worktree, branch, head } = await createCommittedSession(sessionId, "existing-pr");
  const fakeGh = await installFakeGh(t, { repo, branch, head, existingPr: true });
  const plan = requireRecord(await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "plan", config: DEFAULT_CONFIG }), "plan");
  const result = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken"), config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.equal(result.status, "landed-and-cleaned");
  const log = await fs.readFile(fakeGh.logPath, "utf8");
  assert.match(log, /pr list/);
  assert.doesNotMatch(log, /pr create/);
  assert.match(log, /pr merge/);
  await assert.rejects(git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]));
});

test("guardian_done leaves worktree and branch intact when PR merge is waiting", async (t) => {
  const sessionId = "land-clean-waiting";
  const { repo, worktree, branch, head } = await createCommittedSession(sessionId, "merge-waiting");
  const fakeGh = await installFakeGh(t, { repo, branch, head, mergeFails: true });
  const plan = requireRecord(await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "plan", config: DEFAULT_CONFIG }), "plan");
  const result = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken"), config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.equal(result.status, "waiting");
  assert.equal(result.worktreeRemoved, undefined);
  assert.equal(result.branchDeleted, undefined);
  const log = await fs.readFile(fakeGh.logPath, "utf8");
  assert.match(log, /pr merge/);
  await assertWorktreePresent(repo, worktree);
  await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  await assert.rejects(git(repo, ["merge-base", "--is-ancestor", head, "origin/main"]));
});

test("guardian_done blocks dirty session apply without a plan token before fetch", async () => {
  const sessionId = "land-clean-dirty-no-message";
  const { repo, worktree, branch, head } = await createCommittedSession(sessionId, "dirty-no-message");
  await fs.writeFile(path.join(worktree, "uncommitted.txt"), "needs a message\n", "utf8");

  const result = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "apply", confirm: true, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(String(result.reason), /plan changed/);
  assert.equal(result.tokenMatched, false);
  await assertWorktreePresent(repo, worktree);
  await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  await assert.rejects(git(repo, ["merge-base", "--is-ancestor", head, "origin/main"]));
});

test("guardian_done still requires a commit message for tracked source dirt", async () => {
  const sessionId = "land-clean-source-dirty-no-message";
  const { repo, worktree, branch, head } = await createCommittedSession(sessionId, "source-dirty-no-message");
  await fs.writeFile(path.join(worktree, "README.md"), "changed source content\n", "utf8");

  const result = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "plan", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(String(result.reason), /commitMessage/);
  assert.equal(result.commitMessageRequired, undefined);
  await assertWorktreePresent(repo, worktree);
  await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  await assert.rejects(git(repo, ["merge-base", "--is-ancestor", head, "origin/main"]));
});

test("guardian_done still requires a commit message for tracked source dirt under a hygiene root", async () => {
  const sessionId = "land-clean-source-under-hygiene-root";
  const { repo, worktree, branch, head } = await createCommittedSession(sessionId, "source-under-hygiene-root");
  await fs.mkdir(path.join(worktree, "sample-librarian", "src"), { recursive: true });
  await fs.writeFile(path.join(worktree, "sample-librarian", "src", "index.ts"), "export const value = 1;\n", "utf8");
  await git(worktree, ["add", "sample-librarian/src/index.ts"]);
  await git(worktree, ["commit", "-m", "add tracked source under hygiene root"]);
  await fs.writeFile(path.join(worktree, "sample-librarian", "src", "index.ts"), "export const value = 2;\n", "utf8");
  await fs.writeFile(path.join(worktree, "sample-librarian", "scratch.log"), "generated\n", "utf8");

  const result = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "plan", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(String(result.reason), /commitMessage/);
  assert.equal(result.commitMessageRequired, undefined);
  await assertWorktreePresent(repo, worktree);
  await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  await assert.rejects(git(repo, ["merge-base", "--is-ancestor", head, "origin/main"]));
});

test("guardian_done plans cleanup guidance for hygiene-only dirty session work", async () => {
  const sessionId = "land-clean-hygiene-only";
  const { repo, worktree, branch, head } = await createCommittedSession(sessionId, "hygiene-only");
  await fs.mkdir(path.join(worktree, ".omc"), { recursive: true });
  await fs.writeFile(path.join(worktree, ".omc", "session.json"), "{}\n", "utf8");
  await fs.writeFile(path.join(worktree, "export.tsv"), "area\ttotal\n", "utf8");
  await fs.writeFile(path.join(worktree, "people-counter-report.csv"), "area,total\n", "utf8");

  const result = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "plan", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked-workspace-hygiene-required");
  assert.equal(result.commitMessageRequired, false);
  assert.doesNotMatch(String(result.reason), /commitMessage/);
  assert.deepEqual(result.knownCleanablePaths, ["export.tsv"]);
  assert.deepEqual(result.reviewablePaths, ["people-counter-report.csv"]);
  assert.deepEqual(result.ignoreCandidates, [".omc"]);
  const hygienePlan = requireRecord(result.hygienePlan, "result.hygienePlan");
  assert.equal(hygienePlan.ok, true);
  assert.equal(hygienePlan.status, "planned");
  const deletePathsPlan = requireRecord(result.deletePathsPlan, "result.deletePathsPlan");
  assert.equal(deletePathsPlan.ok, true);
  assert.equal(deletePathsPlan.status, "planned");
  await assertWorktreePresent(repo, worktree);
  await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  await assert.rejects(git(repo, ["merge-base", "--is-ancestor", head, "origin/main"]));
});

test("guardian_done classifies complete hygiene inventory before commit message enforcement", async () => {
  const sessionId = "land-clean-hygiene-overflow";
  const { repo, worktree, branch, head } = await createCommittedSession(sessionId, "hygiene-overflow");
  await fs.mkdir(path.join(worktree, ".omc"), { recursive: true });
  await fs.writeFile(path.join(worktree, ".omc", "session.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(worktree, ".playwright-mcp"), { recursive: true });
  await fs.writeFile(path.join(worktree, ".playwright-mcp", "state.json"), "{}\n", "utf8");
  for (let index = 0; index < 14; index += 1) {
    await fs.writeFile(path.join(worktree, `people-counter-${String(index).padStart(2, "0")}.csv`), "area,total\n", "utf8");
  }
  await fs.writeFile(path.join(worktree, "people-counter-raw.md"), "# people counter\n", "utf8");
  const nested = path.join(worktree, "emqx-postgres-persistence-librarian");
  await fs.mkdir(nested, { recursive: true });
  await git(nested, ["init", "-b", "main"]);
  await git(nested, ["config", "user.email", "guardian@example.test"]);
  await git(nested, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(nested, "README.md"), "nested\n", "utf8");
  await git(nested, ["add", "README.md"]);
  await git(nested, ["commit", "-m", "nested initial"]);

  const result = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId, mode: "plan", config: DEFAULT_CONFIG });

  const expectedReviewablePaths = [
    ".playwright-mcp",
    ...Array.from({ length: 14 }, (_unused, index) => `people-counter-${String(index).padStart(2, "0")}.csv`),
    "people-counter-raw.md",
  ];
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked-workspace-hygiene-required");
  assert.equal(result.commitMessageRequired, false);
  assert.doesNotMatch(String(result.reason), /commitMessage/);
  assert.deepEqual(requireStringArray(result.knownCleanablePaths, "result.knownCleanablePaths"), []);
  assert.deepEqual(requireStringArray(result.reviewablePaths, "result.reviewablePaths"), expectedReviewablePaths);
  assert.deepEqual(requireStringArray(result.ignoreCandidates, "result.ignoreCandidates"), [".omc"]);
  assert.deepEqual(requireStringArray(result.manualReviewCandidates, "result.manualReviewCandidates"), ["emqx-postgres-persistence-librarian"]);
  assert.equal(result.hygienePlan, null);
  const deletePathsPlan = requireRecord(result.deletePathsPlan, "result.deletePathsPlan");
  assert.equal(deletePathsPlan.ok, true);
  assert.equal(deletePathsPlan.status, "planned");
  assert.deepEqual(pathsFromRecordArray(deletePathsPlan.targets, "result.deletePathsPlan.targets"), expectedReviewablePaths);
  await assertWorktreePresent(repo, worktree);
  await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  await assert.rejects(git(repo, ["merge-base", "--is-ancestor", head, "origin/main"]));
});

test("guardian_done only uses admin bypass when allowAdminBypass is explicit", async (t) => {
  const sessionId = "land-clean-admin";
  const { repo, worktree, branch, head } = await createCommittedSession(sessionId, "admin-bypass");
  const fakeGh = await installFakeGh(t, { repo, branch, head, expectAdmin: true });
  const request = {
    repoRoot: repo,
    cwd: worktree,
    sessionId,
    allowAdminBypass: true,
    config: DEFAULT_CONFIG,
  };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");
  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });

  assert.equal(result.ok, true);
  assert.equal(result.status, "landed-and-cleaned");
  assert.equal(result.adminBypass, true);
  const log = await fs.readFile(fakeGh.logPath, "utf8");
  assert.match(log, /--admin/);
  await assert.rejects(git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]));
});
