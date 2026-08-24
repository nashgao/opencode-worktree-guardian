import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { attachPostCompletionHygiene } from "../src/completion-hygiene.ts";
import { createRepo } from "./helpers.ts";

test("post-completion hygiene attaches a complete read-only inventory", async () => {
  // Given
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, "space-shadow-session"));

  // When
  const result = await attachPostCompletionHygiene(
    { ok: true, status: "completed" },
    { repoRoot: repo, config: DEFAULT_CONFIG, mode: "apply" },
  );

  // Then
  assert.equal(result.complete, true);
  assert.equal(result.postCompletionHygiene.status, "satisfied");
  assert.deepEqual(
    result.postCompletionHygiene.inventory.filesystemOnlyEmptyDirectories.map((entry) => entry.path),
    ["space-shadow-session"],
  );
});

test("post-completion hygiene prevents complete status when bounded coverage is incomplete", async () => {
  // Given
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, "one", "two", "three"), { recursive: true });

  // When
  const result = await attachPostCompletionHygiene(
    { ok: true, status: "completed" },
    { repoRoot: repo, config: DEFAULT_CONFIG, mode: "apply", emptyDirectoryMaxEntries: 1 },
  );

  // Then
  assert.equal(result.complete, false);
  assert.equal(result.status, "partial");
  assert.equal(result.postCompletionHygiene.status, "incomplete");
});
