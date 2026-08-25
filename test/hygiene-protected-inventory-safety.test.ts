import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianGoal } from "../src/goal.ts";
import { scanWorkspaceHygiene } from "../src/hygiene.ts";
import { buildProtectedInventory, PROTECTED_INVENTORY_MAX_ENTRIES_PER_ROOT, PROTECTED_INVENTORY_MAX_ROOTS } from "../src/hygiene-protected-inventory.ts";
import type { GuardianConfig, RecordLike } from "../src/types.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepo, createRepoWithOrigin, git } from "./helpers.ts";

function record(value: unknown, name: string): RecordLike {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

function observationOnlyConfig(protectedPath: string): GuardianConfig {
  return {
    ...DEFAULT_CONFIG,
    protectedPaths: [...DEFAULT_CONFIG.protectedPaths, protectedPath],
    goal: {
      ...DEFAULT_CONFIG.goal,
      commitDirty: false,
      landToBase: false,
      pushBase: false,
      cleanupWorktrees: false,
      cleanupBranches: false,
      hygieneCompletion: "no-unprotected-residue",
    },
  };
}

async function configureProtectedFixture(repo: string): Promise<void> {
  await fs.writeFile(path.join(repo, ".gitignore"), ".agent-state/\n", "utf8");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "protect agent state"]);
  await git(repo, ["push", "origin", "main"]);
  await fs.mkdir(path.join(repo, ".agent-state"), { recursive: true });
  await fs.writeFile(path.join(repo, ".agent-state", "state.txt"), "one\n", "utf8");
}

test("protected-only metadata drift does not invalidate guardian_goal authorization", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await configureProtectedFixture(repo);
  const config = observationOnlyConfig(".agent-state");
  const plan = await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config });
  assert.equal(typeof plan.confirmToken, "string", JSON.stringify(plan));

  await fs.writeFile(path.join(repo, ".agent-state", "state.txt"), "protected metadata changed\n", "utf8");
  const applied = await guardianGoal({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken, config });

  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.complete, true, JSON.stringify(applied));
  assert.equal(record(record(applied.hygienePostcondition, "postcondition").protectedInventory, "protected inventory").totalBytes, 27);
});

test("unprotected reviewable drift still invalidates guardian_goal authorization", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await configureProtectedFixture(repo);
  const config = observationOnlyConfig(".agent-state");
  const plan = await guardianGoal({ repoRoot: repo, cwd: repo, mode: "plan", config });
  assert.equal(typeof plan.confirmToken, "string", JSON.stringify(plan));

  await fs.writeFile(path.join(repo, "review-me.txt"), "review\n", "utf8");
  const applied = await guardianGoal({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken, config });

  assert.equal(applied.ok, false, JSON.stringify(applied));
  assert.equal(applied.tokenMatched, false, JSON.stringify(applied));
});

test("tracked configured protected files remain visible in protected inventory", async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "retained.txt"), "retained\n", "utf8");
  await git(repo, ["add", "retained.txt"]);
  await git(repo, ["commit", "-m", "track retained file"]);

  const scan = await scanWorkspaceHygiene({ repoRoot: repo, config: observationOnlyConfig("retained.txt") });

  assert.equal(scan.exclusions.some((entry) => entry.path === "retained.txt" && entry.fileCount === 1 && entry.bytes === 9), true);
});

test("protected inventory caps root result cardinality", async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const seeds = Array.from({ length: PROTECTED_INVENTORY_MAX_ROOTS + 1 }, (_, index) => ({ path: `protected-${String(index).padStart(3, "0")}`, reason: "test protected root" }));
  await Promise.all(seeds.map((seed) => fs.writeFile(path.join(repo, seed.path), "x", "utf8")));

  const inventory = await buildProtectedInventory(repo, seeds);

  assert.equal(inventory.entries.length, PROTECTED_INVENTORY_MAX_ROOTS);
  assert.equal(inventory.summary.rootCount, PROTECTED_INVENTORY_MAX_ROOTS);
  assert.equal(inventory.summary.rootsTruncated, true);
  assert.equal(inventory.summary.bytesTruncated, true);
  assert.equal(inventory.entries.at(-1)?.path, "protected-127");
});

test("protected inventory collapses arbitrary nested protected roots", async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, ".outer", "nested"), { recursive: true });
  await fs.writeFile(path.join(repo, ".outer", "nested", "value.txt"), "value\n", "utf8");

  const inventory = await buildProtectedInventory(repo, [
    { path: ".outer/nested", reason: "inner root" },
    { path: ".outer", reason: "outer root" },
  ]);

  assert.equal(inventory.entries.length, 1);
  assert.equal(inventory.entries[0]?.path, ".outer");
  assert.equal(inventory.summary.fileCount, 1);
  assert.equal(inventory.summary.directoryCount, 2);
});

test("protected inventory caps entries before enumerating a wider directory", async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const root = path.join(repo, ".wide");
  await fs.mkdir(root);
  for (let start = 0; start < PROTECTED_INVENTORY_MAX_ENTRIES_PER_ROOT; start += 250) {
    const count = Math.min(250, PROTECTED_INVENTORY_MAX_ENTRIES_PER_ROOT - start);
    await Promise.all(Array.from({ length: count }, (_, offset) => fs.writeFile(path.join(root, String(start + offset).padStart(5, "0")), "x", "utf8")));
  }

  const inventory = await buildProtectedInventory(repo, [{ path: ".wide", reason: "test wide root" }]);

  assert.equal(inventory.entries[0]?.directoryCount, 1);
  assert.equal(inventory.entries[0]?.fileCount, PROTECTED_INVENTORY_MAX_ENTRIES_PER_ROOT - 1);
  assert.equal(inventory.entries[0]?.bytesTruncated, true);
});

test("protected inventory treats a static symlink as a leaf", async (t) => {
  const repo = await createRepo();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-protected-outside-"));
  t.after(() => Promise.all([fs.rm(repo, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  await fs.writeFile(path.join(outside, "outside.txt"), "outside\n", "utf8");
  await fs.mkdir(path.join(repo, ".agent-state"));
  await fs.symlink(outside, path.join(repo, ".agent-state", "link"), "dir");

  const inventory = await buildProtectedInventory(repo, [{ path: ".agent-state", reason: "test protected root" }]);

  assert.equal(inventory.entries[0]?.directoryCount, 1);
  assert.equal(inventory.entries[0]?.fileCount, 1);
  assert.equal(inventory.entries[0]?.bytesTruncated, false);
});

test("protected inventory fails closed when a directory is swapped for a symlink", async (t) => {
  const repo = await createRepo();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-protected-swap-"));
  t.after(() => Promise.all([fs.rm(repo, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  const protectedRoot = path.join(repo, ".agent-state");
  const originalRoot = path.join(repo, ".agent-state-original");
  await fs.mkdir(protectedRoot);
  await fs.writeFile(path.join(protectedRoot, "inside.txt"), "inside\n", "utf8");
  await fs.writeFile(path.join(outside, "outside.txt"), "outside\n", "utf8");
  let swapped = false;

  await assert.rejects(
    buildProtectedInventory(repo, [{ path: ".agent-state", reason: "test protected root" }], {
      io: {
        lstat: fs.lstat,
        realpath: fs.realpath,
        open: fs.open,
        opendir: async (candidate) => {
          if (!swapped && candidate === protectedRoot) {
            swapped = true;
            await fs.rename(protectedRoot, originalRoot);
            await fs.symlink(outside, protectedRoot, "dir");
          }
          return fs.opendir(candidate);
        },
      },
    }),
    /directory identity changed/,
  );
});
