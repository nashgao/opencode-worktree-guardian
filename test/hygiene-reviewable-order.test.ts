import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildReviewableCandidates } from "../src/hygiene-reviewable.ts";
import { createTempDir } from "./helpers.ts";

test("reviewable ordering stays deterministic across mixed complete and truncated measurements", async (t) => {
  const repo = await createTempDir("guardian-reviewable-order-");
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "a"), "");
  await fs.writeFile(path.join(repo, "c"), "x");
  const truncated = path.join(repo, "b");
  await fs.mkdir(truncated);
  for (let offset = 0; offset < 10_000; offset += 250) {
    await Promise.all(Array.from({ length: 250 }, (_, index) => fs.writeFile(path.join(truncated, `${offset + index}.txt`), "x")));
  }

  const candidates = [
    { path: "a", status: "untracked" as const },
    { path: "b/0.txt", status: "untracked" as const },
    { path: "c", status: "untracked" as const },
  ];
  const forward = await buildReviewableCandidates(repo, candidates, new Set(), null);
  const reversed = await buildReviewableCandidates(repo, [...candidates].reverse(), new Set(), null);
  const paths = (result: typeof forward) => result.reviewableCandidates.map((candidate) => candidate.path);

  assert.deepEqual(paths(forward), ["b", "c", "a"]);
  assert.deepEqual(paths(reversed), paths(forward));
  assert.equal(forward.reviewableCandidates[0]?.bytesTruncated, true);
});
