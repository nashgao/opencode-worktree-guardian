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

test("guardian_delete_paths archive proof does not authorize protected tracked source", async (t) => {
  // Given a configured protected tracked file and an exact external archive matching it.
  const repo = await createRepo();
  const archiveRoot = await createTempDir("guardian-protected-tracked-archive-");
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  t.after(() => fs.rm(archiveRoot, { recursive: true, force: true }));
  const relativePath = ".omo/tracked.txt";
  const absolutePath = path.join(repo, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, "tracked protected source\n");
  await execFileAsync("git", ["-C", repo, "add", "-f", relativePath]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "add protected tracked source"]);
  const archivePath = path.join(archiveRoot, "tracked-protected.tar.gz");
  await execFileAsync("tar", ["-C", repo, "-czf", archivePath, relativePath]);
  const archiveSha256 = await fileSHA256(archivePath);
  const config = { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths, ".omo"] };

  // When exact-path deletion is planned with both tracked consent and archive proof.
  const result = await guardianDeletePaths({ repoRoot: repo, cwd: repo, mode: "plan", paths: [relativePath], allowTracked: true, archivePath, archiveSha256, config });

  // Then archive mode cannot broaden into tracked source deletion.
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(JSON.stringify(result), /supports only untracked or ignored regular files/);
  assert.equal(await fs.readFile(absolutePath, "utf8"), "tracked protected source\n");
});
