import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { clearPreservedPrimaryDirt } from "../src/finish-primary-dirt-reset.ts";
import { snapshotWorktreeDirtCommit } from "../src/git.ts";
import { createRepo, git } from "./helpers.ts";

async function preserve(repo: string, paths: readonly string[]) {
  const parent = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  const snapshot = await snapshotWorktreeDirtCommit(repo, { parentCommit: parent, paths, message: "preserve approved dirt" });
  return { parent, snapshot };
}

test("clear preserves unrelated staged and unstaged changes when removing approved dirt", async (t) => {
  // Given preserved file changes and unrelated work created after preservation.
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "unrelated.txt"), "baseline\n");
  await git(repo, ["add", "unrelated.txt"]);
  await git(repo, ["commit", "-m", "baseline unrelated file"]);
  await fs.writeFile(path.join(repo, "README.md"), "approved\n");
  await fs.writeFile(path.join(repo, "original.txt"), "approved new file\n");
  const paths = ["README.md", "original.txt"];
  const { parent, snapshot } = await preserve(repo, paths);
  await fs.writeFile(path.join(repo, "unrelated.txt"), "staged unrelated\n");
  await git(repo, ["add", "unrelated.txt"]);
  await fs.writeFile(path.join(repo, "unrelated.txt"), "unstaged unrelated\n");
  await fs.writeFile(path.join(repo, "later.txt"), "later untracked\n");

  // When only the preserved dirt is cleared.
  await clearPreservedPrimaryDirt(repo, parent, snapshot, paths);

  // Then unrelated work and HEAD remain unchanged.
  assert.equal(await fs.readFile(path.join(repo, "README.md"), "utf8"), "initial\n");
  await assert.rejects(fs.access(path.join(repo, "original.txt")));
  assert.equal(await fs.readFile(path.join(repo, "unrelated.txt"), "utf8"), "unstaged unrelated\n");
  assert.equal((await git(repo, ["show", ":unrelated.txt"])).stdout, "staged unrelated");
  assert.equal(await fs.readFile(path.join(repo, "later.txt"), "utf8"), "later untracked\n");
  assert.equal((await git(repo, ["rev-parse", "HEAD"])).stdout, parent);
});

test("clear refuses changed preserved content before restoring any paths", async (t) => {
  // Given preserved content that changed again before clearing.
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "README.md"), "approved\n");
  await fs.writeFile(path.join(repo, "new.txt"), "approved new\n");
  const paths = ["README.md", "new.txt"];
  const { parent, snapshot } = await preserve(repo, paths);
  await fs.writeFile(path.join(repo, "new.txt"), "subsequent work\n");
  const indexBefore = await fs.readFile(path.join(repo, ".git/index"));

  // When clearing is attempted, then content drift blocks all mutation.
  await assert.rejects(clearPreservedPrimaryDirt(repo, parent, snapshot, paths));
  assert.equal(await fs.readFile(path.join(repo, "README.md"), "utf8"), "approved\n");
  assert.equal(await fs.readFile(path.join(repo, "new.txt"), "utf8"), "subsequent work\n");
  assert.deepEqual(await fs.readFile(path.join(repo, ".git/index")), indexBefore);
});

test("clear restores staged deletions and removes staged additions", async (t) => {
  // Given staged additions and deletions already represented in the snapshot.
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.unlink(path.join(repo, "README.md"));
  await fs.writeFile(path.join(repo, "staged-new.txt"), "staged addition\n");
  await git(repo, ["add", "--all"]);
  const paths = ["README.md", "staged-new.txt"];
  const { parent, snapshot } = await preserve(repo, paths);

  // When the preserved dirty paths are cleared.
  await clearPreservedPrimaryDirt(repo, parent, snapshot, paths);

  // Then the original tree is restored without moving HEAD.
  assert.equal(await fs.readFile(path.join(repo, "README.md"), "utf8"), "initial\n");
  await assert.rejects(fs.access(path.join(repo, "staged-new.txt")));
  assert.equal((await git(repo, ["status", "--porcelain"])).stdout, "");
  assert.equal((await git(repo, ["rev-parse", "HEAD"])).stdout, parent);
});

test("clear refuses a moved HEAD before changing approved content", async (t) => {
  // Given preservation tied to an earlier HEAD.
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "README.md"), "approved\n");
  const { parent, snapshot } = await preserve(repo, ["README.md"]);
  await git(repo, ["commit", "--allow-empty", "-m", "concurrent commit"]);
  const currentHead = (await git(repo, ["rev-parse", "HEAD"])).stdout;

  // When clearing is attempted, then the newer HEAD and dirty content remain untouched.
  await assert.rejects(clearPreservedPrimaryDirt(repo, parent, snapshot, ["README.md"]));
  assert.equal((await git(repo, ["rev-parse", "HEAD"])).stdout, currentHead);
  assert.equal(await fs.readFile(path.join(repo, "README.md"), "utf8"), "approved\n");
});

test("clear refuses a missing new file before restoring remaining paths", async (t) => {
  // Given a preserved untracked file that has disappeared.
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "README.md"), "approved\n");
  await fs.writeFile(path.join(repo, "new.txt"), "approved new\n");
  const paths = ["README.md", "new.txt"];
  const { parent, snapshot } = await preserve(repo, paths);
  await fs.unlink(path.join(repo, "new.txt"));

  // When clearing is attempted, then the incomplete preservation match blocks mutation.
  await assert.rejects(clearPreservedPrimaryDirt(repo, parent, snapshot, paths));
  assert.equal(await fs.readFile(path.join(repo, "README.md"), "utf8"), "approved\n");
});

test("clear refuses directory replacement before recursively capturing or deleting new work", async (t) => {
  // Given a preserved file replaced by a directory of later work.
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "original.txt"), "approved new\n");
  const { parent, snapshot } = await preserve(repo, ["original.txt"]);
  await fs.unlink(path.join(repo, "original.txt"));
  await fs.mkdir(path.join(repo, "original.txt"));
  await fs.writeFile(path.join(repo, "original.txt/later.txt"), "later work\n");

  // When clearing is attempted, then the directory and its contents are retained.
  await assert.rejects(clearPreservedPrimaryDirt(repo, parent, snapshot, ["original.txt"]));
  assert.equal(await fs.readFile(path.join(repo, "original.txt/later.txt"), "utf8"), "later work\n");
});

test("clear interprets approved untracked paths literally", async (t) => {
  // Given a literal wildcard filename and unrelated matching work.
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "*.txt"), "approved\n");
  const { parent, snapshot } = await preserve(repo, ["*.txt"]);
  await fs.writeFile(path.join(repo, "other.txt"), "unrelated\n");

  // When the approved filename is cleared.
  await clearPreservedPrimaryDirt(repo, parent, snapshot, ["*.txt"]);

  // Then the unrelated matching file remains.
  await assert.rejects(fs.access(path.join(repo, "*.txt")));
  assert.equal(await fs.readFile(path.join(repo, "other.txt"), "utf8"), "unrelated\n");
});
