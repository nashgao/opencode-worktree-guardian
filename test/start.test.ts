import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { guardianStatus } from "../src/recover.ts";
import { guardianStart as startGuardianSession } from "../src/start.ts";
import { guardianStart } from "../src/tools.ts";
import { createRepo, createRepoWithOrigin, createTempDir, git, makeBranchCommit, seedSession } from "./helpers.ts";

const ownedRoots: string[] = [];

type DoneResult = Record<string, unknown> & {
  readonly action?: string;
  readonly lane?: string;
  readonly nextAction?: string;
  readonly preflight?: Record<string, unknown>;
  readonly reattached?: boolean;
  readonly reason?: string;
  readonly sessionId?: string;
  readonly status?: string;
  readonly worktree?: string;
};

function asDone(result: Record<string, unknown>): DoneResult {
  return result as DoneResult;
}

async function guardianRefNames(repo: string) {
  const { stdout } = await git(repo, ["for-each-ref", "--format=%(refname)", "refs/opencode-guardian"]);
  return stdout.length === 0 ? [] : stdout.split("\n");
}

async function shadowOriginMain(repo: string, commit: string): Promise<void> {
  await git(repo, ["update-ref", "refs/heads/origin/main", commit]);
}

async function createUnrelatedCommit(repo: string, message: string): Promise<string> {
  const tree = (await git(repo, ["rev-parse", "HEAD^{tree}"])).stdout;
  return (await git(repo, ["commit-tree", tree, "-m", message])).stdout;
}

test.after(async () => {
  const remaining = await Promise.all(ownedRoots.map((root) => fs.access(root).then(() => root, () => null)));
  assert.deepEqual(remaining.filter((root): root is string => root !== null), []);
});

test("guardian_start refuses to record a session whose worktree is in a different git repository than repoRoot", async () => {
  const repo = await createRepo();
  const foreign = await createRepo();
  test.after(() => fs.rm(repo, { recursive: true, force: true }));
  test.after(() => fs.rm(foreign, { recursive: true, force: true }));
  await makeBranchCommit(foreign, "tooling/preserve-local-changes");

  const result = await guardianStart({ repoRoot: repo, cwd: foreign, sessionId: "ses_cross", taskName: "cross", config: DEFAULT_CONFIG });
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(String(result.reason), /different git repository/);

  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.sessions.some((session) => session.session_id === "ses_cross"), false);
});

test("guardian_start records a session on a real worktree of repoRoot", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));

  const result = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_same", taskName: "same", createWorktree: true, config: DEFAULT_CONFIG });
  assert.equal(result.ok, true);

  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.sessions.some((session) => session.session_id === "ses_same"), true);
});

test("guardian_start rejects a symlink spelling of the primary worktree", { skip: process.platform === "win32" }, async () => {
  const repo = await createRepo();
  const primaryAlias = path.join(path.dirname(repo), `${path.basename(repo)}-primary-alias`);
  const config = { ...DEFAULT_CONFIG, protectedBranches: [] };
  await fs.symlink(repo, primaryAlias, "dir");

  const result = await guardianStart({ repoRoot: primaryAlias, cwd: repo, sessionId: "ses_primary_alias", taskName: "primary alias", config });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(String(result.reason), /primary repository worktree/);
  const status = await guardianStatus({ repoRoot: primaryAlias, config });
  assert.equal(status.sessions.some((session) => session.session_id === "ses_primary_alias"), false);
});

test("guardian_start rejects an option-shaped branch before worktree add", async (t) => {
  // Given a real repository and a fake Git executable that marks worktree mutations only.
  const { base, repo } = await createRepoWithOrigin();
  const tools = await createTempDir("guardian-start-branch-marker-");
  const marker = path.join(tools, "worktree.marker");
  const fakeGit = path.join(tools, "git");
  const originalPath = process.env.PATH;
  const originalRealPath = process.env.GUARDIAN_REAL_PATH;
  t.after(async () => fs.rm(base, { recursive: true, force: true }));
  t.after(async () => fs.rm(tools, { recursive: true, force: true }));
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalRealPath === undefined) delete process.env.GUARDIAN_REAL_PATH;
    else process.env.GUARDIAN_REAL_PATH = originalRealPath;
  });
  await fs.writeFile(fakeGit, '#!/bin/sh\nif [ "$3" = worktree ]; then : > "$GUARDIAN_WORKTREE_MARKER"; exit 93; fi\nPATH="$GUARDIAN_REAL_PATH" exec git "$@"\n');
  await fs.chmod(fakeGit, 0o755);
  process.env.PATH = `${tools}${path.delimiter}${originalPath ?? ""}`;
  process.env.GUARDIAN_REAL_PATH = originalPath ?? "";
  process.env.GUARDIAN_WORKTREE_MARKER = marker;

  // When an option-shaped explicit branch is used for a new session worktree.
  await assert.rejects(guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_bad_branch", taskName: "bad branch", branch: "--malformed-branch", createWorktree: true, config: DEFAULT_CONFIG }), /Git ref/i);

  // Then the worktree-add Git command never runs.
  await assert.rejects(fs.access(marker));
});

test("reference transaction hook blocks guardian_start before branch or worktree creation", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  ownedRoots.push(base);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const marker = path.join(base, "start-hook-ran");
  const hooks = path.join(repo, "reference-transaction-hooks");
  await fs.mkdir(hooks, { recursive: true });
  await fs.writeFile(path.join(hooks, "reference-transaction"), `#!/bin/sh\nprintf hook > ${JSON.stringify(marker)}\n`, "utf8");
  await fs.chmod(path.join(hooks, "reference-transaction"), 0o755);
  await git(repo, ["config", "core.hooksPath", hooks]);

  await assert.rejects(startGuardianSession({ repoRoot: repo, cwd: repo, sessionId: "hook-start", taskName: "hook start", createWorktree: true, config: DEFAULT_CONFIG }), /reference-transaction/i);

  await assert.rejects(fs.access(marker));
  await assert.rejects(git(repo, ["show-ref", "--verify", "refs/heads/guardian/hook-start"]));
  assert.equal((await git(repo, ["worktree", "list", "--porcelain"])).stdout.includes("guardian/hook-start"), false);
});

test("guardian_start bases a new worktree on remote-tracking authority", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const remoteBase = (await git(repo, ["rev-parse", "refs/remotes/origin/main"])).stdout;
  const shadow = await createUnrelatedCommit(repo, "start shadow");
  await shadowOriginMain(repo, shadow);

  const result = await startGuardianSession({ repoRoot: repo, cwd: repo, sessionId: "authority-start", taskName: "authority start", createWorktree: true, config: DEFAULT_CONFIG });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await git(result.session.worktree_path, ["rev-parse", "HEAD"])).stdout, remoteBase);
});

test("guardian_start blocks overlapping trusted remote namespaces before worktree creation", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const config = { ...DEFAULT_CONFIG, trustedUpstreamRemotes: ["origin/main"] };

  const result = await startGuardianSession({ repoRoot: repo, cwd: repo, sessionId: "authority-overlap-start", taskName: "authority overlap start", createWorktree: true, config });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(String(result.reason), /remote namespaces overlap/);
});

test("guardian_done direct preserve-only defaults to read-only planning", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_default_plan_preserve", taskName: "done default plan preserve", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  await fs.writeFile(path.join(worktree, "default-plan-preserve.txt"), "default plan preserve\n");
  await git(worktree, ["add", "default-plan-preserve.txt"]);
  await git(worktree, ["commit", "-m", "add default plan preserve work"]);

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: worktree, sessionId: "ses_done_default_plan_preserve", finishMode: "preserve-only", timestamp: "20260609T060707", config: DEFAULT_CONFIG }));

  assert.equal(result.ok, true);
  assert.equal(result.lane, "session-finish");
  assert.equal(result.status, "planned");
  assert.equal(result.safetyRef, undefined);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.activeSessions.some((session: Record<string, unknown>) => session.session_id === "ses_done_default_plan_preserve"), true);
  assert.equal(status.safetyRefs.length, 0);
  assert.deepEqual(await guardianRefNames(repo), []);
});

test("guardian_done plans reattaching a new session inside an existing Guardian worktree", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_lost_original", taskName: "done lost original", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(started.session.worktree_path, "reattached.txt"), "reattached\n");
  await git(started.session.worktree_path, ["add", "reattached.txt"]);
  await git(started.session.worktree_path, ["commit", "-m", "add reattached work"]);

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: "ses_done_new_session", timestamp: "20260609T030303" }));

  assert.equal(result.ok, true);
  assert.equal(result.lane, "session-finish");
  assert.equal(result.status, "planned");
  assert.equal(result.action, "reattach-and-finish");
  assert.equal(result.reattached, true);
  assert.equal(result.sessionId, "ses_done_new_session");
  assert.equal(result.worktree, started.session.worktree_path);
  assert.equal(result.nextAction, "guardian_done mode=apply confirm=true");
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.activeSessions.some((session: Record<string, unknown>) => session.session_id === "ses_done_lost_original"), true);
  assert.equal(status.sessions.some((session: Record<string, unknown>) => session.session_id === "ses_done_new_session"), false);
  assert.equal(status.terminalSessions.some((session: Record<string, unknown>) => session.session_id === "ses_done_lost_original" && session.status === "superseded"), false);
  assert.equal(status.safetyRefs.length, 0);
  assert.deepEqual(await guardianRefNames(repo), []);
});

test("guardian_done reattach apply requires confirmation", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_reattach_no_confirm_original", taskName: "reattach no confirm", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(started.session.worktree_path, "reattach-no-confirm.txt"), "reattach no confirm\n");
  await git(started.session.worktree_path, ["add", "reattach-no-confirm.txt"]);
  await git(started.session.worktree_path, ["commit", "-m", "add reattach no confirm work"]);

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: "ses_done_reattach_no_confirm_new", mode: "apply", timestamp: "20260609T031313" }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.lane, "session-finish");
  assert.match(String(result.reason), /confirm=true/);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.activeSessions.some((session: Record<string, unknown>) => session.session_id === "ses_done_reattach_no_confirm_original"), true);
  assert.equal(status.sessions.some((session: Record<string, unknown>) => session.session_id === "ses_done_reattach_no_confirm_new"), false);
  assert.equal(status.safetyRefs.length, 0);
});

test("guardian_done reattach apply records and finishes after confirmation", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_done_reattach_apply_original", taskName: "reattach apply", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(started.session.worktree_path, "reattach-apply.txt"), "reattach apply\n");
  await git(started.session.worktree_path, ["add", "reattach-apply.txt"]);
  await git(started.session.worktree_path, ["commit", "-m", "add reattach apply work"]);

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: "ses_done_reattach_apply_new", mode: "apply", confirm: true, timestamp: "20260609T032323" }));

  assert.equal(result.ok, true);
  assert.equal(result.lane, "session-finish");
  assert.equal(result.status, "pr-suggested");
  assert.equal(result.reattached, true);
  assert.equal(result.preflight?.sessionId, "ses_done_reattach_apply_new");
  assert.equal(result.preflight?.currentWorktree, started.session.worktree_path);
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(status.terminalSessions.some((session: Record<string, unknown>) => session.session_id === "ses_done_reattach_apply_new" && session.status === "preserved"), true);
  assert.equal(status.terminalSessions.some((session: Record<string, unknown>) => session.session_id === "ses_done_reattach_apply_original" && session.status === "superseded"), true);
  assert.equal(status.safetyRefs.length, 1);
});

test("guardian_done blocks protected primary rescue scenarios outside base branch", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await git(repo, ["checkout", "-b", "production"]);
  const config = { ...DEFAULT_CONFIG, protectedBranches: [...DEFAULT_CONFIG.protectedBranches, "production"] };

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", config }));

  assert.equal(result.ok, false);
  assert.equal(result.lane, "primary-rescue-recommended");
  assert.match(String(result.reason), /rescue it to a Guardian worktree/);
  assert.deepEqual(result.suggestedCommands, ["guardian_start createWorktree=true", "guardian_status"]);
});

test("guardian_done blocks poisoned active session bound to protected primary worktree", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await seedSession(repo, {
    session_id: "ses_done_poisoned_primary",
    status: "active",
    branch: "main",
    worktree_path: repo,
    base_ref: "origin/main",
    safety_refs: [],
  });
  await fs.writeFile(path.join(repo, "poisoned-primary.txt"), "must not publish through session-finish\n", "utf8");

  const result = asDone(await guardianDone({
    repoRoot: repo,
    cwd: repo,
    sessionId: "ses_done_poisoned_primary",
    mode: "apply",
    confirm: true,
    commitMessage: "feat: should not publish poisoned primary",
    config: DEFAULT_CONFIG,
  }));

  assert.equal(result.ok, false);
  assert.equal(result.lane, "poisoned-primary-protected-session");
  assert.match(String(result.reason), /primary worktree|protected branch/);
  const remoteHead = (await git(repo, ["rev-parse", "origin/main"])).stdout;
  const localHead = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  assert.equal(remoteHead, localHead);
});
