import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { planCleanCompletion } from "../src/clean-completion.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildDirtySessionDoneIntent } from "../src/done-intent.ts";
import { executeQuarantine } from "../src/quarantine-execute.ts";
import { readQuarantineItem } from "../src/quarantine-journal.ts";
import { getGuardianPaths } from "../src/state.ts";
import { guardianStart } from "../src/start.ts";
import type { GuardianConfig } from "../src/types.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

const ENABLED_CONFIG: GuardianConfig = {
  ...DEFAULT_CONFIG,
  goal: { ...DEFAULT_CONFIG.goal, quarantineSessionResidue: true },
};

async function fixture(sessionId: string) {
  const { base, repo } = await createRepoWithOrigin();
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: sessionId, createWorktree: true, config: ENABLED_CONFIG });
  return { base, repo, paths: await getGuardianPaths(repo), session: started.session, worktree: String(started.session.worktree_path) };
}

async function assertUnstable(input: Awaited<ReturnType<typeof fixture>>, reason: RegExp): Promise<void> {
  const proof = await planCleanCompletion({ repoRoot: input.repo, cwd: input.worktree, config: ENABLED_CONFIG, session: input.session });
  assert.equal(proof.finalProof.status, "unstable", JSON.stringify(proof));
  assert.match(String(proof.finalProof.reason), reason);
}

async function quarantinedFixture(sessionId: string) {
  const { base, repo } = await createRepoWithOrigin();
  await fs.writeFile(path.join(repo, ".gitignore"), ".completion-cache/\n", "utf8");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore quarantine fixture"]);
  await git(repo, ["push", "origin", "main"]);
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: sessionId, createWorktree: true, config: ENABLED_CONFIG });
  const worktree = String(started.session.worktree_path);
  const relativePath = ".completion-cache/residue.txt";
  await fs.mkdir(path.dirname(path.join(worktree, relativePath)), { recursive: true });
  await fs.writeFile(path.join(worktree, relativePath), "residue\n", "utf8");
  const intent = await buildDirtySessionDoneIntent({ cwd: worktree, worktreePath: worktree });
  const paths = await getGuardianPaths(repo);
  const manifestDigest = started.session.provenance?.manifest?.digest;
  if (!manifestDigest) throw new Error("quarantine fixture requires a provenance manifest");
  const quarantined = await executeQuarantine({ paths, repoRoot: repo, config: ENABLED_CONFIG, session: started.session, relativePath, manifestDigest, doneIntentDigest: intent.digest });
  const item = await readQuarantineItem({ paths, quarantineId: quarantined.quarantineId });
  if (!item) throw new Error("quarantine fixture requires a journal item");
  return { base, repo, paths, session: started.session, worktree, item };
}

test("clean-completion proof rejects an unreferenced provenance file", async (t) => {
  const input = await fixture("ses_metadata_provenance");
  t.after(() => fs.rm(input.base, { recursive: true, force: true }));
  await fs.writeFile(path.join(input.paths.provenanceDir, "orphan.json"), "{}\n", "utf8");
  await assertUnstable(input, /unknown Guardian provenance entry/);
});

test("clean-completion proof rejects a leftover lock temporary file", async (t) => {
  const input = await fixture("ses_metadata_lock_temp");
  t.after(() => fs.rm(input.base, { recursive: true, force: true }));
  await fs.writeFile(path.join(input.paths.lockTmpDir, "orphan.tmp"), "orphan\n", "utf8");
  await assertUnstable(input, /orphan Guardian lock temporary entry/);
});

test("clean-completion proof rejects an unknown journal subtree", async (t) => {
  const input = await fixture("ses_metadata_journal");
  t.after(() => fs.rm(input.base, { recursive: true, force: true }));
  await fs.mkdir(input.paths.journalDir, { recursive: true });
  await fs.writeFile(path.join(input.paths.journalDir, "orphan"), "orphan\n", "utf8");
  await assertUnstable(input, /unknown Guardian journal entry/);
});

test("clean-completion proof rejects an unreferenced quarantine item", async (t) => {
  const input = await fixture("ses_metadata_quarantine");
  t.after(() => fs.rm(input.base, { recursive: true, force: true }));
  const orphan = path.join(input.paths.quarantineDir, "items", "orphan", "payload");
  await fs.mkdir(orphan, { recursive: true });
  await fs.writeFile(path.join(orphan, "residue.txt"), "orphan\n", "utf8");
  await assertUnstable(input, /unknown Guardian quarantine item/);
});

test("clean-completion proof rejects a missing referenced provenance manifest", async (t) => {
  const input = await fixture("ses_metadata_missing_provenance");
  t.after(() => fs.rm(input.base, { recursive: true, force: true }));
  const relativePath = input.session.provenance?.manifest?.relativePath;
  if (!relativePath) throw new Error("fixture requires a provenance manifest");
  await fs.rm(path.join(input.paths.dir, relativePath));
  await assertUnstable(input, /missing referenced Guardian provenance manifest/);
});

test("clean-completion proof rejects ambiguous lock and quarantine tombstones", async (t) => {
  const input = await fixture("ses_metadata_tombstones");
  t.after(() => fs.rm(input.base, { recursive: true, force: true }));
  await fs.writeFile(path.join(input.paths.lockTombstonesDir, "orphan.json"), "{}\n", "utf8");
  await assertUnstable(input, /ambiguous Guardian lock tombstone/);
  await fs.rm(path.join(input.paths.lockTombstonesDir, "orphan.json"));
  const tombstone = path.join(input.paths.quarantineDir, "tombstones", "orphan", "payload");
  await fs.mkdir(tombstone, { recursive: true });
  await fs.writeFile(path.join(tombstone, "residue.txt"), "orphan\n", "utf8");
  await assertUnstable(input, /orphan Guardian quarantine tombstone/);
});

test("clean-completion proof rejects an unsupported quarantine journal record version", async (t) => {
  const input = await quarantinedFixture("ses_metadata_record_version");
  t.after(() => fs.rm(input.base, { recursive: true, force: true }));
  const target = path.join(input.paths.dir, input.item.relativePath);
  const parsed: unknown = JSON.parse(await fs.readFile(target, "utf8"));
  if (!isRecordLike(parsed)) throw new Error("journal fixture must parse as an object");
  await fs.writeFile(target, `${JSON.stringify({ ...parsed, version: 2 })}\n`, "utf8");
  await assertUnstable(input, /Malformed quarantine journal record/);
});
