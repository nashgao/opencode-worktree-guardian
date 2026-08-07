import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { executeQuarantine } from "../src/quarantine-execute.ts";
import { nextOperationTransition, normalizeQuarantineFingerprint, quarantineOperationPaths } from "../src/quarantine-evidence.ts";
import { readQuarantineItem, readQuarantineOperation, writeQuarantineOperationTransition } from "../src/quarantine-journal.ts";
import { resumeIncompleteQuarantineOperations } from "../src/quarantine-resume.ts";
import { buildDirtySessionDoneIntent } from "../src/done-intent.ts";
import { getGuardianPaths } from "../src/state.ts";
import { guardianStart } from "../src/start.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

const enabledConfig = { ...DEFAULT_CONFIG, goal: { ...DEFAULT_CONFIG.goal, quarantineSessionResidue: true } };

async function startSessionWithResidue(sessionId: string, residueContent: string) {
  const { base, repo } = await createRepoWithOrigin();
  await fs.writeFile(path.join(repo, ".gitignore"), ".completion-cache/\n", "utf8");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore completion cache"]);
  await git(repo, ["push", "origin", "main"]);
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: sessionId, createWorktree: true, config: enabledConfig });
  assert.equal(started.ok, true, JSON.stringify(started));
  const worktree = String(started.session.worktree_path);
  const relativePath = ".completion-cache/residue.txt";
  await fs.mkdir(path.dirname(path.join(worktree, relativePath)), { recursive: true });
  await fs.writeFile(path.join(worktree, relativePath), residueContent, "utf8");
  const intent = await buildDirtySessionDoneIntent({ cwd: worktree, worktreePath: worktree });
  const paths = await getGuardianPaths(repo);
  const manifestDigest = String((started.session.provenance as { manifest?: { digest?: string } } | undefined)?.manifest?.digest);
  return { base, repo, worktree, relativePath, paths, session: started.session, manifestDigest, doneIntentDigest: intent.digest };
}

test("executeQuarantine moves residue into the quarantine holding area and journals a committed item", async (t) => {
  const { base, repo, worktree, relativePath, paths, session, manifestDigest, doneIntentDigest } = await startSessionWithResidue("ses_execute_happy_path", "residue\n");
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const result = await executeQuarantine({ paths, repoRoot: repo, config: enabledConfig, session, relativePath, manifestDigest, doneIntentDigest });

  await assert.rejects(fs.access(path.join(worktree, relativePath)));
  assert.equal(await fs.readFile(result.artifactPath, "utf8"), "residue\n");
  const item = await readQuarantineItem({ paths, quarantineId: result.quarantineId });
  assert.equal(item?.record.state, "available");
  const operation = await readQuarantineOperation({ paths, operationId: result.operationId });
  assert.equal(operation?.record.phase, "committed");
});

test("resumeIncompleteQuarantineOperations completes a quarantine crashed between prepared and the physical rename", async (t) => {
  const { base, repo, worktree, relativePath, paths, session, manifestDigest, doneIntentDigest } = await startSessionWithResidue("ses_resume_after_prepared", "crash-after-prepared\n");
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const quarantineId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const locations = quarantineOperationPaths(paths, { action: "quarantine", quarantineId, operationId, originalWorktreePath: worktree, originalRelativePath: relativePath });
  const fingerprint = normalizeQuarantineFingerprint(await import("../src/deletion-fingerprint.ts").then((module) => module.collectCleanupFingerprint(locations.sourceRoot, locations.source)));
  const fingerprintDigest = crypto.createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
  await writeQuarantineOperationTransition({
    paths,
    record: {
      quarantineId, operationId, action: "quarantine", phase: "prepared",
      sessionId: String(session.session_id), lineageId: String(session.lineage_id),
      originalRelativePath: relativePath, originalWorktreePath: worktree,
      artifactPath: locations.artifact, fingerprint, fingerprintDigest,
      manifestDigest, doneIntentDigest,
      guardianStateRevision: 1, sessionRevision: 1,
      deviceId: (await fs.stat(worktree)).dev, nonce: crypto.randomUUID(), createdAt: new Date().toISOString(),
    },
  });

  // Crashed here: the journal says "prepared" but the physical rename never happened. The
  // residue must still be sitting in the worktree at this point.
  assert.equal(await fs.readFile(path.join(worktree, relativePath), "utf8"), "crash-after-prepared\n");

  const outcomes = await resumeIncompleteQuarantineOperations(paths);
  assert.deepEqual(outcomes, [{ operationId, status: "resolved" }]);

  await assert.rejects(fs.access(path.join(worktree, relativePath)));
  assert.equal(await fs.readFile(locations.artifact, "utf8"), "crash-after-prepared\n");
  const item = await readQuarantineItem({ paths, quarantineId });
  assert.equal(item?.record.state, "available");
  const operation = await readQuarantineOperation({ paths, operationId });
  assert.equal(operation?.record.phase, "committed");
});

test("resumeIncompleteQuarantineOperations completes a quarantine crashed between the physical rename and the renamed journal write", async (t) => {
  const { base, repo, worktree, relativePath, paths, session, manifestDigest, doneIntentDigest } = await startSessionWithResidue("ses_resume_after_rename", "crash-after-rename\n");
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const quarantineId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const locations = quarantineOperationPaths(paths, { action: "quarantine", quarantineId, operationId, originalWorktreePath: worktree, originalRelativePath: relativePath });
  const { collectCleanupFingerprint } = await import("../src/deletion-fingerprint.ts");
  const fingerprint = normalizeQuarantineFingerprint(await collectCleanupFingerprint(locations.sourceRoot, locations.source));
  const fingerprintDigest = crypto.createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
  const recordBase = {
    quarantineId, operationId, action: "quarantine" as const,
    sessionId: String(session.session_id), lineageId: String(session.lineage_id),
    originalRelativePath: relativePath, originalWorktreePath: worktree,
    artifactPath: locations.artifact, fingerprint, fingerprintDigest,
    manifestDigest, doneIntentDigest,
    guardianStateRevision: 1, sessionRevision: 1,
    deviceId: (await fs.stat(worktree)).dev, nonce: crypto.randomUUID(), createdAt: new Date().toISOString(),
  };
  const prepared = await writeQuarantineOperationTransition({ paths, record: { ...recordBase, phase: "prepared" } });
  await fs.mkdir(path.dirname(locations.artifact), { recursive: true });
  await fs.rename(path.join(worktree, relativePath), locations.artifact);

  // Crashed here: the physical rename already succeeded but the "renamed" journal write never
  // happened, so the journal still says "prepared" even though the source is now gone.
  await assert.rejects(fs.access(path.join(worktree, relativePath)));

  const outcomes = await resumeIncompleteQuarantineOperations(paths);
  assert.deepEqual(outcomes, [{ operationId, status: "resolved" }]);

  assert.equal(await fs.readFile(locations.artifact, "utf8"), "crash-after-rename\n");
  const item = await readQuarantineItem({ paths, quarantineId });
  assert.equal(item?.record.state, "available");
  const operation = await readQuarantineOperation({ paths, operationId });
  assert.equal(operation?.record.phase, "committed");
  assert.notEqual(operation?.record.predecessorDigest, prepared.digest); // renamed hop happened in between, not a direct prepared->committed jump
});

test("resumeIncompleteQuarantineOperations completes a quarantine crashed between the physical rename and the item/commit journal writes", async (t) => {
  const { base, repo, worktree, relativePath, paths, session, manifestDigest, doneIntentDigest } = await startSessionWithResidue("ses_resume_after_renamed_phase", "crash-after-renamed-phase\n");
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const quarantineId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const locations = quarantineOperationPaths(paths, { action: "quarantine", quarantineId, operationId, originalWorktreePath: worktree, originalRelativePath: relativePath });
  const { collectCleanupFingerprint } = await import("../src/deletion-fingerprint.ts");
  const fingerprint = normalizeQuarantineFingerprint(await collectCleanupFingerprint(locations.sourceRoot, locations.source));
  const fingerprintDigest = crypto.createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
  const recordBase = {
    quarantineId, operationId, action: "quarantine" as const,
    sessionId: String(session.session_id), lineageId: String(session.lineage_id),
    originalRelativePath: relativePath, originalWorktreePath: worktree,
    artifactPath: locations.artifact, fingerprint, fingerprintDigest,
    manifestDigest, doneIntentDigest,
    guardianStateRevision: 1, sessionRevision: 1,
    deviceId: (await fs.stat(worktree)).dev, nonce: crypto.randomUUID(), createdAt: new Date().toISOString(),
  };
  const prepared = await writeQuarantineOperationTransition({ paths, record: { ...recordBase, phase: "prepared" } });
  await fs.mkdir(path.dirname(locations.artifact), { recursive: true });
  await fs.rename(path.join(worktree, relativePath), locations.artifact);
  const renamed = await writeQuarantineOperationTransition({ paths, record: nextOperationTransition(prepared, "renamed") });

  // Crashed here: the "renamed" journal phase is recorded, but neither the item's "available"
  // transition nor the operation's own "committed" record were ever written.
  const outcomes = await resumeIncompleteQuarantineOperations(paths);
  assert.deepEqual(outcomes, [{ operationId, status: "resolved" }]);

  const item = await readQuarantineItem({ paths, quarantineId });
  assert.equal(item?.record.state, "available");
  const operation = await readQuarantineOperation({ paths, operationId });
  assert.equal(operation?.record.phase, "committed");
  assert.equal(operation?.record.predecessorDigest, renamed.digest);
});
