import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { setDeletionFingerprintTestHookForTesting } from "../src/deletion-fingerprint.ts";
import { guardianHygiene, scanWorkspaceHygiene } from "../src/hygiene.ts";
import { createRepo, seedSession } from "./helpers.ts";

test("hygiene scanner inventories filesystem-only empty directories without scanning protected paths", async () => {
  // Given
  const repo = await createRepo();
  const emptyPaths = [
    "node-compile-cache-coverage-run-1",
    "go-build-cache",
    "space-shadow-session",
    "TestRunGuardedShadowSnapshot_case",
  ];
  await Promise.all(emptyPaths.map((relative) => fs.mkdir(path.join(repo, relative))));
  await fs.mkdir(path.join(repo, ".agent-state", "space-shadow-protected"), { recursive: true });

  // When
  const result = await scanWorkspaceHygiene({
    repoRoot: repo,
    config: { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths, ".agent-state"] },
  });

  // Then
  assert.equal(result.ok, true);
  assert.equal(result.summary.filesystemOnlyEmptyDirectoryCount, 4);
  assert.equal(result.summary.filesystemOnlyEmptyDirectoryScanComplete, true);
  assert.deepEqual(
    result.filesystemOnlyEmptyDirectories.map((entry) => entry.path),
    [...emptyPaths].sort((left, right) => left.localeCompare(right)),
  );
  assert.deepEqual(
    result.filesystemOnlyEmptyDirectories.map((entry) => entry.classification),
    ["known-cleanable", "known-cleanable", "known-cleanable", "known-cleanable"],
  );
  assert.equal(
    result.filesystemOnlyEmptyDirectories.some((entry) => entry.path.startsWith(".agent-state")),
    false,
  );
});

test("guardian_hygiene token-gates removal of a generic empty directory tree", async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const emptyRoot = path.join(repo, "scratch", "temporary", "empty");
  await fs.mkdir(emptyRoot, { recursive: true });

  const plan = await guardianHygiene({
    repoRoot: repo,
    cwd: repo,
    config: DEFAULT_CONFIG,
    mode: "plan",
    allowCategories: ["filesystem-only-empty-directory"],
  });

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.status, "planned");
  assert.equal(typeof plan.confirmToken, "string");
  const applied = await guardianHygiene({
    repoRoot: repo,
    cwd: repo,
    config: DEFAULT_CONFIG,
    mode: "apply",
    allowCategories: ["filesystem-only-empty-directory"],
    confirmDelete: true,
    confirmToken: plan.confirmToken,
  });

  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.status, "cleaned");
  await assert.rejects(fs.access(path.join(repo, "scratch")));
});

test("guardian_hygiene rejects an empty-directory plan after content appears", async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const emptyRoot = path.join(repo, "scratch", "empty");
  await fs.mkdir(emptyRoot, { recursive: true });
  const request = {
    repoRoot: repo,
    cwd: repo,
    config: DEFAULT_CONFIG,
    allowCategories: ["filesystem-only-empty-directory"],
  };
  const plan = await guardianHygiene({ ...request, mode: "plan" });
  await fs.writeFile(path.join(emptyRoot, "appeared.txt"), "keep me\n");

  const applied = await guardianHygiene({
    ...request,
    mode: "apply",
    confirmDelete: true,
    confirmToken: plan.confirmToken,
  });

  assert.equal(applied.ok, false, JSON.stringify(applied));
  assert.equal(applied.status, "blocked");
  assert.equal(await fs.readFile(path.join(emptyRoot, "appeared.txt"), "utf8"), "keep me\n");
});

test("guardian_hygiene canonicalizes a repository alias before cleanup", { skip: process.platform === "win32" }, async (t) => {
  const repo = await createRepo();
  const alias = path.join(path.dirname(repo), `${path.basename(repo)}-alias`);
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  t.after(() => fs.rm(alias, { force: true }));
  await fs.symlink(repo, alias, "dir");
  const cacheRoot = path.join(repo, "node-compile-cache");
  await fs.mkdir(cacheRoot);
  await fs.writeFile(path.join(cacheRoot, "cache.bin"), "cache\n");

  const plan = await guardianHygiene({ repoRoot: alias, cwd: alias, config: DEFAULT_CONFIG, mode: "plan", allowCategories: ["known-cleanable"] });
  const applied = await guardianHygiene({ repoRoot: alias, cwd: alias, config: DEFAULT_CONFIG, mode: "apply", allowCategories: ["known-cleanable"], confirmDelete: true, confirmToken: plan.confirmToken });

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(applied.ok, true, JSON.stringify(applied));
  await assert.rejects(fs.access(cacheRoot));
});

test("guardian_hygiene removes an empty parent after its terminal session worktree is recorded deleted", async (t) => {
  // Given a terminal session whose recorded nested worktree is absent below an empty parent.
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const emptyParent = path.join(repo, "retired-worktree-parent");
  const deletedWorktree = path.join(emptyParent, "src");
  await fs.mkdir(emptyParent);
  await seedSession(repo, {
    session_id: "terminal-empty-parent",
    status: "finished",
    branch: "guardian/terminal-empty-parent",
    worktree_path: deletedWorktree,
    deleted_worktree_path: deletedWorktree,
    head_commit: "1".repeat(40),
    safety_refs: ["refs/opencode-guardian/terminal-empty-parent"],
  });

  // When Guardian plans and applies filesystem-only empty-directory cleanup.
  const request = { repoRoot: repo, cwd: repo, config: DEFAULT_CONFIG, allowCategories: ["filesystem-only-empty-directory"] };
  const plan = await guardianHygiene({ ...request, mode: "plan" });
  const applied = await guardianHygiene({ ...request, mode: "apply", confirmDelete: true, confirmToken: plan.confirmToken });

  // Then stale terminal metadata does not protect an already-absent worktree path.
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(applied.ok, true, JSON.stringify(applied));
  await assert.rejects(fs.access(emptyParent));
});

test("guardian_hygiene returns a structured block when content appears after empty-directory fingerprinting", async (t) => {
  // Given a token-approved empty directory and a deterministic apply-time reappearance.
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  t.after(() => setDeletionFingerprintTestHookForTesting(undefined));
  const emptyRoot = path.join(repo, "hygiene-race-parent");
  await fs.mkdir(emptyRoot);
  const request = { repoRoot: repo, cwd: repo, config: DEFAULT_CONFIG, allowCategories: ["filesystem-only-empty-directory"] };
  const plan = await guardianHygiene({ ...request, mode: "plan" });
  let injected = false;
  setDeletionFingerprintTestHookForTesting({
    afterDirectoryRead: async (absoluteDirectory) => {
      if (injected || absoluteDirectory !== emptyRoot) return;
      injected = true;
      await fs.writeFile(path.join(emptyRoot, "keep.txt"), "keep\n");
    },
  });

  // When the apply boundary tries non-recursive removal after the fingerprint is collected.
  const applied = await guardianHygiene({ ...request, mode: "apply", confirmDelete: true, confirmToken: plan.confirmToken });

  // Then the tool reports the safe refusal and preserves the new content.
  assert.equal(applied.ok, false, JSON.stringify(applied));
  assert.equal(applied.status, "blocked");
  assert.equal(await fs.readFile(path.join(emptyRoot, "keep.txt"), "utf8"), "keep\n");
});
