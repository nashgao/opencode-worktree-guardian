import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { scanWorkspaceHygiene } from "../src/hygiene.ts";
import { createRepo } from "./helpers.ts";

test("hygiene scanner inventories filesystem-only empty directories without scanning protected paths", async () => {
  // Given
  const repo = await createRepo();
  const emptyPaths = [
    "node-compile-cache-coverage-run-1",
    "go-build-cache",
    "space-shadow-session",
    "TestRunGuardedShadowSnapshot_case",
  ];
  await Promise.all(emptyPaths.map((relative) => fs.mkdir(path.join(repo, relative))));
  await fs.mkdir(path.join(repo, ".agent-state", "space-shadow-protected"), { recursive: true });

  // When
  const result = await scanWorkspaceHygiene({
    repoRoot: repo,
    config: { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths, ".agent-state"] },
  });

  // Then
  assert.equal(result.ok, true);
  assert.equal(result.summary.filesystemOnlyEmptyDirectoryCount, 4);
  assert.equal(result.summary.filesystemOnlyEmptyDirectoryScanComplete, true);
  assert.deepEqual(
    result.filesystemOnlyEmptyDirectories.map((entry) => entry.path),
    [...emptyPaths].sort((left, right) => left.localeCompare(right)),
  );
  assert.deepEqual(
    result.filesystemOnlyEmptyDirectories.map((entry) => entry.classification),
    ["known-cleanable", "known-cleanable", "known-cleanable", "known-cleanable"],
  );
  assert.equal(
    result.filesystemOnlyEmptyDirectories.some((entry) => entry.path.startsWith(".agent-state")),
    false,
  );
});
