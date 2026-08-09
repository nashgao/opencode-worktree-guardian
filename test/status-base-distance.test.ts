import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { formatGuardianStatusOutput } from "../src/plugin/readable-output-status.ts";
import { guardianStatus } from "../src/recover.ts";
import { guardianStart } from "../src/start.ts";
import { computeGuardianVerdict } from "../src/verdict.ts";
import { createRepo, createRepoWithOrigin, createTempDir, git, seedSession } from "./helpers.ts";

async function startFixture(t: test.TestContext, sessionId: string) {
  const fixture = await createRepoWithOrigin();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const started = await guardianStart({
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    sessionId,
    taskName: sessionId,
    createWorktree: true,
    config: DEFAULT_CONFIG,
  });
  return { ...fixture, sessionId, worktree: started.session.worktree_path };
}

function distanceFor(status: Awaited<ReturnType<typeof guardianStatus>>, sessionId: string) {
  const distance = status.activeSessionBaseDistances.find((entry) => entry.sessionId === sessionId);
  assert.ok(distance, `expected a base distance for ${sessionId}`);
  return distance;
}

function requireAvailable(distance: ReturnType<typeof distanceFor>) {
  if (distance.status !== "available") throw new Error(`expected available distance, got ${distance.reason}`);
  return distance;
}

async function commitFile(repo: string, filename: string, message: string): Promise<void> {
  await fs.writeFile(path.join(repo, filename), `${message}\n`);
  await git(repo, ["add", filename]);
  await git(repo, ["commit", "-m", message]);
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function installStatusReadOnlyGitProbe(t: test.TestContext): Promise<string> {
  const binDir = await createTempDir("guardian-status-read-only-git-");
  const logPath = path.join(binDir, "git.log");
  const gitPath = path.join(binDir, "git");
  await fs.writeFile(gitPath, `#!/bin/sh
set -eu
if printf '%s\\n' "$*" | grep -Eq '(^| )((merge-base|rev-list)( |$)|[^ ]+@\\{upstream\\})|--name-only|refs/remotes/'; then
  printf '%s|%s|%s\\n' "\${GIT_NO_LAZY_FETCH:-}" "\${GIT_OPTIONAL_LOCKS:-}" "$*" >> "$GUARDIAN_STATUS_GIT_LOG"
  if [ "\${GIT_NO_LAZY_FETCH:-}" != "1" ] || [ "\${GIT_OPTIONAL_LOCKS:-}" != "0" ]; then
    exit 97
  fi
fi
PATH="$GUARDIAN_STATUS_REAL_PATH" command git "$@"
`, "utf8");
  await fs.chmod(gitPath, 0o755);
  const originalPath = process.env.PATH;
  const originalLog = process.env.GUARDIAN_STATUS_GIT_LOG;
  const originalRealPath = process.env.GUARDIAN_STATUS_REAL_PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.GUARDIAN_STATUS_GIT_LOG = logPath;
  process.env.GUARDIAN_STATUS_REAL_PATH = originalPath ?? "";
  t.after(async () => {
    restoreEnvironment("PATH", originalPath);
    restoreEnvironment("GUARDIAN_STATUS_GIT_LOG", originalLog);
    restoreEnvironment("GUARDIAN_STATUS_REAL_PATH", originalRealPath);
    await fs.rm(binDir, { recursive: true, force: true });
  });
  return logPath;
}

test("guardian_status reports a fresh cached base without fetching", async (t) => {
  const fixture = await startFixture(t, "ses_fresh_distance");
  const fetchHead = path.join(fixture.repo, ".git", "FETCH_HEAD");
  const fetchHeadBefore = await fs.access(fetchHead).then(() => true, () => false);

  const status = await guardianStatus({ repoRoot: fixture.repo, config: DEFAULT_CONFIG });
  const distance = requireAvailable(distanceFor(status, fixture.sessionId));

  assert.equal(distance.baseRef, "origin/main");
  assert.equal(distance.baseAuthorityRef, "refs/remotes/origin/main");
  assert.equal(distance.baseRefOid, (await git(fixture.repo, ["rev-parse", "origin/main"])).stdout);
  assert.equal(distance.relation, "equal");
  assert.equal(distance.ahead, 0);
  assert.equal(distance.behind, 0);
  assert.equal(await fs.access(fetchHead).then(() => true, () => false), fetchHeadBefore);
});

test("guardian_status reports cached effective-remote scope without examining secondary remotes", async (t) => {
  // Given
  const fixture = await startFixture(t, "ses_status_operational_scope");
  const mirror = path.join(fixture.base, "mirror.git");
  await git(fixture.repo, ["init", "--bare", mirror]);
  await git(fixture.repo, ["remote", "add", "mirror", mirror]);

  // When
  const status = await guardianStatus({ repoRoot: fixture.repo, config: DEFAULT_CONFIG });

  // Then
  assert.deepEqual(status.operationalScope, {
    effectiveRemote: "origin",
    unexaminedSecondaryRemotes: ["mirror"],
    localBranchCount: 2,
    effectiveRemoteBranchCount: 1,
    freshness: "cached-read-only",
  });
});

test("guardian_status base distance routes ancestry through the read-only Git runner", async (t) => {
  const fixture = await startFixture(t, "ses_read_only_lineage");
  const logPath = await installStatusReadOnlyGitProbe(t);

  const status = await guardianStatus({ repoRoot: fixture.repo, config: DEFAULT_CONFIG });
  const distance = requireAvailable(distanceFor(status, fixture.sessionId));
  const calls = (await fs.readFile(logPath, "utf8")).trim().split("\n").filter(Boolean);

  assert.equal(distance.relation, "equal");
  assert.ok(calls.some((call) => call.includes("config --includes --null --name-only --get-regexp ^remote\\..*\\.(url|pushurl)$")));
  assert.ok(calls.some((call) => call.includes("for-each-ref --format=%(refname:short) refs/remotes/origin")));
  assert.ok(calls.some((call) => call.includes("merge-base")));
  assert.ok(calls.every((call) => call.startsWith("1|0|")));
});

test("guardian_status reports an active worktree ahead of the cached base", async (t) => {
  const fixture = await startFixture(t, "ses_ahead_distance");
  await commitFile(fixture.worktree, "ahead.txt", "ahead of cached base");

  const status = await guardianStatus({ repoRoot: fixture.repo, config: DEFAULT_CONFIG });
  const distance = requireAvailable(distanceFor(status, fixture.sessionId));

  assert.equal(distance.relation, "ahead");
  assert.equal(distance.ahead, 1);
  assert.equal(distance.behind, 0);
});

test("guardian_status warns when an active worktree is behind the cached base", async (t) => {
  const fixture = await startFixture(t, "ses_behind_distance");
  await commitFile(fixture.repo, "behind.txt", "advance cached base");
  await git(fixture.repo, ["push", "origin", "main"]);

  const status = await guardianStatus({ repoRoot: fixture.repo, config: DEFAULT_CONFIG });
  const distance = requireAvailable(distanceFor(status, fixture.sessionId));

  assert.equal(distance.relation, "behind");
  assert.equal(distance.ahead, 0);
  assert.equal(distance.behind, 1);
  assert.equal(computeGuardianVerdict(status).tone, "warn");
});

test("guardian_status exposes diverged cached distance in output and verdict", async (t) => {
  const fixture = await startFixture(t, "ses_diverged_distance");
  await commitFile(fixture.worktree, "feature.txt", "feature diverges");
  await commitFile(fixture.repo, "base.txt", "base diverges");
  await git(fixture.repo, ["push", "origin", "main"]);

  const status = await guardianStatus({ repoRoot: fixture.repo, config: DEFAULT_CONFIG });
  const distance = requireAvailable(distanceFor(status, fixture.sessionId));
  const output = formatGuardianStatusOutput("guardian_status", status);

  assert.equal(distance.relation, "diverged");
  assert.equal(distance.ahead, 1);
  assert.equal(distance.behind, 1);
  assert.equal(computeGuardianVerdict(status).tone, "bad");
  assert.match(output, /Base distance: origin\/main .* ahead=1 behind=1 relation=diverged/);
});

test("guardian_status calculates a detached active worktree from its live HEAD", async (t) => {
  const fixture = await startFixture(t, "ses_detached_distance");
  await git(fixture.worktree, ["checkout", "--detach"]);

  const status = await guardianStatus({ repoRoot: fixture.repo, config: DEFAULT_CONFIG });
  const distance = requireAvailable(distanceFor(status, fixture.sessionId));

  assert.equal(distance.detached, true);
  assert.equal(distance.relation, "equal");
});

test("guardian_status marks a recorded active session without a live head as unavailable", async (t) => {
  const fixture = await createRepoWithOrigin();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  await seedSession(fixture.repo, {
    session_id: "ses_no_head_distance",
    status: "active",
    branch: "guardian/no-head",
    worktree_path: path.join(fixture.repo, ".worktrees", "missing"),
    base_ref: "origin/main",
    safety_refs: [],
  });

  const status = await guardianStatus({ repoRoot: fixture.repo, config: DEFAULT_CONFIG });
  const distance = distanceFor(status, "ses_no_head_distance");

  assert.equal(distance.status, "unavailable");
  assert.equal(distance.reason, "head-unavailable");
});

test("guardian_status marks a missing local authority ref as unavailable", async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await seedSession(repo, {
    session_id: "ses_base_unavailable",
    status: "active",
    branch: "guardian/base-unavailable",
    worktree_path: repo,
    base_ref: "origin/main",
    safety_refs: [],
  });

  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const distance = distanceFor(status, "ses_base_unavailable");

  assert.equal(status.baseAuthority.status, "unavailable");
  assert.equal(status.baseAuthority.reason, "base-ref-unavailable");
  assert.equal(distance.status, "unavailable");
  assert.equal(distance.reason, "base-ref-unavailable");
});
