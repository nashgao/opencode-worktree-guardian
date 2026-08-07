import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { guardianGc } from "../src/gc.ts";
import { captureProvenanceManifest, readProvenanceManifest } from "../src/provenance.ts";
import { getGuardianPaths } from "../src/state.ts";
import type { ExternalRecordReference } from "../src/types.ts";
import { createRepo, git, seedSession } from "./helpers.ts";

function manifestInput(repo: string, sessionId = "ses_provenance") {
  return {
    enabled: true,
    repoRoot: repo,
    worktreePath: repo,
    sessionId,
    lineageId: "lineage_provenance",
    createdAt: "2026-08-05T12:00:00.000Z",
  };
}

function requireReference(reference: ExternalRecordReference | undefined): ExternalRecordReference {
  if (!reference) throw new TypeError("enabled capture must return a provenance reference");
  return reference;
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

test("disabled provenance capture is a no-op", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);

  const reference = await captureProvenanceManifest({
    enabled: false,
    repoRoot: repo,
    worktreePath: repo,
    sessionId: "ses_disabled",
    lineageId: "lineage_disabled",
  });

  assert.equal(reference, undefined);
  assert.match(paths.provenanceDir, /\.git\/opencode-guardian\/provenance$/);
  assert.match(paths.quarantineDir, /\.git\/opencode-guardian\/quarantine$/);
  assert.match(paths.journalDir, /\.git\/opencode-guardian\/journal$/);
  await assert.rejects(() => fs.access(paths.dir), { code: "ENOENT" });
});

test("enabled provenance capture writes a deterministic digest-verified manifest", async () => {
  const repo = await createRepo();
  await fs.writeFile(path.join(repo, ".gitignore"), "ignored/\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore provenance fixture"]);
  await fs.mkdir(path.join(repo, "ignored"));
  await fs.writeFile(path.join(repo, "ignored", "output.txt"), "generated\n");
  await fs.writeFile(path.join(repo, "untracked.txt"), "local\n");

  const input = manifestInput(repo);
  const first = requireReference(await captureProvenanceManifest(input));
  const second = requireReference(await captureProvenanceManifest(input));
  const record = await readProvenanceManifest({ ...input, reference: first });

  assert.deepEqual(second, first);
  assert.match(first.relativePath, /^provenance\/[0-9a-f]{64}\.json$/);
  assert.match(first.digest, /^[0-9a-f]{64}$/);
  assert.equal(record.sessionId, input.sessionId);
  assert.equal(record.lineageId, input.lineageId);
  assert.deepEqual(record.inventory.map((entry) => entry.relativePath), ["ignored", "ignored/output.txt", "untracked.txt"]);
});

test("provenance inventory preserves newline and unicode paths and fingerprints symlinks as links", { skip: process.platform === "win32" }, async () => {
  const repo = await createRepo();
  await fs.writeFile(path.join(repo, ".gitignore"), "ignored/\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore provenance unicode fixture"]);
  const ignored = path.join(repo, "ignored");
  const unicode = "cafe-\u00e9.txt";
  const newline = "line\nbreak.txt";
  await fs.mkdir(ignored);
  await fs.writeFile(path.join(ignored, unicode), "unicode\n");
  await fs.writeFile(path.join(ignored, newline), "newline\n");
  await fs.symlink(unicode, path.join(ignored, "linked"));

  const input = manifestInput(repo, "ses_unicode");
  const reference = requireReference(await captureProvenanceManifest(input));
  const record = await readProvenanceManifest({ ...input, reference });

  assert.equal(record.inventory.some((entry) => entry.relativePath === `ignored/${unicode}`), true);
  assert.equal(record.inventory.some((entry) => entry.relativePath === `ignored/${newline}`), true);
  assert.equal(record.inventory.some((entry) => entry.relativePath === "ignored/linked" && entry.kind === "symlink"), true);
});

test("provenance reads reject changed content and unknown versions without overwriting collisions", async () => {
  const repo = await createRepo();
  const input = manifestInput(repo, "ses_mutated");
  const reference = requireReference(await captureProvenanceManifest(input));
  const paths = await getGuardianPaths(repo);
  const manifestPath = path.join(paths.dir, reference.relativePath);
  const original = await fs.readFile(manifestPath, "utf8");

  await fs.writeFile(manifestPath, `${original}changed\n`);
  await assert.rejects(() => readProvenanceManifest({ ...input, reference }), /digest/);
  await assert.rejects(() => captureProvenanceManifest(input), /overwrite/);
  assert.equal(await fs.readFile(manifestPath, "utf8"), `${original}changed\n`);

  const unknownVersion = JSON.stringify({ ...JSON.parse(original), version: 2 });
  const unknownReference = { ...reference, digest: sha256(unknownVersion) };
  await fs.writeFile(manifestPath, unknownVersion);
  await assert.rejects(() => readProvenanceManifest({ ...input, reference: unknownReference }), /unsupported version/);

  const malformedInventory = JSON.stringify({ ...JSON.parse(original), inventory: [{ relativePath: "../escape", kind: "file", fingerprint: "0".repeat(64) }] });
  await fs.writeFile(manifestPath, malformedInventory);
  await assert.rejects(() => readProvenanceManifest({ ...input, reference: { ...reference, digest: sha256(malformedInventory) } }), /malformed inventory/);
});

test("provenance reads reject identity drift and symlinked metadata ancestors", { skip: process.platform === "win32" }, async () => {
  const repo = await createRepo();
  const input = manifestInput(repo, "ses_identity");
  const reference = requireReference(await captureProvenanceManifest(input));
  const paths = await getGuardianPaths(repo);
  const content = await fs.readFile(path.join(paths.dir, reference.relativePath), "utf8");
  const foreign = await createRepo();
  const foreignPaths = await getGuardianPaths(foreign);
  const foreignManifest = path.join(foreignPaths.dir, reference.relativePath);
  await fs.mkdir(path.dirname(foreignManifest), { recursive: true });
  await fs.writeFile(foreignManifest, content);

  await assert.rejects(() => readProvenanceManifest({ ...input, repoRoot: foreign, worktreePath: foreign, reference }), /identity/);

  const symlinkRepo = await createRepo();
  const symlinkPaths = await getGuardianPaths(symlinkRepo);
  const external = path.join(path.dirname(symlinkRepo), "provenance-external");
  await fs.mkdir(external, { recursive: true });
  await fs.symlink(external, symlinkPaths.dir, "dir");
  await assert.rejects(() => captureProvenanceManifest(manifestInput(symlinkRepo, "ses_symlink")), /symlink/);
});

test("record-only GC preserves referenced provenance metadata", async () => {
  const repo = await createRepo();
  const input = manifestInput(repo, "ses_gc");
  const reference = requireReference(await captureProvenanceManifest(input));
  const paths = await getGuardianPaths(repo);
  const manifestPath = path.join(paths.dir, reference.relativePath);
  const before = await fs.readFile(manifestPath, "utf8");
  await seedSession(repo, {
    session_id: input.sessionId,
    status: "deleted",
    branch: "guardian/gc",
    worktree_path: repo,
    provenance: { manifest: reference },
    updated_at: "2000-01-01T00:00:00.000Z",
  });

  const plan = await guardianGc({ repoRoot: repo, mode: "plan" });
  const apply = await guardianGc({ repoRoot: repo, mode: "apply", confirmDelete: true, confirmToken: plan.confirmToken });

  assert.equal(apply.status, "pruned");
  assert.equal(await fs.readFile(manifestPath, "utf8"), before);
});
