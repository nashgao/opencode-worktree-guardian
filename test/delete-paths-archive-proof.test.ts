import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDeletePaths } from "../src/delete-paths.ts";
import { createRepo, createTempDir } from "./helpers.ts";

const execFileAsync = promisify(execFile);

async function fileSHA256(filePath: string): Promise<string> {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true, () => false);
}

test("guardian_delete_paths removes a protected file only when an external archive matches it exactly", async (t) => {
  // Given a configured protected file and an external byte-identical recovery archive.
  const repo = await createRepo();
  const archiveRoot = await createTempDir("guardian-protected-archive-");
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  t.after(() => fs.rm(archiveRoot, { recursive: true, force: true }));
  const relativePath = ".omo/resolved/redundant.tar.gz";
  await fs.mkdir(path.join(repo, ".omo", "resolved"), { recursive: true });
  await fs.writeFile(path.join(repo, relativePath), "redundant archive\n");
  const archivePath = path.join(archiveRoot, "protected-recovery.tar.gz");
  await execFileAsync("tar", ["-C", repo, "-czf", archivePath, relativePath]);
  const archiveSha256 = await fileSHA256(archivePath);
  const config = { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths, ".omo"] };

  // When Guardian plans and applies deletion with the exact recovery archive digest.
  const plan = await guardianDeletePaths({ repoRoot: repo, config, mode: "plan", paths: [relativePath], archivePath, archiveSha256 });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const result = await guardianDeletePaths({
    repoRoot: repo,
    config,
    mode: "apply",
    paths: [relativePath],
    archivePath,
    archiveSha256,
    confirmDelete: true,
    confirmToken: plan.confirmToken,
  });

  // Then only the protected file is removed and its external recovery remains unchanged.
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "deleted");
  assert.equal(await pathExists(path.join(repo, relativePath)), false);
  assert.equal(await fileSHA256(archivePath), archiveSha256);
});
