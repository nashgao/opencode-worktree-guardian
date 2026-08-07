import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { collectCleanupFingerprint } from "../src/deletion-fingerprint.ts";
import { getCommonGitDir } from "../src/git.ts";
import { buildQuarantinePathPreflight } from "../src/quarantine-path-preflight.ts";
import type { QuarantinePathPreflightFilesystem } from "../src/quarantine-path-preflight.ts";
import { createGuardianWorktree, createRepoWithOrigin, fs as fixtureFs, git } from "./delete-fixtures.ts";
import { rescueMutationSurface } from "./helpers.ts";

type PathPreflight = Awaited<ReturnType<typeof buildQuarantinePathPreflight>>;

async function quarantineFixture(sessionId: string) {
  const { base, repo } = await createRepoWithOrigin();
  const started = await createGuardianWorktree(repo, sessionId);
  const sourcePath = path.join(started.session.worktree_path, "residue", "artifact.txt");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "artifact\n");
  const commonGitDir = await getCommonGitDir(repo);
  const metadataRoot = path.join(commonGitDir, "opencode-guardian", "quarantine");
  return { base, commonGitDir, metadataRoot, repo, session: started.session, sourcePath };
}

function fatalReasons(result: PathPreflight): readonly string[] {
  return result.blockers.filter((blocker) => blocker.fatal).map((blocker) => blocker.reason);
}

async function expectBlocked(result: Promise<PathPreflight>, reason: RegExp): Promise<void> {
  const preflight = await result;
  assert.equal(preflight.ok, false, JSON.stringify(preflight));
  assert.equal(fatalReasons(preflight).some((candidate) => reason.test(candidate)), true, JSON.stringify(preflight));
}

function mismatchedDevices(destinationParent: string): QuarantinePathPreflightFilesystem {
  return {
    async deviceId(candidate) {
      return path.resolve(candidate) === path.resolve(destinationParent) ? 2 : 1;
    },
  };
}

function unsupportedSource(sourcePath: string): QuarantinePathPreflightFilesystem {
  return {
    async sourceKind(candidate) {
      return path.resolve(candidate) === path.resolve(sourcePath) ? "other" : null;
    },
  };
}

test("quarantine preflight derives a same-device metadata destination without mutating either path", async (t) => {
  const fixture = await quarantineFixture("ses_quarantine_preflight_safe");
  t.after(() => fixtureFs.rm(fixture.base, { recursive: true, force: true }));
  const before = await rescueMutationSurface(fixture.repo, fixture.session.worktree_path);

  const preflight = await buildQuarantinePathPreflight({
    action: "quarantine",
    artifactRelativePath: "ses_quarantine_preflight_safe/item-1",
    config: DEFAULT_CONFIG,
    metadataRoot: fixture.metadataRoot,
    repoRoot: fixture.repo,
    session: fixture.session,
    sourcePath: fixture.sourcePath,
  });

  assert.equal(preflight.ok, true, JSON.stringify(preflight));
  assert.deepEqual(preflight.blockers, []);
  assert.equal(preflight.facts.source.kind, "file");
  assert.equal(preflight.facts.destination.path, path.join(fixture.metadataRoot, "ses_quarantine_preflight_safe", "item-1"));
  assert.equal(await fs.readFile(fixture.sourcePath, "utf8"), "artifact\n");
  assert.equal(await fs.access(preflight.facts.destination.path).then(() => true, () => false), false);
  assert.deepEqual(await rescueMutationSurface(fixture.repo, fixture.session.worktree_path), before);
});

test("quarantine preflight fails closed for source, metadata, destination, and filesystem safety facts", async (t) => {
  const fixture = await quarantineFixture("ses_quarantine_preflight_blockers");
  t.after(() => fixtureFs.rm(fixture.base, { recursive: true, force: true }));
  const baseInput = {
    action: "quarantine" as const,
    artifactRelativePath: "ses_quarantine_preflight_blockers/item-1",
    config: DEFAULT_CONFIG,
    metadataRoot: fixture.metadataRoot,
    repoRoot: fixture.repo,
    session: fixture.session,
    sourcePath: fixture.sourcePath,
  };

  await expectBlocked(buildQuarantinePathPreflight({ ...baseInput, sourcePath: path.join(fixture.session.worktree_path, "missing") }), /source path is missing/);
  await expectBlocked(buildQuarantinePathPreflight({ ...baseInput, artifactRelativePath: "../escape" }), /metadata root/);

  await fs.mkdir(fixture.metadataRoot, { recursive: true });
  await fs.mkdir(path.join(fixture.metadataRoot, "ses_quarantine_preflight_blockers"), { recursive: true });
  await fs.writeFile(path.join(fixture.metadataRoot, "ses_quarantine_preflight_blockers", "item-1"), "collision\n");
  await expectBlocked(buildQuarantinePathPreflight(baseInput), /destination already exists/);

  await fs.rm(path.join(fixture.metadataRoot, "ses_quarantine_preflight_blockers"), { recursive: true, force: true });
  await expectBlocked(buildQuarantinePathPreflight({ ...baseInput, filesystem: mismatchedDevices(fixture.metadataRoot) }), /EXDEV risk/);
  await expectBlocked(buildQuarantinePathPreflight({ ...baseInput, filesystem: unsupportedSource(fixture.sourcePath) }), /unsupported source kind/);
});

test("quarantine preflight blocks protected, tracked, nested-Git, worktree-root, and fingerprint drift sources", async (t) => {
  const fixture = await quarantineFixture("ses_quarantine_preflight_source");
  t.after(() => fixtureFs.rm(fixture.base, { recursive: true, force: true }));
  const baseInput = {
    action: "quarantine" as const,
    artifactRelativePath: "ses_quarantine_preflight_source/item-1",
    config: DEFAULT_CONFIG,
    metadataRoot: fixture.metadataRoot,
    repoRoot: fixture.repo,
    session: fixture.session,
    sourcePath: fixture.sourcePath,
  };

  await git(fixture.session.worktree_path, ["add", "residue/artifact.txt"]);
  await expectBlocked(buildQuarantinePathPreflight(baseInput), /tracked source/);
  await git(fixture.session.worktree_path, ["reset", "--", "residue/artifact.txt"]);

  const protectedPath = path.join(fixture.session.worktree_path, ".beads", "state.json");
  await fs.mkdir(path.dirname(protectedPath), { recursive: true });
  await fs.writeFile(protectedPath, "protected\n");
  await expectBlocked(buildQuarantinePathPreflight({ ...baseInput, sourcePath: protectedPath }), /protected path/);

  const nestedPath = path.join(fixture.session.worktree_path, "residue", "nested");
  await fs.mkdir(nestedPath, { recursive: true });
  await git(nestedPath, ["init", "-b", "main"]);
  await expectBlocked(buildQuarantinePathPreflight({ ...baseInput, sourcePath: path.join(fixture.session.worktree_path, "residue") }), /nested Git/);

  await expectBlocked(buildQuarantinePathPreflight({ ...baseInput, sourcePath: fixture.session.worktree_path }), /registered worktree/);

  const expectedFingerprint = await collectCleanupFingerprint(fixture.session.worktree_path, fixture.sourcePath);
  await fs.writeFile(fixture.sourcePath, "changed\n");
  await expectBlocked(buildQuarantinePathPreflight({ ...baseInput, expectedFingerprint }), /source fingerprint drift/);
});

test("quarantine preflight rejects symlink roots and ancestors without following their escapes", async (t) => {
  const fixture = await quarantineFixture("ses_quarantine_preflight_symlink");
  t.after(() => fixtureFs.rm(fixture.base, { recursive: true, force: true }));
  const outside = path.join(fixture.base, "outside");
  const linkedParent = path.join(fixture.session.worktree_path, "residue-link");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "artifact.txt"), "outside\n");
  await fs.symlink(outside, linkedParent, "dir");

  await expectBlocked(buildQuarantinePathPreflight({
    action: "quarantine",
    artifactRelativePath: "ses_quarantine_preflight_symlink/item-1",
    config: DEFAULT_CONFIG,
    metadataRoot: fixture.metadataRoot,
    repoRoot: fixture.repo,
    session: fixture.session,
    sourcePath: path.join(linkedParent, "artifact.txt"),
  }), /symlink/);

  const metadataLink = path.join(fixture.commonGitDir, "quarantine-link");
  await fs.symlink(outside, metadataLink, "dir");
  await expectBlocked(buildQuarantinePathPreflight({
    action: "quarantine",
    artifactRelativePath: "ses_quarantine_preflight_symlink/item-2",
    config: DEFAULT_CONFIG,
    metadataRoot: metadataLink,
    repoRoot: fixture.repo,
    session: fixture.session,
    sourcePath: fixture.sourcePath,
  }), /symlink|common Git directory/);
});

test("restore preflight derives only a registered same-repository worktree destination", async (t) => {
  const fixture = await quarantineFixture("ses_quarantine_preflight_restore");
  t.after(() => fixtureFs.rm(fixture.base, { recursive: true, force: true }));
  const artifactRelativePath = "ses_quarantine_preflight_restore/item-1";
  const artifactPath = path.join(fixture.metadataRoot, artifactRelativePath);
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, "artifact\n");
  const selectedWorktree = path.join(fixture.base, "selected-worktree");
  await git(fixture.repo, ["worktree", "add", "-b", "guardian/selected-restore", selectedWorktree]);

  const preflight = await buildQuarantinePathPreflight({
    action: "restore",
    artifactRelativePath,
    config: DEFAULT_CONFIG,
    metadataRoot: fixture.metadataRoot,
    originalRelativePath: "restore/output.txt",
    originalWorktreePath: fixture.session.worktree_path,
    repoRoot: fixture.repo,
    session: fixture.session,
    targetWorktreePath: selectedWorktree,
  });

  assert.equal(preflight.ok, true, JSON.stringify(preflight));
  assert.equal(preflight.facts.destination.path, path.join(selectedWorktree, "restore", "output.txt"));
  assert.equal(await fs.readFile(artifactPath, "utf8"), "artifact\n");
});

test("restore preflight rejects arbitrary, primary, detached, colliding, and missing-original targets", async (t) => {
  const fixture = await quarantineFixture("ses_quarantine_preflight_restore_blocked");
  t.after(() => fixtureFs.rm(fixture.base, { recursive: true, force: true }));
  const artifactRelativePath = "ses_quarantine_preflight_restore_blocked/item-1";
  await fs.mkdir(path.join(fixture.metadataRoot, "ses_quarantine_preflight_restore_blocked"), { recursive: true });
  await fs.writeFile(path.join(fixture.metadataRoot, artifactRelativePath), "artifact\n");
  const baseInput = {
    action: "restore" as const,
    artifactRelativePath,
    config: DEFAULT_CONFIG,
    metadataRoot: fixture.metadataRoot,
    originalRelativePath: "restore/output.txt",
    originalWorktreePath: fixture.session.worktree_path,
    repoRoot: fixture.repo,
    session: fixture.session,
  };
  const arbitrary = path.join(fixture.base, "arbitrary");
  await fs.mkdir(arbitrary);

  await expectBlocked(buildQuarantinePathPreflight({ ...baseInput, targetWorktreePath: arbitrary }), /registered Git worktree/);
  await expectBlocked(buildQuarantinePathPreflight({ ...baseInput, originalWorktreePath: arbitrary }), /original worktree/);
  await expectBlocked(buildQuarantinePathPreflight({ ...baseInput, targetWorktreePath: fixture.repo }), /primary repository worktree/);

  const detached = path.join(fixture.base, "detached");
  await git(fixture.repo, ["worktree", "add", "--detach", detached]);
  await expectBlocked(buildQuarantinePathPreflight({ ...baseInput, targetWorktreePath: detached }), /detached/);

  await fs.mkdir(path.join(fixture.session.worktree_path, "restore"), { recursive: true });
  await fs.writeFile(path.join(fixture.session.worktree_path, "restore", "output.txt"), "collision\n");
  await expectBlocked(buildQuarantinePathPreflight(baseInput), /destination already exists/);
});
