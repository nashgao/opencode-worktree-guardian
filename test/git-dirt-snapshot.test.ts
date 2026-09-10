import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DirtSnapshotPathError } from "../src/git-dirt-snapshot.ts";
import { snapshotWorktreeDirtCommit } from "../src/git-process.ts";
import { createRepo, git } from "./helpers.ts";

test("snapshot preserves tracked files under ignored ancestors plus explicit new files without changing the real index", async (t) => {
  // Given tracked content below a subsequently ignored directory and staged unrelated work.
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const tracked = ".claude/stats/commits.json";
  await fs.mkdir(path.dirname(path.join(repo, tracked)), { recursive: true });
  await fs.writeFile(path.join(repo, tracked), "original\n");
  await git(repo, ["add", tracked]);
  await git(repo, ["commit", "-m", "track stats"]);
  await fs.writeFile(path.join(repo, ".gitignore"), ".claude/\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore runtime directory"]);
  const parentCommit = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  await fs.writeFile(path.join(repo, tracked), "preserved\n");
  await fs.writeFile(path.join(repo, "new.txt"), "new content\n");
  await fs.writeFile(path.join(repo, "README.md"), "staged unrelated\n");
  await git(repo, ["add", "README.md"]);
  await fs.writeFile(path.join(repo, "README.md"), "unstaged unrelated\n");
  const indexPath = path.join(repo, ".git/index");
  const indexBefore = await fs.readFile(indexPath);

  // When the explicit dirty paths are snapshotted.
  const commit = await snapshotWorktreeDirtCommit(repo, { parentCommit, paths: [tracked, "new.txt"], message: "preserve dirt" });

  // Then the snapshot contains only requested content, with the live checkout unchanged.
  assert.equal((await git(repo, ["show", `${commit}:${tracked}`])).stdout, "preserved");
  assert.equal((await git(repo, ["show", `${commit}:new.txt`])).stdout, "new content");
  assert.equal((await git(repo, ["show", `${commit}:README.md`])).stdout, "initial");
  assert.equal((await git(repo, ["rev-parse", `${commit}^`])).stdout, parentCommit);
  assert.deepEqual(await fs.readFile(indexPath), indexBefore);
  assert.equal((await git(repo, ["rev-parse", "HEAD"])).stdout, parentCommit);
  assert.equal(await fs.readFile(path.join(repo, tracked), "utf8"), "preserved\n");
  assert.equal(await fs.readFile(path.join(repo, "README.md"), "utf8"), "unstaged unrelated\n");
});

test("snapshot records deletion of a tracked file below an ignored ancestor", async (t) => {
  // Given a deleted tracked file that is now ignored.
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, "ignored"));
  await fs.writeFile(path.join(repo, "ignored/deleted.txt"), "tracked\n");
  await git(repo, ["add", "ignored/deleted.txt"]);
  await git(repo, ["commit", "-m", "track deletable file"]);
  await fs.writeFile(path.join(repo, ".git/info/exclude"), "ignored/\n");
  await fs.unlink(path.join(repo, "ignored/deleted.txt"));
  const parentCommit = (await git(repo, ["rev-parse", "HEAD"])).stdout;

  // When the deletion is snapshotted.
  const commit = await snapshotWorktreeDirtCommit(repo, { parentCommit, paths: ["ignored/deleted.txt"], message: "preserve deletion" });

  // Then the snapshot records exactly that deletion.
  assert.equal((await git(repo, ["diff", "--name-status", parentCommit, commit])).stdout, "D\tignored/deleted.txt");
});

test("snapshot treats pathspec-looking filenames literally", async (t) => {
  // Given literal glob and magic-looking filenames alongside unrelated work.
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const paths = ["*.txt", ":(glob)secret*", "line\nbreak.txt"];
  for (const file of [...paths, "other.txt"]) await fs.writeFile(path.join(repo, file), file);
  const parentCommit = (await git(repo, ["rev-parse", "HEAD"])).stdout;

  // When only the named files are snapshotted.
  const commit = await snapshotWorktreeDirtCommit(repo, { parentCommit, paths, message: "preserve literal names" });

  // Then unrelated matching filenames are excluded.
  for (const file of paths) assert.equal((await git(repo, ["show", `${commit}:${file}`])).stdout, file);
  await assert.rejects(git(repo, ["show", `${commit}:other.txt`]));
});

test("snapshot refuses ignored untracked files without changing the real index", async (t) => {
  // Given an ignored secret and an ordinary requested file.
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, ".git/info/exclude"), "secret.txt\n");
  await fs.writeFile(path.join(repo, "secret.txt"), "secret\n");
  await fs.writeFile(path.join(repo, "ordinary.txt"), "ordinary\n");
  const parentCommit = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  const indexBefore = await fs.readFile(path.join(repo, ".git/index"));

  // When ignored untracked content is requested, then preservation refuses it.
  await assert.rejects(snapshotWorktreeDirtCommit(repo, { parentCommit, paths: ["ordinary.txt", "secret.txt"], message: "must refuse" }), (error: unknown) => error instanceof Error && "gitExitCode" in error && error.gitExitCode === 1);
  assert.deepEqual(await fs.readFile(path.join(repo, ".git/index")), indexBefore);
  assert.equal((await git(repo, ["rev-parse", "HEAD"])).stdout, parentCommit);
  assert.equal(await fs.readFile(path.join(repo, "secret.txt"), "utf8"), "secret\n");
});

test("snapshot refuses directory capture instead of recursively widening the approved paths", async (t) => {
  // Given a directory containing an unlisted file.
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, "directory"));
  await fs.writeFile(path.join(repo, "directory/unlisted.txt"), "must not capture\n");
  const parentCommit = (await git(repo, ["rev-parse", "HEAD"])).stdout;

  // When a directory is requested, then preservation refuses recursive capture.
  await assert.rejects(snapshotWorktreeDirtCommit(repo, { parentCommit, paths: ["directory"], message: "must refuse" }), DirtSnapshotPathError);
});

test("snapshot refuses gitlinks even when their working directory is absent", async (t) => {
  // Given an index-only submodule entry with no working directory.
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const initial = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  await git(repo, ["update-index", "--add", "--cacheinfo", `160000,${initial},module`]);
  await git(repo, ["commit", "-m", "record gitlink"]);
  const parentCommit = (await git(repo, ["rev-parse", "HEAD"])).stdout;

  // When the gitlink is requested, then preservation refuses to treat it as file dirt.
  await assert.rejects(snapshotWorktreeDirtCommit(repo, { parentCommit, paths: ["module"], message: "must refuse" }), DirtSnapshotPathError);
});
