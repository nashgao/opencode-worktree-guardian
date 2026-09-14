import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { setArchivedPathRemovalTestHookForTesting } from "../src/archived-path-removal.ts";
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
  assert.equal((await fs.readdir(path.dirname(worktree))).some((entry) => entry.startsWith(".guardian-archive-quarantine-")), false);
});

test("guardian_delete_worktree archive proof does not authorize tracked modifications", async (t) => {
  // Given a tracked file modified in an otherwise removable Guardian worktree and an archive matching its new bytes.
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "archive-tracked-modification";
  const started = await createGuardianWorktree(repo, sessionId, sessionId, `guardian/${sessionId}`);
  const worktree = started.session.worktree_path;
  await fs.writeFile(path.join(worktree, "README.md"), "tracked change must remain blocked\n");
  const archivePath = path.join(base, `${sessionId}.tar.gz`);
  await execFileAsync("tar", ["-C", worktree, "-czf", archivePath, "README.md"]);
  const archiveSha256 = await fileSHA256(archivePath);

  // When archive-backed worktree deletion is planned without the redundant-dirty proof path.
  const result = await guardianDeleteWorktree({
    repoRoot: repo,
    cwd: repo,
    mode: "plan",
    sessionId,
    deleteBranch: true,
    archivePath,
    archiveSha256,
    config: DEFAULT_CONFIG,
  });

  // Then the archive cannot weaken the established tracked-change blocker.
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(String(result.reason), /untracked and ignored paths/);
  assert.equal((await worktreePaths(repo)).includes(worktree), true);
  assert.equal(await fs.readFile(path.join(worktree, "README.md"), "utf8"), "tracked change must remain blocked\n");
});

test("guardian_delete_worktree archive proof does not authorize staged changes or renames", async (t) => {
  // Given two worktrees with tracked changes in staged and rename states and matching archives.
  const staged = await createSingleArchivedWorktree(t, "archive-staged-change");
  await fs.writeFile(path.join(staged.worktree, "README.md"), "staged change must remain blocked\n");
  await git(staged.worktree, ["add", "README.md"]);
  const stagedArchivePath = path.join(staged.base, "staged-source.tar.gz");
  await execFileAsync("tar", ["-C", staged.worktree, "-czf", stagedArchivePath, "README.md", staged.relativePath]);
  const renamed = await createSingleArchivedWorktree(t, "archive-rename-change");
  await git(renamed.worktree, ["mv", "README.md", "RENAMED.md"]);
  const renamedArchivePath = path.join(renamed.base, "renamed-source.tar.gz");
  await execFileAsync("tar", ["-C", renamed.worktree, "-czf", renamedArchivePath, "RENAMED.md", renamed.relativePath]);

  // When archive-backed deletion is planned for each tracked status.
  const stagedResult = await guardianDeleteWorktree({
    repoRoot: staged.repo,
    cwd: staged.repo,
    mode: "plan",
    sessionId: staged.sessionId,
    deleteBranch: true,
    archivePath: stagedArchivePath,
    archiveSha256: await fileSHA256(stagedArchivePath),
    config: DEFAULT_CONFIG,
  });
  const renamedResult = await guardianDeleteWorktree({
    repoRoot: renamed.repo,
    cwd: renamed.repo,
    mode: "plan",
    sessionId: renamed.sessionId,
    deleteBranch: true,
    archivePath: renamedArchivePath,
    archiveSha256: await fileSHA256(renamedArchivePath),
    config: DEFAULT_CONFIG,
  });

  // Then both plans block without removing either worktree.
  assert.equal(stagedResult.ok, false, JSON.stringify(stagedResult));
  assert.match(String(stagedResult.reason), /untracked and ignored paths/);
  assert.equal(renamedResult.ok, false, JSON.stringify(renamedResult));
  assert.match(String(renamedResult.reason), /untracked and ignored paths/);
  assert.equal((await worktreePaths(staged.repo)).includes(staged.worktree), true);
  assert.equal((await worktreePaths(renamed.repo)).includes(renamed.worktree), true);
});

test("guardian_delete_worktree blocks a symlink-ancestor substitution at the removal boundary", async (t) => {
  // Given an approved archive whose worktree parent is replaced by a symlink to matching outside data after safety-ref creation.
  const fixture = await createSingleArchivedWorktree(t, "archive-symlink-ancestor-race");
  const outsideRoot = path.join(fixture.base, "outside");
  await fs.mkdir(outsideRoot, { recursive: true });
  await fs.writeFile(path.join(outsideRoot, "report.txt"), "archived evidence\n");
  const plan = await guardianDeleteWorktree({
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    mode: "plan",
    sessionId: fixture.sessionId,
    deleteBranch: true,
    archivePath: fixture.archivePath,
    archiveSha256: fixture.archiveSha256,
    config: DEFAULT_CONFIG,
  });
  assert.equal(plan.ok, true, JSON.stringify(plan));

  // When apply reaches the safety-ref boundary and the parent is substituted.
  const result = await guardianDeleteWorktree({
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    mode: "apply",
    sessionId: fixture.sessionId,
    deleteBranch: true,
    archivePath: fixture.archivePath,
    archiveSha256: fixture.archiveSha256,
    confirmToken: plan.confirmToken,
    config: DEFAULT_CONFIG,
  }, {
    async afterSafetyRefCreated() {
      await fs.rename(path.join(fixture.worktree, "evidence"), path.join(fixture.worktree, "original-evidence"));
      await fs.symlink(outsideRoot, path.join(fixture.worktree, "evidence"));
    },
  });

  // Then Guardian blocks without deleting the outside file reached by that symlink.
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(await fs.readFile(path.join(outsideRoot, "report.txt"), "utf8"), "archived evidence\n");
  assert.equal((await worktreePaths(fixture.repo)).includes(fixture.worktree), true);
});

test("guardian_delete_worktree rechecks source ancestors immediately before rename", async (t) => {
  // Given an attacker substitutes a symlink ancestor after Guardian fingerprints the source but before its last rename check.
  const fixture = await createSingleArchivedWorktree(t, "archive-final-rename-race");
  const outsideRoot = path.join(fixture.base, "outside-final-race");
  await fs.mkdir(outsideRoot, { recursive: true });
  await fs.writeFile(path.join(outsideRoot, "report.txt"), "archived evidence\n");
  const plan = await guardianDeleteWorktree({
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    mode: "plan",
    sessionId: fixture.sessionId,
    deleteBranch: true,
    archivePath: fixture.archivePath,
    archiveSha256: fixture.archiveSha256,
    config: DEFAULT_CONFIG,
  });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  let substituted = false;
  setArchivedPathRemovalTestHookForTesting({
    async beforeRename(source) {
      if (substituted || source !== path.join(fixture.worktree, fixture.relativePath)) return;
      substituted = true;
      await fs.rename(path.join(fixture.worktree, "evidence"), path.join(fixture.worktree, "original-evidence"));
      await fs.symlink(outsideRoot, path.join(fixture.worktree, "evidence"));
    },
  });
  t.after(() => setArchivedPathRemovalTestHookForTesting(undefined));

  // When Guardian performs the final ancestor and inode check immediately before rename.
  const result = await guardianDeleteWorktree({
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    mode: "apply",
    sessionId: fixture.sessionId,
    deleteBranch: true,
    archivePath: fixture.archivePath,
    archiveSha256: fixture.archiveSha256,
    confirmToken: plan.confirmToken,
    config: DEFAULT_CONFIG,
  });

  // Then apply blocks before rename with both the original source and outside object untouched.
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(String(result.reason), /symlink ancestor/);
  const quarantineRoots = (await fs.readdir(path.dirname(fixture.worktree))).filter((entry) => entry.startsWith(".guardian-archive-quarantine-"));
  assert.equal(quarantineRoots.length, 0);
  assert.equal(await fs.readFile(path.join(fixture.worktree, "original-evidence", "report.txt"), "utf8"), "archived evidence\n");
  assert.equal(await fs.readFile(path.join(outsideRoot, "report.txt"), "utf8"), "archived evidence\n");
  assert.equal((await worktreePaths(fixture.repo)).includes(fixture.worktree), true);
});

test("guardian_delete_worktree rejects duplicate archive members", async (t) => {
  // Given an archive containing the same requested path twice.
  const fixture = await createSingleArchivedWorktree(t, "archive-duplicate-member");
  const rawArchivePath = path.join(fixture.base, "duplicate-member.tar");
  await execFileAsync("tar", ["-C", fixture.worktree, "-cf", rawArchivePath, fixture.relativePath]);
  await execFileAsync("tar", ["-C", fixture.worktree, "-rf", rawArchivePath, fixture.relativePath]);
  await fs.writeFile(fixture.archivePath, gzipSync(await fs.readFile(rawArchivePath)));

  // When archive-backed deletion is planned.
  const result = await guardianDeleteWorktree({
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    mode: "plan",
    sessionId: fixture.sessionId,
    deleteBranch: true,
    archivePath: fixture.archivePath,
    archiveSha256: await fileSHA256(fixture.archivePath),
    config: DEFAULT_CONFIG,
  });

  // Then the structurally ambiguous archive is rejected.
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(String(result.reason), /duplicate archive member/);
  assert.equal((await worktreePaths(fixture.repo)).includes(fixture.worktree), true);
});

test("guardian_delete_worktree rejects hardlink archive members", async (t) => {
  // Given two requested worktree paths archived as hardlinks to the same inode.
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "archive-hardlink-member";
  const started = await createGuardianWorktree(repo, sessionId, sessionId, `guardian/${sessionId}`);
  const worktree = started.session.worktree_path;
  await fs.mkdir(path.join(worktree, "evidence"), { recursive: true });
  await fs.writeFile(path.join(worktree, "evidence", "first.txt"), "same inode\n");
  await fs.link(path.join(worktree, "evidence", "first.txt"), path.join(worktree, "evidence", "second.txt"));
  const archivePath = path.join(base, `${sessionId}.tar.gz`);
  await execFileAsync("tar", ["-C", worktree, "-czf", archivePath, "evidence/first.txt", "evidence/second.txt"]);

  // When archive-backed deletion is planned.
  const result = await guardianDeleteWorktree({
    repoRoot: repo,
    cwd: repo,
    mode: "plan",
    sessionId,
    deleteBranch: true,
    archivePath,
    archiveSha256: await fileSHA256(archivePath),
    config: DEFAULT_CONFIG,
  });

  // Then hardlink recovery semantics are rejected rather than treated as two ordinary files.
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(String(result.reason), /hardlink archive member/);
  assert.equal((await worktreePaths(repo)).includes(worktree), true);
});

test("guardian_delete_worktree never resolves tar from caller-controlled PATH", async (t) => {
  // Given a valid archive and a hostile PATH entry containing an executable named tar.
  const fixture = await createSingleArchivedWorktree(t, "archive-hostile-path");
  const fakeBin = path.join(fixture.base, "fake-bin");
  const marker = path.join(fixture.base, "hostile-tar-ran");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(path.join(fakeBin, "tar"), `#!/bin/sh\nprintf invoked > '${marker}'\nexit 97\n`);
  await fs.chmod(path.join(fakeBin, "tar"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  // When archive-backed deletion performs inventory and extraction.
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

  // Then Guardian uses a pinned system executable and never invokes the hostile PATH entry.
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(await pathExists(marker), false);
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

test("guardian_delete_worktree restores quarantined paths when the external archive changes", async (t) => {
  // Given a planned archive-backed deletion whose external archive changes after the exact paths are quarantined.
  const fixture = await createSingleArchivedWorktree(t, "archive-finalize-drift");
  const plan = await guardianDeleteWorktree({
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    mode: "plan",
    sessionId: fixture.sessionId,
    deleteBranch: true,
    archivePath: fixture.archivePath,
    archiveSha256: fixture.archiveSha256,
    config: DEFAULT_CONFIG,
  });
  assert.equal(plan.ok, true, JSON.stringify(plan));

  // When apply observes archive replacement immediately before finalizing removal.
  const result = await guardianDeleteWorktree({
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    mode: "apply",
    sessionId: fixture.sessionId,
    deleteBranch: true,
    archivePath: fixture.archivePath,
    archiveSha256: fixture.archiveSha256,
    confirmToken: plan.confirmToken,
    config: DEFAULT_CONFIG,
  }, {
    async afterArchivedPathsQuarantined() {
      await fs.writeFile(fixture.archivePath, "changed archive\n");
    },
  });

  // Then apply blocks and restores the exact source path instead of completing deletion without recovery.
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(String(result.reason), /external archive changed/);
  assert.equal(await fs.readFile(path.join(fixture.worktree, fixture.relativePath), "utf8"), "archived evidence\n");
  assert.equal((await worktreePaths(fixture.repo)).includes(fixture.worktree), true);
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
