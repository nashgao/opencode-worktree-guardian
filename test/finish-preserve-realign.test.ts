import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianFinish } from "../src/finish.ts";
import { guardianStart } from "../src/start.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

async function fixture() {
  const origin = await createRepoWithOrigin();
  const { repo } = origin;
  await fs.mkdir(path.join(repo, ".claude"));
  await fs.writeFile(path.join(repo, ".claude/state.json"), "original\n");
  await git(repo, ["add", ".claude/state.json"]);
  await fs.writeFile(path.join(repo, ".gitignore"), ".claude/\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "track state before ignoring parent"]);
  await git(repo, ["push", "origin", "main"]);
  const config = { ...DEFAULT_CONFIG, finishMode: "merge-to-base" };
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "preserve-realign", taskName: "realign", createWorktree: true, config });
  const worktree = started.session.worktree_path;
  await fs.writeFile(path.join(worktree, "feature.txt"), "reviewed feature\n");
  await git(worktree, ["add", "feature.txt"]);
  await git(worktree, ["commit", "-m", "reviewed feature"]);
  const featureHead = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  await fs.writeFile(path.join(repo, "local-only.txt"), "preserve local history\n");
  await git(repo, ["add", "local-only.txt"]);
  await git(repo, ["commit", "-m", "local divergent history"]);
  const localHead = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  const nested = path.join(repo, "scratch", "registered");
  await git(repo, ["worktree", "add", "--detach", nested, localHead]);
  await fs.writeFile(path.join(nested, "nested-dirty.txt"), "do not touch\n");
  await fs.writeFile(path.join(repo, ".claude/state.json"), "local state\n");
  await fs.writeFile(path.join(repo, "notes.txt"), "local notes\n");
  return { ...origin, config, worktree, featureHead, localHead, nested };
}

test("native Codex adapter preserves and realigns through the public finish command", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.base, { recursive: true, force: true }));
  const adapter = fileURLToPath(new URL("../codex/hooks/guardian-hook.ts", import.meta.url));
  const args = { repoRoot: f.repo, cwd: f.worktree, sessionId: "preserve-realign", config: f.config, allowMergeToBase: true, allowBaseWorktreePreserveReset: true, allowBaseBranchRealign: true, expectedBaseHead: f.localHead };
  const result = await promisify(execFile)(process.execPath, [adapter, "tool", "guardian_finish", JSON.stringify(args)], { cwd: f.worktree });
  assert.match(result.stdout, /\[GOOD\] guardian_finish merged/);
  assert.equal((await git(f.repo, ["rev-parse", "main"])).stdout, f.featureHead);
  assert.equal((await git(f.repo, ["ls-remote", "origin", "refs/heads/main"])).stdout.split("\t")[0], f.featureHead);
  assert.equal(await fs.readFile(path.join(f.nested, "nested-dirty.txt"), "utf8"), "do not touch\n");
  const dirtRef = (await git(f.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode-guardian/"])).stdout.split("\n").find((ref) => ref.includes("preserved-dirt"));
  assert.ok(dirtRef);
  assert.equal((await git(f.repo, ["show", `${dirtRef}:.claude/state.json`])).stdout, "local state");
});

test("finish preserves ignored tracked dirt and registered worktrees while explicitly realigning divergent main", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.base, { recursive: true, force: true }));
  const nestedStatus = (await git(f.nested, ["status", "--porcelain=v1"])).stdout;

  const result = await guardianFinish({ repoRoot: f.repo, cwd: f.worktree, sessionId: "preserve-realign", config: f.config, allowMergeToBase: true, allowBaseWorktreePreserveReset: true, allowBaseBranchRealign: true, expectedBaseHead: f.localHead });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "merged");
  assert.equal((await git(f.repo, ["rev-parse", "main"])).stdout, f.featureHead);
  assert.equal((await git(f.repo, ["ls-remote", "origin", "refs/heads/main"])).stdout.split("\t")[0], f.featureHead);
  assert.equal((await git(f.nested, ["status", "--porcelain=v1"])).stdout, nestedStatus);
  assert.equal(await fs.readFile(path.join(f.nested, "nested-dirty.txt"), "utf8"), "do not touch\n");
  assert.equal((await git(f.nested, ["rev-parse", "HEAD"])).stdout, f.localHead);
  const refs = result.preflight.baseWorktreeSafetyRefs;
  assert.ok(Array.isArray(refs));
  const dirtRef = refs.find((ref: unknown) => typeof ref === "string" && ref.includes("preserved-dirt"));
  const headRef = refs.find((ref: unknown) => typeof ref === "string" && ref.includes("base-branch-head"));
  assert.equal(typeof dirtRef, "string");
  assert.equal(typeof headRef, "string");
  assert.equal((await git(f.repo, ["show", `${dirtRef}:.claude/state.json`])).stdout, "local state");
  assert.equal((await git(f.repo, ["show", `${dirtRef}:notes.txt`])).stdout, "local notes");
  assert.equal((await git(f.repo, ["rev-parse", String(headRef)])).stdout, f.localHead);
  assert.equal(result.preflight.baseBranchRealigned, true);
  assert.equal(result.cleaned, false);
});

for (const permission of ["missing", "stale-head"] as const) {
  test(`finish blocks divergent main before cleaning dirt when realignment approval is ${permission}`, async (t) => {
    const f = await fixture();
    t.after(() => fs.rm(f.base, { recursive: true, force: true }));
    const status = (await git(f.repo, ["status", "--porcelain=v1"])).stdout;

    const result = await guardianFinish({ repoRoot: f.repo, cwd: f.worktree, sessionId: "preserve-realign", config: f.config, allowMergeToBase: true, allowBaseWorktreePreserveReset: true, ...(permission === "stale-head" ? { allowBaseBranchRealign: true, expectedBaseHead: f.featureHead } : {}) });

    assert.equal(result.ok, false);
    assert.match(String(result.reason), /realign|expected.*head/i);
    assert.equal((await git(f.repo, ["rev-parse", "HEAD"])).stdout, f.localHead);
    assert.equal((await git(f.repo, ["status", "--porcelain=v1"])).stdout, status);
    assert.equal(await fs.readFile(path.join(f.repo, ".claude/state.json"), "utf8"), "local state\n");
  });
}

for (const collision of ["registered-worktree", "ignored-file"] as const) {
  test(`finish blocks incoming ${collision} collisions before preserving or clearing primary dirt`, async (t) => {
    const f = await fixture();
    t.after(() => fs.rm(f.base, { recursive: true, force: true }));
    if (collision === "registered-worktree") {
      await fs.mkdir(path.join(f.worktree, "scratch", "registered"), { recursive: true });
      await fs.writeFile(path.join(f.worktree, "scratch", "registered", "incoming.txt"), "must not write into another worktree\n");
      await git(f.worktree, ["add", "scratch/registered/incoming.txt"]);
      await git(f.worktree, ["commit", "-m", "colliding incoming path"]);
    } else {
      await fs.appendFile(path.join(f.repo, ".git", "info", "exclude"), "\nfeature.txt\n");
      await fs.writeFile(path.join(f.repo, "feature.txt"), "ignored local file\n");
    }
    const status = (await git(f.repo, ["status", "--porcelain=v1"])).stdout;
    const result = await guardianFinish({ repoRoot: f.repo, cwd: f.worktree, sessionId: "preserve-realign", config: f.config, allowMergeToBase: true, allowBaseWorktreePreserveReset: true, allowBaseBranchRealign: true, expectedBaseHead: f.localHead });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(String(result.reason), /registered worktree|ignored untracked path/);
    assert.equal(result.preflight.baseWorktreePreserveReset, false);
    assert.equal((await git(f.repo, ["rev-parse", "HEAD"])).stdout, f.localHead);
    assert.equal((await git(f.repo, ["status", "--porcelain=v1"])).stdout, status);
    assert.equal(await fs.readFile(path.join(f.repo, ".claude/state.json"), "utf8"), "local state\n");
    assert.equal(await fs.readFile(path.join(f.nested, "nested-dirty.txt"), "utf8"), "do not touch\n");
    if (collision === "ignored-file") assert.equal(await fs.readFile(path.join(f.repo, "feature.txt"), "utf8"), "ignored local file\n");
  });
}
