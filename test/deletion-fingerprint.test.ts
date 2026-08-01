import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectIgnoredFileFingerprint, setDeletionFingerprintTestHookForTesting } from "../src/deletion-fingerprint.ts";
import { guardianHygiene, scanWorkspaceHygiene } from "../src/hygiene.ts";
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
import { createRepo } from "./helpers.ts";

async function pathExists(candidate: string) {
  return fs.access(candidate).then(() => true, () => false);
}

async function writeArtifact(repo: string, relative: string) {
  const target = path.join(repo, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "artifact\n");
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

test("ignored fingerprint skips file, symlink, and directory children that disappear after readdir", async (t) => {
  const roots: string[] = [];
  t.after(async () => {
    setDeletionFingerprintTestHookForTesting(undefined);
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

    setDeletionFingerprintTestHookForTesting({
      afterDirectoryRead: async () => {
        await fs.rm(child, { recursive: true, force: true });
      },
    });

    const fingerprint = await collectIgnoredFileFingerprint(root, ["ignored/"]);

    assert.deepEqual(fingerprint, [{ path: "ignored", kind: "directory" }]);
  }
});

test("Guardian plan and apply preserve a raced ignored worktree and reject reappearing content", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(async () => {
    setDeletionFingerprintTestHookForTesting(undefined);
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
  setDeletionFingerprintTestHookForTesting({
    beforeLstat: async (absolutePath) => {
      if (!hookRan && absolutePath.endsWith("vanished.log")) {
        hookRan = true;
        await fs.rm(vanishedChild, { force: true });
      }
    },
  });

  const plan = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId, deleteBranch: false, allowIgnoredFiles: true, config: DEFAULT_CONFIG });

  setDeletionFingerprintTestHookForTesting(undefined);
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

test("hygiene cleanup apply blocks stale tokens when approved target contents change", async () => {
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, "librarian-stale"), { recursive: true });
  await fs.writeFile(path.join(repo, "librarian-stale", "file.txt"), "original\n");
  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", cleanupPaths: ["librarian-stale"] });
  assert.equal(plan.status, "planned");

  await fs.writeFile(path.join(repo, "librarian-stale", "file.txt"), "replaced\n");
  const apply = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "apply", cleanupPaths: ["librarian-stale"], confirmToken: plan.confirmToken });

  assert.equal(apply.ok, false);
  assert.equal(apply.status, "blocked");
  assert.match(String(apply.reason), /confirm token mismatch/);
  assert.equal(await pathExists(path.join(repo, "librarian-stale")), true);
});

test("hygiene cleanup blocks dirty nested git repositories even when category is explicitly allowed", async () => {
  const repo = await createRepo();
  const nested = path.join(repo, "research-clone");
  await fs.mkdir(nested, { recursive: true });
  await git(nested, ["init", "-b", "main"]);
  await git(nested, ["config", "user.email", "guardian@example.test"]);
  await git(nested, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(nested, "README.md"), "nested\n");
  await git(nested, ["add", "README.md"]);
  await git(nested, ["commit", "-m", "nested initial"]);
  await fs.writeFile(path.join(nested, "dirty.txt"), "dirty\n");

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", cleanupPaths: ["research-clone"], allowCategories: ["nested-git"] });

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.equal((plan.blockers as Array<Record<string, unknown>>).some((blocker) => /dirty nested Git/.test(String(blocker.reason)) && blocker.fatal === true), true);
  assert.equal(await pathExists(nested), true);
});

test("hygiene cleanup can explicitly plan dirty nested git repositories", async () => {
  const repo = await createRepo();
  const nested = path.join(repo, "guardian-dirty-trash");
  await fs.mkdir(nested, { recursive: true });
  await git(nested, ["init", "-b", "main"]);
  await git(nested, ["config", "user.email", "guardian@example.test"]);
  await git(nested, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(nested, "README.md"), "nested\n");
  await git(nested, ["add", "README.md"]);
  await git(nested, ["commit", "-m", "nested initial"]);
  await fs.writeFile(path.join(nested, "dirty.txt"), "dirty\n");

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", cleanupPaths: ["guardian-dirty-trash"], allowCategories: ["nested-git"], allowDirtyNestedGit: true });

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.deepEqual((plan.targets as Array<Record<string, unknown>>).map((target) => target.path), ["guardian-dirty-trash"]);
});

test("hygiene cleanup applies dirty nested git repositories with the explicit override", async () => {
  const repo = await createRepo();
  const nested = path.join(repo, "guardian-dirty-apply");
  await fs.mkdir(nested, { recursive: true });
  await git(nested, ["init", "-b", "main"]);
  await git(nested, ["config", "user.email", "guardian@example.test"]);
  await git(nested, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(nested, "README.md"), "nested\n");
  await git(nested, ["add", "README.md"]);
  await git(nested, ["commit", "-m", "nested initial"]);
  await fs.writeFile(path.join(nested, "dirty.txt"), "dirty\n");

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", cleanupPaths: ["guardian-dirty-apply"], allowCategories: ["nested-git"], allowDirtyNestedGit: true });
  assert.equal(plan.status, "planned");

  const apply = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "apply", cleanupPaths: ["guardian-dirty-apply"], allowCategories: ["nested-git"], allowDirtyNestedGit: true, confirmToken: plan.confirmToken });

  assert.equal(apply.ok, true);
  assert.equal(apply.status, "cleaned");
  assert.deepEqual((apply.removedTargets as Array<Record<string, unknown>>).map((target) => target.path), ["guardian-dirty-apply"]);
  assert.equal(await pathExists(nested), false);
});

test("hygiene cleanup removes file targets and fingerprints symlinked contents", async () => {
  const repo = await createRepo();
  await fs.writeFile(path.join(repo, "node-compile-cache"), "cache-blob\n");
  await writeArtifact(repo, "librarian-linked/file.txt");
  await fs.symlink("file.txt", path.join(repo, "librarian-linked", "link"));

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan" });

  assert.equal(plan.status, "planned");
  const targets = plan.targets as Array<Record<string, unknown>>;
  assert.deepEqual(targets.map((target) => [target.path, target.kind]), [["librarian-linked", "directory"], ["node-compile-cache", "file"]]);
  const linkedFingerprint = targets[0].fingerprint as Array<Record<string, unknown>>;
  assert.equal(linkedFingerprint.some((entry) => entry.kind === "symlink" && entry.target === "file.txt"), true);

  const apply = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "apply", confirmToken: plan.confirmToken });

  assert.equal(apply.status, "cleaned");
  assert.equal(await pathExists(path.join(repo, "node-compile-cache")), false);
  assert.equal(await pathExists(path.join(repo, "librarian-linked")), false);
});

test("hygiene cleanup blocks an allowed same-path finding when its dirty nested Git finding is denied", async () => {
  const repo = await createRepo();
  const parent = "guardian-same-path";
  await fs.mkdir(path.join(repo, parent), { recursive: true });
  await fs.writeFile(path.join(repo, parent, "marker.txt"), "artifact\n");
  const nested = path.join(repo, parent, "checkout");
  await fs.mkdir(nested, { recursive: true });
  await git(nested, ["init", "-b", "main"]);
  await git(nested, ["config", "user.email", "guardian@example.test"]);
  await git(nested, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(nested, "README.md"), "nested\n");
  await git(nested, ["add", "README.md"]);
  await git(nested, ["commit", "-m", "nested initial"]);
  await fs.writeFile(path.join(nested, "dirty.txt"), "dirty\n");

  const scan = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });
  const categories = (scan.findings as Array<Record<string, unknown>>)
    .filter((finding) => finding.path === parent)
    .map((finding) => finding.category)
    .sort();
  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", cleanupPaths: [parent], allowCategories: ["suspicious"] });

  assert.deepEqual(categories, ["nested-git", "suspicious"]);
  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.deepEqual(pathsFromRecords(plan.targets), []);
  assert.equal(hasFatalBlocker(plan.blockers, (blocker) => blocker.path === parent && blocker.category === "nested-git" && /not allowed/.test(String(blocker.reason))), true);
  assert.equal(await pathExists(path.join(repo, parent)), true);
});
