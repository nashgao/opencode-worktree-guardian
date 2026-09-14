import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { setDeletionFingerprintTestHookForTesting } from "../src/deletion-fingerprint.ts";
import { guardianDeletePaths } from "../src/delete-paths.ts";
import { guardianHygiene } from "../src/hygiene.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepo, seedSession } from "./helpers.ts";

const protectedLifecycleCases = [
  { label: "preserved", status: "preserved", deletedSuffix: "src" },
  { label: "superseded", status: "superseded", deletedSuffix: "src" },
  { label: "mismatched", status: "finished", deletedSuffix: "other-src" },
] as const;

async function seedProtectedParent(repo: string, lifecycleCase: (typeof protectedLifecycleCases)[number]) {
  const parentName = `${lifecycleCase.label}-parent`;
  const parent = path.join(repo, parentName);
  const worktree = path.join(parent, "src");
  await fs.mkdir(parent);
  await seedSession(repo, {
    session_id: `protected-${lifecycleCase.label}`,
    status: lifecycleCase.status,
    branch: `guardian/protected-${lifecycleCase.label}`,
    worktree_path: worktree,
    deleted_worktree_path: path.join(parent, lifecycleCase.deletedSuffix),
    head_commit: "5".repeat(40),
    safety_refs: [],
  });
  return { parent, parentName };
}

test("guardian_delete_paths preserves protected lifecycle records", async (t) => {
  for (const lifecycleCase of protectedLifecycleCases) {
    await t.test(lifecycleCase.label, async (t) => {
      // Given a protected or mismatched terminal record whose worktree path is absent.
      const repo = await createRepo();
      t.after(() => fs.rm(repo, { recursive: true, force: true }));
      const { parent, parentName } = await seedProtectedParent(repo, lifecycleCase);

      // When exact deletion is planned for the empty parent.
      const plan = await guardianDeletePaths({ repoRoot: repo, cwd: repo, config: DEFAULT_CONFIG, mode: "plan", paths: [parentName], allowRecursive: true });

      // Then the registered worktree protection remains fail-closed.
      assert.equal(plan.ok, false, JSON.stringify(plan));
      assert.equal(plan.status, "blocked");
      await fs.access(parent);
    });
  }
});

test("guardian_hygiene excludes protected lifecycle parents from cleanup", async (t) => {
  for (const lifecycleCase of protectedLifecycleCases) {
    await t.test(lifecycleCase.label, async (t) => {
      // Given a protected or mismatched terminal record whose empty parent exists.
      const repo = await createRepo();
      t.after(() => fs.rm(repo, { recursive: true, force: true }));
      const { parent, parentName } = await seedProtectedParent(repo, lifecycleCase);

      // When hygiene plans filesystem-only empty-directory cleanup.
      const plan = await guardianHygiene({ repoRoot: repo, cwd: repo, config: DEFAULT_CONFIG, mode: "plan", allowCategories: ["filesystem-only-empty-directory"] });
      const selectsParent = Array.isArray(plan.targets)
        && plan.targets.some((target) => isRecordLike(target) && target.path === parentName);

      // Then the protected parent is not selected and remains present.
      assert.equal(selectsParent, false, JSON.stringify(plan));
      await fs.access(parent);
    });
  }
});

test("guardian_hygiene blocks when an approved empty target disappears after fingerprinting", async (t) => {
  // Given a token-approved empty directory and a deterministic apply-time disappearance.
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  t.after(() => setDeletionFingerprintTestHookForTesting(undefined));
  const emptyRoot = path.join(repo, "disappearing-empty-parent");
  await fs.mkdir(emptyRoot);
  const request = { repoRoot: repo, cwd: repo, config: DEFAULT_CONFIG, allowCategories: ["filesystem-only-empty-directory"] };
  const plan = await guardianHygiene({ ...request, mode: "plan" });
  let injected = false;
  setDeletionFingerprintTestHookForTesting({
    afterDirectoryRead: async (absoluteDirectory) => {
      if (injected || absoluteDirectory !== emptyRoot) return;
      injected = true;
      await fs.rmdir(emptyRoot);
    },
  });

  // When apply reaches the target after the concurrent removal.
  const applied = await guardianHygiene({ ...request, mode: "apply", confirmDelete: true, confirmToken: plan.confirmToken });

  // Then the race is reported as a structured block instead of a misleading cleanup success.
  assert.equal(applied.ok, false, JSON.stringify(applied));
  assert.equal(applied.status, "blocked");
});
