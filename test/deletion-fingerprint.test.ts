import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectIgnoredFileFingerprint, setIgnoredFileFingerprintTestHookForTesting } from "../src/deletion-fingerprint.ts";
import {
  branchExists,
  createGuardianWorktree,
  createRepoWithOrigin,
  DEFAULT_CONFIG,
  deleteWorktree,
  findSession,
  guardianStatus,
  git,
  worktreePaths,
} from "./delete-fixtures.js";

test("ignored fingerprint skips file, symlink, and directory children that disappear after readdir", async (t) => {
  const roots: string[] = [];
  t.after(async () => {
    setIgnoredFileFingerprintTestHookForTesting(undefined);
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  for (const kind of ["file", "symlink", "directory"] as const) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-deletion-fingerprint-"));
    roots.push(root);
    const ignoredDirectory = path.join(root, "ignored");
    const child = path.join(ignoredDirectory, kind);
    await fs.mkdir(ignoredDirectory);
    if (kind === "file") await fs.writeFile(child, "generated\n");
    if (kind === "symlink") {
      const target = path.join(root, "symlink-target");
      await fs.writeFile(target, "generated\n");
      await fs.symlink(target, child);
    }
    if (kind === "directory") await fs.mkdir(child);

    setIgnoredFileFingerprintTestHookForTesting({
      afterDirectoryRead: async () => {
        await fs.rm(child, { recursive: true, force: true });
      },
    });

    const fingerprint = await collectIgnoredFileFingerprint(root, ["ignored/"]);

    assert.deepEqual(fingerprint, ["ignored/"]);
  }
});

test("Guardian plan and apply preserve a raced ignored worktree and reject reappearing content", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(async () => {
    setIgnoredFileFingerprintTestHookForTesting(undefined);
    await fs.rm(base, { recursive: true, force: true });
  });
  const sessionId = "ses_deletion_fingerprint_race";
  const branch = "guardian/deletion-fingerprint-race";
  const start = await createGuardianWorktree(repo, sessionId, "deletion fingerprint race", branch);
  const worktreePath = start.session.worktree_path;
  await fs.writeFile(path.join(worktreePath, ".gitignore"), "ignored-output/\n");
  await git(worktreePath, ["add", ".gitignore"]);
  await git(worktreePath, ["commit", "-m", "ignore deletion fingerprint output"]);
  const ignoredDirectory = path.join(worktreePath, "ignored-output");
  const vanishedChild = path.join(ignoredDirectory, "vanished.log");
  await fs.mkdir(ignoredDirectory);
  await fs.writeFile(vanishedChild, "generated\n");
  let hookRan = false;
  setIgnoredFileFingerprintTestHookForTesting({
    afterDirectoryRead: async () => {
      if (!hookRan) {
        hookRan = true;
        await fs.rm(vanishedChild, { force: true });
      }
    },
  });

  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, deleteBranch: false, allowIgnoredFiles: true, config: DEFAULT_CONFIG });

  setIgnoredFileFingerprintTestHookForTesting(undefined);
  assert.equal(hookRan, true);
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.report.action, "planned");
  assert.equal((await worktreePaths(repo)).includes(worktreePath), true);
  assert.equal(await branchExists(repo, branch), true);
  const plannedStatus = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(plannedStatus.safetyRefs.length, 0);
  assert.equal(findSession(plannedStatus, sessionId).status, "active");

  await fs.writeFile(path.join(ignoredDirectory, "reappeared.log"), "new generated content\n");
  const apply = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "apply", sessionId, deleteBranch: false, allowIgnoredFiles: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG });

  assert.equal(apply.ok, false);
  assert.equal(apply.status, "blocked");
  assert.match(apply.reason, /confirm token mismatch/);
  assert.equal(apply.report.action, "blocked");
  assert.equal((await worktreePaths(repo)).includes(worktreePath), true);
  assert.equal(await branchExists(repo, branch), true);
  const blockedStatus = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(blockedStatus.safetyRefs.length, 0);
  const session = findSession(blockedStatus, sessionId);
  assert.equal(session.status, "active");
  assert.equal(Object.hasOwn(session, "worktree_delete_failed"), false);
});
