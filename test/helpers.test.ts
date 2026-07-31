import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectIgnoredFileFingerprint, setDeletionFingerprintTestHookForTesting } from "../src/deletion-fingerprint.ts";
import { stagedPaths, worktreeIndexPath } from "../src/done-land-clean-commit.ts";
import { createRepo, createRepoWithOrigin, createTempDir, git } from "./helpers.ts";

function isSameOrInside(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function withProjectTempEnv<T>(callback: () => Promise<T>) {
  const original = {
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
  };
  const projectRoot = await fs.realpath(process.cwd());
  process.env.TMPDIR = projectRoot;
  process.env.TMP = projectRoot;
  process.env.TEMP = projectRoot;
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function assertOutsideProject(candidate: string) {
  const projectRoot = await fs.realpath(process.cwd());
  const realCandidate = await fs.realpath(candidate);
  assert.equal(isSameOrInside(realCandidate, projectRoot), false, `${realCandidate} must be outside ${projectRoot}`);
}

test("createTempDir stays outside the project when TMPDIR points at the project", async (t) => {
  const directory = await withProjectTempEnv(() => createTempDir("guardian-helper-regression-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assertOutsideProject(directory);
});

test("createRepo stays outside the project when TMPDIR points at the project", async (t) => {
  const repo = await withProjectTempEnv(() => createRepo());
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await assertOutsideProject(repo);
});

test("createRepoWithOrigin stays outside the project when TMPDIR points at the project", async (t) => {
  const { base, repo, remote } = await withProjectTempEnv(() => createRepoWithOrigin());
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await assertOutsideProject(base);
  await assertOutsideProject(repo);
  await assertOutsideProject(remote);
});

test("ignored fingerprints skip file, symlink, and directory children that disappear after readdir", async (t) => {
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

test("ignored fingerprints omit roots and entries that disappear at every lstat boundary", async (t) => {
  const roots: string[] = [];
  t.after(async () => {
    setDeletionFingerprintTestHookForTesting(undefined);
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  for (const kind of ["root", "symlink", "directory", "file"] as const) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-deletion-fingerprint-"));
    roots.push(root);
    const entry = path.join(root, "ignored");
    if (kind === "symlink") {
      const target = path.join(root, "target");
      await fs.writeFile(target, "generated\n");
      await fs.symlink(target, entry);
    } else if (kind === "directory" || kind === "root") {
      await fs.mkdir(entry);
      await fs.writeFile(path.join(entry, "child"), "generated\n");
    } else await fs.writeFile(entry, "generated\n");

    setDeletionFingerprintTestHookForTesting({
      beforeLstat: async (absolutePath) => {
        if (kind === "root" && absolutePath === entry) await fs.rm(entry, { recursive: true, force: true });
      },
      afterLstat: async (absolutePath) => {
        if (kind !== "root" && absolutePath === entry) await fs.rm(entry, { recursive: true, force: true });
      },
    });

    const fingerprint = await collectIgnoredFileFingerprint(root, ["ignored"]);

    assert.deepEqual(fingerprint, []);
  }
});

test("fingerprints rethrow non-ENOENT errors and malformed ignored inventory", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-deletion-fingerprint-"));
  t.after(async () => {
    setDeletionFingerprintTestHookForTesting(undefined);
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, "ignored"), "generated\n");

  for (const code of ["EACCES", "EIO"] as const) {
    setDeletionFingerprintTestHookForTesting({
      beforeLstat: () => {
        throw Object.assign(new Error(code), { code });
      },
    });
    await assert.rejects(() => collectIgnoredFileFingerprint(root, ["ignored"]), { code });
  }

  setDeletionFingerprintTestHookForTesting(undefined);
  const malformedIgnoredFiles = { 0: "ignored", length: 1 };
  await assert.rejects(() => Reflect.apply(collectIgnoredFileFingerprint, undefined, [root, malformedIgnoredFiles]), TypeError);
});

test("worktreeIndexPath returns the absolute Git index path", async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const expected = (await git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout;

  const indexPath = await worktreeIndexPath(repo);

  assert.equal(path.isAbsolute(indexPath), true);
  assert.equal(indexPath, expected);
});

test("stagedPaths returns an ordinary staged path", () => {
  assert.deepEqual([...stagedPaths(["M", "ordinary.txt"])], ["ordinary.txt"]);
});

test("stagedPaths returns both rename paths", () => {
  assert.deepEqual([...stagedPaths(["R100", "before.txt", "after.txt"])], ["before.txt", "after.txt"]);
});

test("stagedPaths returns both copy paths", () => {
  assert.deepEqual([...stagedPaths(["C100", "source.txt", "copy.txt"])], ["source.txt", "copy.txt"]);
});
