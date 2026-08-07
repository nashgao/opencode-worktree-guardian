import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildDirtySessionDoneIntent } from "../src/done-intent.ts";
import { executePurge, executeQuarantine, executeRestore } from "../src/quarantine-execute.ts";
import { readQuarantineItem, readQuarantineOperation } from "../src/quarantine-journal.ts";
import { getGuardianPaths } from "../src/state.ts";
import { guardianStart } from "../src/start.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

const enabledConfig = { ...DEFAULT_CONFIG, goal: { ...DEFAULT_CONFIG.goal, quarantineSessionResidue: true } };

async function quarantinedResidueFixture(sessionId: string, residueContent: string) {
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
  const quarantined = await executeQuarantine({ paths, repoRoot: repo, config: enabledConfig, session: started.session, relativePath, manifestDigest, doneIntentDigest: intent.digest });
  return { base, repo, worktree, relativePath, paths, session: started.session, quarantined };
}

test("executeRestore moves a quarantined item back into a selected registered worktree", async (t) => {
  const { base, repo, paths, session, quarantined } = await quarantinedResidueFixture("ses_restore_happy_path", "restore-me\n");
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const targetStarted = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_restore_target", taskName: "restore target", createWorktree: true, config: enabledConfig });
  const targetWorktreePath = String(targetStarted.session.worktree_path);

  const result = await executeRestore({ paths, repoRoot: repo, config: enabledConfig, session, quarantineId: quarantined.quarantineId, targetWorktreePath });

  assert.equal(await fs.readFile(path.join(targetWorktreePath, ".completion-cache/residue.txt"), "utf8"), "restore-me\n");
  await assert.rejects(fs.access(quarantined.artifactPath));
  assert.equal(result.restoredPath, path.join(targetWorktreePath, ".completion-cache/residue.txt"));
  const item = await readQuarantineItem({ paths, quarantineId: quarantined.quarantineId });
  assert.equal(item?.record.state, "restored");
  // artifactPath is a frozen identity field pinned to the original quarantine payload location,
  // not a live "current location" pointer -- it stays unchanged across restore/purge so that
  // itemTransitionAllowed's sameIdentity check and crash-recovery both keep working.
  assert.equal(item?.record.artifactPath, quarantined.artifactPath);
  const operation = await readQuarantineOperation({ paths, operationId: result.operationId });
  assert.equal(operation?.record.phase, "committed");
  assert.equal(operation?.record.action === "restore" ? operation.record.targetWorktreePath : undefined, targetWorktreePath);
});

test("executeRestore refuses to restore into the primary repository worktree", async (t) => {
  const { base, repo, paths, session, quarantined } = await quarantinedResidueFixture("ses_restore_primary_blocked", "no-primary-restore\n");
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  await assert.rejects(
    executeRestore({ paths, repoRoot: repo, config: enabledConfig, session, quarantineId: quarantined.quarantineId, targetWorktreePath: repo }),
    /restore target is the primary repository worktree/,
  );
  const item = await readQuarantineItem({ paths, quarantineId: quarantined.quarantineId });
  assert.equal(item?.record.state, "available", "a blocked restore must leave the quarantined item untouched");
});

test("executePurge tombstones then permanently removes a quarantined item", async (t) => {
  const { base, paths, quarantined } = await quarantinedResidueFixture("ses_purge_happy_path", "purge-me\n");
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const result = await executePurge({ paths, quarantineId: quarantined.quarantineId });

  await assert.rejects(fs.access(quarantined.artifactPath));
  await assert.rejects(fs.access(result.tombstonePath));
  const item = await readQuarantineItem({ paths, quarantineId: quarantined.quarantineId });
  assert.equal(item?.record.state, "purged");
  const operation = await readQuarantineOperation({ paths, operationId: result.operationId });
  assert.equal(operation?.record.phase, "committed");
});
