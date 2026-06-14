import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { guardianDone } from "../src/done.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

type LooseRecord = Record<string, unknown>;
function asDone(result: LooseRecord) {
  return result as LooseRecord & { status?: unknown; recoveryRef?: unknown; recoveryCommit?: unknown; rescuedFileCount?: unknown };
}

test("guardian_done rescue backs up dirty work and resets recoverably", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "README.md"), "DIRTY tracked change\n");
  await fs.writeFile(path.join(repo, "scratch-note.md"), "untracked junk\n");

  const r = asDone(await guardianDone({ repoRoot: repo, cwd: repo, rescue: true, timestamp: "20260609T060606" }));

  assert.equal(r.status, "rescued");
  assert.match(String(r.recoveryRef), /^refs\/opencode-guardian\/rescue\//);
  assert.equal((await git(repo, ["status", "--porcelain"])).stdout, "");

  await git(repo, ["read-tree", "-u", "--reset", String(r.recoveryCommit)]);
  assert.equal(await fs.readFile(path.join(repo, "README.md"), "utf8"), "DIRTY tracked change\n");
  assert.equal(await fs.readFile(path.join(repo, "scratch-note.md"), "utf8"), "untracked junk\n");
});

test("guardian_done rescue is a no-op on a clean worktree", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const r = asDone(await guardianDone({ repoRoot: repo, cwd: repo, rescue: true }));
  assert.equal(r.status, "rescue-noop");
  assert.equal(r.rescuedFileCount, 0);
});
