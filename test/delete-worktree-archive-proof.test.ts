import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDeleteWorktree } from "../src/delete-worktree.ts";
import { isRecordLike } from "../src/types.ts";
import { createGuardianWorktree, worktreePaths } from "./delete-fixtures.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

const execFileAsync = promisify(execFile);

async function fileSHA256(filePath: string): Promise<string> {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true, () => false);
}

async function createSingleArchivedWorktree(t: TestContext, sessionId: string) {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await createGuardianWorktree(repo, sessionId, sessionId, `guardian/${sessionId}`);
  const worktree = started.session.worktree_path;
  const relativePath = "evidence/report.txt";
  await fs.mkdir(path.join(worktree, "evidence"), { recursive: true });
  await fs.writeFile(path.join(worktree, relativePath), "archived evidence\n");
  const archivePath = path.join(base, `${sessionId}.tar.gz`);
  await execFileAsync("tar", ["-C", worktree, "-czf", archivePath, relativePath]);
  return { archivePath, archiveSha256: await fileSHA256(archivePath), base, relativePath, repo, sessionId, worktree };
}

test("guardian_delete_worktree removes archived untracked and ignored evidence when every path matches", async (t) => {
  // Given a merged Guardian worktree whose only residue is recoverable from an external archive.
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "archive-backed-delete";
  const started = await createGuardianWorktree(repo, sessionId, "archive-backed delete", "guardian/archive-backed-delete");
  const worktree = started.session.worktree_path;
  await fs.writeFile(path.join(worktree, ".gitignore"), "runtime/\n");
  await git(worktree, ["add", ".gitignore"]);
  await git(worktree, ["commit", "-m", "ignore runtime evidence"]);
  await git(worktree, ["push", "origin", "HEAD:main"]);
  const archivedPaths = [
    ".milestones/evidence/report.txt",
    ".milestones/evidence/bootstrap.php",
    "runtime/cache.bin",
  ] as const;
  await fs.mkdir(path.join(worktree, ".milestones", "evidence"), { recursive: true });
  await fs.mkdir(path.join(worktree, "runtime"), { recursive: true });
  await fs.writeFile(path.join(worktree, archivedPaths[0]), "verified evidence\n");
  await fs.symlink("../../README.md", path.join(worktree, archivedPaths[1]));
  await fs.writeFile(path.join(worktree, archivedPaths[2]), "ignored cache\n");
  const archivePath = path.join(base, "archive-backed-delete.tar.gz");
  await execFileAsync("tar", ["-C", worktree, "-czf", archivePath, ...archivedPaths]);
  const archiveSha256 = await fileSHA256(archivePath);

  // When Guardian plans and applies deletion using the exact archive digest.
  const plan = await guardianDeleteWorktree({
    repoRoot: repo,
    cwd: repo,
    mode: "plan",
    sessionId,
    deleteBranch: true,
    allowIgnoredFiles: true,
    archivePath,
    archiveSha256,
    config: { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths, ".milestones"] },
    timestamp: "20260914T020000",
  });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const result = await guardianDeleteWorktree({
    repoRoot: repo,
    cwd: repo,
    mode: "apply",
    sessionId,
    deleteBranch: true,
    allowIgnoredFiles: true,
    archivePath,
    archiveSha256,
    confirmToken: plan.confirmToken,
    config: { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths, ".milestones"] },
    timestamp: "20260914T020000",
  });

  // Then the worktree is gone while the recovery archive remains byte-identical.
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "deleted");
  assert.equal((await worktreePaths(repo)).includes(worktree), false);
  assert.equal(await fileSHA256(archivePath), archiveSha256);
  const preflight = isRecordLike(result.preflight) ? result.preflight : {};
  assert.equal(preflight.archiveSha256, archiveSha256);
  assert.equal(preflight.archivedPathCount, archivedPaths.length);
});

test("guardian_delete_worktree rejects an archive whose digest is not exact", async (t) => {
  // Given a dirty worktree and an archive with a deliberately incorrect expected digest.
  const fixture = await createSingleArchivedWorktree(t, "archive-wrong-digest");

  // When Guardian plans archive-backed deletion.
  const result = await guardianDeleteWorktree({
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    mode: "plan",
    sessionId: fixture.sessionId,
    deleteBranch: true,
    archivePath: fixture.archivePath,
    archiveSha256: "0".repeat(64),
    config: DEFAULT_CONFIG,
  });

  // Then deletion is blocked before the worktree or evidence changes.
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(String(result.reason), /SHA-256/);
  assert.equal((await worktreePaths(fixture.repo)).includes(fixture.worktree), true);
  assert.equal(await pathExists(path.join(fixture.worktree, fixture.relativePath)), true);
});

test("guardian_delete_worktree rejects archive contents that differ from the worktree", async (t) => {
  // Given a valid archive whose source file changes afterward.
  const fixture = await createSingleArchivedWorktree(t, "archive-content-drift");
  await fs.writeFile(path.join(fixture.worktree, fixture.relativePath), "changed evidence\n");

  // When Guardian plans archive-backed deletion.
  const result = await guardianDeleteWorktree({
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    mode: "plan",
    sessionId: fixture.sessionId,
    deleteBranch: true,
    archivePath: fixture.archivePath,
    archiveSha256: fixture.archiveSha256,
    config: DEFAULT_CONFIG,
  });

  // Then the mismatch blocks deletion and preserves the changed file.
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(String(result.reason), /do not exactly match/);
  assert.equal(await fs.readFile(path.join(fixture.worktree, fixture.relativePath), "utf8"), "changed evidence\n");
});

test("guardian_delete_worktree rejects a recovery archive inside the target worktree", async (t) => {
  // Given valid recovery evidence moved inside the worktree that would be deleted.
  const fixture = await createSingleArchivedWorktree(t, "archive-inside-worktree");
  const unsafeArchivePath = path.join(fixture.worktree, "recovery.tar.gz");
  await fs.rename(fixture.archivePath, unsafeArchivePath);

  // When Guardian plans archive-backed deletion.
  const result = await guardianDeleteWorktree({
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    mode: "plan",
    sessionId: fixture.sessionId,
    deleteBranch: true,
    archivePath: unsafeArchivePath,
    archiveSha256: fixture.archiveSha256,
    config: DEFAULT_CONFIG,
  });

  // Then deletion is blocked because recovery would disappear with the target.
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(String(result.reason), /outside the target worktree/);
  assert.equal(await pathExists(unsafeArchivePath), true);
});

test("guardian_delete_worktree rechecks archived paths after creating the safety ref", async (t) => {
  // Given a valid archive-backed deletion plan.
  const fixture = await createSingleArchivedWorktree(t, "archive-late-drift");
  const input = {
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    sessionId: fixture.sessionId,
    deleteBranch: true,
    archivePath: fixture.archivePath,
    archiveSha256: fixture.archiveSha256,
    config: DEFAULT_CONFIG,
    timestamp: "20260914T021500",
  } as const;
  const plan = await guardianDeleteWorktree({ ...input, mode: "plan" });
  assert.equal(plan.ok, true, JSON.stringify(plan));

  // When the evidence changes after the safety ref is created but before cleanup.
  const result = await guardianDeleteWorktree({ ...input, mode: "apply", confirmToken: plan.confirmToken }, {
    afterSafetyRefCreated: async () => {
      await fs.writeFile(path.join(fixture.worktree, fixture.relativePath), "late changed evidence\n");
    },
  });

  // Then Guardian blocks before removing the changed path or worktree.
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(String(result.reason), /do not exactly match/);
  assert.equal((await worktreePaths(fixture.repo)).includes(fixture.worktree), true);
  assert.equal(await fs.readFile(path.join(fixture.worktree, fixture.relativePath), "utf8"), "late changed evidence\n");
});
