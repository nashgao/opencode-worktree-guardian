import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianStatus } from "../src/recover.ts";
import { createRepo } from "./helpers.ts";

test("guardian_status excludes the primary checkout from worktrees without state through path aliases", { skip: process.platform === "win32" }, async () => {
  const repo = await createRepo();
  const repoAlias = path.join(path.dirname(repo), `${path.basename(repo)}-alias`);
  await fs.symlink(repo, repoAlias, "dir");

  const status = await guardianStatus({ repoRoot: repoAlias, config: DEFAULT_CONFIG });

  assert.deepEqual(status.worktreesWithoutState, []);
});
