import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { sessionLandCleanPreflight } from "../src/done-land-clean-consent.ts";
import { guardianUnblockFinish } from "../src/unblock-finish.ts";
import { guardianStart } from "../src/tools.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";
import { installFakeGh } from "./delete-fixtures.ts";

type CleanSession = {
  readonly base: string;
  readonly repo: string;
  readonly worktree: string;
  readonly branch: string;
  readonly sessionId: string;
  readonly head: string;
};

type LooseRecord = Record<string, unknown>;

const ownedRoots: string[] = [];

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

test.after(async () => {
  const remaining = await Promise.all(ownedRoots.map(async (root) => fs.access(root).then(() => root, () => null)));
  assert.deepEqual(remaining.filter((root): root is string => root !== null), []);
});

async function createCleanSession(t: TestContext, sessionId: string, beforeStart?: (repo: string) => Promise<void>): Promise<CleanSession> {
  const { base, repo } = await createRepoWithOrigin();
  ownedRoots.push(base);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  if (beforeStart) await beforeStart(repo);
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: sessionId, createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  const branch = started.session.branch;
  await fs.writeFile(path.join(worktree, "feature.txt"), `${sessionId}\n`, "utf8");
  await git(worktree, ["add", "feature.txt"]);
  await git(worktree, ["commit", "-m", `add ${sessionId}`]);
  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  return { base, repo, worktree, branch, sessionId, head };
}

async function configureHook(base: string, worktree: string, name: string, body: string): Promise<void> {
  const hooksPath = path.join(base, "hooks");
  await fs.mkdir(hooksPath, { recursive: true });
  await fs.writeFile(path.join(hooksPath, name), body, "utf8");
  await fs.chmod(path.join(hooksPath, name), 0o755);
  await git(worktree, ["config", "core.hooksPath", hooksPath]);
}

async function configureWorktreeSigning(worktree: string, value: string): Promise<void> {
  await git(worktree, ["config", "extensions.worktreeConfig", "true"]);
  await git(worktree, ["config", "--worktree", "commit.gpgSign", value]);
}

async function pathExists(target: string) {
  return fs.access(target).then(() => true, () => false);
}

async function commitInWorktree(worktree: string, commit: { readonly file: string; readonly content: string; readonly message: string }) {
  await fs.writeFile(path.join(worktree, commit.file), commit.content);
  await git(worktree, ["add", commit.file]);
  await git(worktree, ["commit", "-m", commit.message]);
}

async function landCleanSession(t: TestContext, session: CleanSession): Promise<Record<string, unknown>> {
  const fakeGh = await installFakeGh(t, { repo: session.repo, branch: session.branch, head: session.head });
  const request = { repoRoot: session.repo, cwd: session.worktree, sessionId: session.sessionId, config: DEFAULT_CONFIG };
  const plan = await guardianDone({ ...request, mode: "plan" });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.status, "planned");
  assert.deepEqual(plan.dirtyFiles, []);
  const token = plan.confirmToken;
  assert.equal(typeof token, "string");
  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: token });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "landed-and-cleaned");
  assert.equal(result.head, session.head);
  assert.equal(result.commit, undefined);
  assert.match(await fs.readFile(fakeGh.logPath, "utf8"), /pr merge/);
  return result;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("expected string");
  return value;
}

async function createWorktreeWithReviewArtifact(sessionId = "ses_unblock_review", branch?: string) {
  const { base, repo } = await createRepoWithOrigin();
  const start = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: sessionId, branch, createWorktree: true, config: DEFAULT_CONFIG });
  const reviewPath = path.join(start.session.worktree_path, ".milestones", "reviews", "source-facts-query-endpoint-hardening-impl-rating-20260602.md");
  await fs.mkdir(path.dirname(reviewPath), { recursive: true });
  await fs.writeFile(reviewPath, "# Source Facts Rating\n\n## Score: 87/100\n");
  return { base, repo, start, relativeReviewPath: ".milestones/reviews/source-facts-query-endpoint-hardening-impl-rating-20260602.md" };
}

test("plan reports stash inventory without blocking by default", async (t) => {
  const { base, repo, start } = await createWorktreeWithReviewArtifact("ses_unblock_stash_advisory");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.appendFile(path.join(repo, "README.md"), "stash advisory\n");
  await git(repo, ["stash", "push", "-m", "unblock advisory stash"]);

  const result = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, mode: "plan", config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.equal(result.preflight.stashCount, 1);
  assert.equal(Array.isArray(result.preflight.stashes) ? result.preflight.stashes.length : 0, 1);
});

test("strict stash policy blocks unblock plan and apply before commit", async (t) => {
  const { base, repo, start } = await createWorktreeWithReviewArtifact("ses_unblock_stash_strict");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.appendFile(path.join(repo, "README.md"), "stash strict\n");
  await git(repo, ["stash", "push", "-m", "unblock strict stash"]);
  const config = { ...DEFAULT_CONFIG, requireEmptyStashInventory: true };
  const headBefore = (await git(start.session.worktree_path, ["rev-parse", "HEAD"])).stdout;

  const plan = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, mode: "plan", config });
  const apply = await guardianUnblockFinish({ repoRoot: repo, sessionId: start.session.session_id, mode: "apply", confirmToken: "invalid", config });

  assert.equal(plan.ok, false);
  assert.match(requireString(plan.reason), /stash inventory/);
  assert.equal(plan.preflight.stashCount, 1);
  assert.equal(apply.ok, false);
  assert.match(requireString(apply.reason), /stash inventory/);
  assert.equal((await git(start.session.worktree_path, ["rev-parse", "HEAD"])).stdout, headBefore);
});

test("guardian_done lands a clean session despite commit-only hook, signing, and filter policy", async (t) => {
  for (const policy of ["hook", "signing", "malformed-signing", "filter"] as const) {
    const session = await createCleanSession(t, `clean-policy-${policy}`, policy === "filter" ? async (repo) => {
      await fs.writeFile(path.join(repo, ".gitattributes"), "*.txt filter=guardian-clean\n", "utf8");
      await git(repo, ["add", ".gitattributes"]);
      await git(repo, ["commit", "-m", "configure clean filter"]);
      await git(repo, ["push", "origin", "main"]);
    } : undefined);
    const marker = path.join(session.base, `${policy}.ran`);
    if (policy === "hook") {
      await configureHook(session.base, session.worktree, "pre-commit", `#!/bin/sh\nprintf hook > ${JSON.stringify(marker)}\n`);
    } else if (policy === "signing") {
      await configureWorktreeSigning(session.worktree, "true");
    } else if (policy === "malformed-signing") {
      await configureWorktreeSigning(session.worktree, "malformed");
    } else {
      const filter = path.join(session.base, "clean-filter.sh");
      await fs.writeFile(filter, `#!/bin/sh\ncat\nprintf filter > ${JSON.stringify(marker)}\n`, "utf8");
      await fs.chmod(filter, 0o755);
      await git(session.worktree, ["config", "filter.guardian-clean.clean", filter]);
    }

    await landCleanSession(t, session);
    if (policy === "filter") await fs.access(marker);
    else await assert.rejects(fs.access(marker));
    await assert.rejects(fs.access(session.worktree));
  }
});

test("guardian_done blocks an effective reference transaction hook before clean-session ref writes", async (t) => {
  const session = await createCleanSession(t, "clean-reference-transaction");
  const marker = path.join(session.base, "reference-transaction.ran");
  await configureHook(session.base, session.worktree, "reference-transaction", `#!/bin/sh\nif [ "$1" = committed ]; then printf ref-write > ${JSON.stringify(marker)}; fi\n`);
  const fakeGh = await installFakeGh(t, { repo: session.repo, branch: session.branch, head: session.head });

  const result = await guardianDone({ repoRoot: session.repo, cwd: session.worktree, sessionId: session.sessionId, mode: "plan", config: DEFAULT_CONFIG });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(JSON.stringify(result), /reference-transaction/i);
  await assert.rejects(fs.access(marker));
  await assert.rejects(fs.access(fakeGh.logPath));
  assert.equal((await git(session.repo, ["rev-parse", session.branch])).stdout, session.head);
  await fs.access(session.worktree);
});

test("guardian_done all=true lands a clean session with malformed commit signing", async (t) => {
  const session = await createCleanSession(t, "clean-done-all-malformed-signing");
  await configureWorktreeSigning(session.worktree, "malformed");
  await installFakeGh(t, { repo: session.repo, branch: session.branch, head: session.head });

  const plan = await guardianDone({ repoRoot: session.repo, cwd: session.repo, all: true, mode: "plan", config: DEFAULT_CONFIG });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.status, "planned");
  assert.equal(requireRecord(plan.summary, "plan.summary").finishable, 1);
  const result = await guardianDone({ repoRoot: session.repo, cwd: session.repo, all: true, mode: "apply", confirm: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "finished");
  await assert.rejects(fs.access(session.worktree));
});

test("land-clean preflight rejects an equal-head live branch that differs from the recorded session", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "branch-identity", taskName: "branch identity", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  await git(worktree, ["branch", "guardian/equal-head"]);
  await git(worktree, ["checkout", "guardian/equal-head"]);

  const result = await sessionLandCleanPreflight({ repoRoot: repo, cwd: worktree, sessionId: "branch-identity", input: {}, session: started.session, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(String(result.reason), /branch mismatch/);
});

test("land-clean preserves ignored content changed during PR merge before cleanup", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, ".gitignore"), ".claude/\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore runtime state"]);
  await git(repo, ["push", "origin", "main"]);
  const sessionId = "ignored-change-during-merge";
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "ignored change during merge", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  const branch = started.session.branch;
  await commitInWorktree(worktree, { file: "feature.txt", content: "feature\n", message: "add feature" });
  await fs.mkdir(path.join(worktree, ".claude"), { recursive: true });
  const ignoredPath = path.join(worktree, ".claude", "state.log");
  await fs.writeFile(ignoredPath, "planned\n");
  await installFakeGh(t, { repo, branch, dynamicHead: true });
  const ghPath = path.join(String(process.env.PATH).split(path.delimiter)[0], "gh");
  const delegatePath = `${ghPath}-delegate`;
  await fs.rename(ghPath, delegatePath);
  await fs.writeFile(ghPath, `#!/bin/sh\nset -eu\nif [ "$1" = "pr" ] && [ "\${2:-}" = "merge" ]; then printf 'changed during merge\\n' > ${JSON.stringify(ignoredPath)}; fi\nexec ${JSON.stringify(delegatePath)} "$@"\n`);
  await fs.chmod(ghPath, 0o755);
  const request = { repoRoot: repo, cwd: worktree, sessionId, allowIgnoredFiles: true, timestamp: "20260727T040404", config: DEFAULT_CONFIG };
  const plan = await guardianDone({ ...request, mode: "plan" }) as LooseRecord;

  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: plan.confirmToken }) as LooseRecord;

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "cleanup-blocked");
  assert.match(String(result.reason), /ignored-file consent changed/);
  assert.equal(await fs.readFile(ignoredPath, "utf8"), "changed during merge\n");
  assert.equal(await pathExists(worktree), true);
});

test("done-all rejects allowIgnoredFiles added after outer planning", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const session = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "done-all-flag-drift", taskName: "done all flag drift", createWorktree: true, config: DEFAULT_CONFIG });
  await commitInWorktree(session.session.worktree_path, { file: "feature.txt", content: "feature\n", message: "add feature" });
  await installFakeGh(t, { repo, branch: session.session.branch, dynamicHead: true });
  const plan = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "plan" }) as LooseRecord;

  const result = await guardianDone({ repoRoot: repo, cwd: repo, all: true, mode: "apply", confirm: true, confirmToken: plan.confirmToken, allowIgnoredFiles: true }) as LooseRecord;

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(String(result.reason), /confirm token mismatch/);
  assert.equal(await pathExists(session.session.worktree_path), true);
});

test("done-all rejects active-session ignored content changed after outer planning", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, ".gitignore"), ".claude/\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore runtime state"]);
  await git(repo, ["push", "origin", "main"]);
  const session = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "done-all-child-drift", taskName: "done all child drift", createWorktree: true, config: DEFAULT_CONFIG });
  await commitInWorktree(session.session.worktree_path, { file: "feature.txt", content: "feature\n", message: "add feature" });
  await fs.mkdir(path.join(session.session.worktree_path, ".claude"), { recursive: true });
  const ignoredPath = path.join(session.session.worktree_path, ".claude", "state.log");
  await fs.writeFile(ignoredPath, "planned\n");
  await installFakeGh(t, { repo, branch: session.session.branch, dynamicHead: true });
  const request = { repoRoot: repo, cwd: repo, all: true, allowIgnoredFiles: true };
  const plan = await guardianDone({ ...request, mode: "plan" }) as LooseRecord;
  await fs.writeFile(ignoredPath, "changed\n");

  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: plan.confirmToken }) as LooseRecord;

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(String(result.reason), /confirm token mismatch/);
  assert.equal(await fs.readFile(ignoredPath, "utf8"), "changed\n");
});
