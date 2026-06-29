import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildDoneWorkInventory } from "../src/done-work-inventory.ts";
import { resolveDoneTarget } from "../src/done-target-resolver.ts";
import { guardianStart } from "../src/tools.ts";
import { createRepoWithOrigin } from "./helpers.ts";

test("guardian_done target resolver honors explicit session and branch from primary cwd", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_resolve_explicit", taskName: "resolve explicit", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(repo, "primary-dirty.txt"), "primary stays out of this decision\n", "utf8");
  await fs.writeFile(path.join(started.session.worktree_path, "session-dirty.txt"), "session\n", "utf8");
  const inventory = await buildDoneWorkInventory({ repoRoot: repo, cwd: repo, config: DEFAULT_CONFIG });

  const bySession = resolveDoneTarget({ input: { sessionId: "ses_resolve_explicit" }, inventory });
  const byBranch = resolveDoneTarget({ input: { branch: started.session.branch }, inventory });

  assert.equal(bySession.kind, "session-finish");
  assert.equal(bySession.sessionId, "ses_resolve_explicit");
  assert.equal(byBranch.kind, "session-finish");
  assert.equal(byBranch.sessionId, "ses_resolve_explicit");
});

test("guardian_done target resolver auto-selects one dirty target and blocks ambiguous dirt", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const session = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_resolve_dirty", taskName: "resolve dirty", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(session.session.worktree_path, "session-dirty.txt"), "session\n", "utf8");
  const onlySessionDirty = await buildDoneWorkInventory({ repoRoot: repo, cwd: repo, config: DEFAULT_CONFIG });

  const selectedSession = resolveDoneTarget({ input: {}, inventory: onlySessionDirty });
  assert.equal(selectedSession.kind, "session-finish");
  assert.equal(selectedSession.sessionId, "ses_resolve_dirty");

  await fs.writeFile(path.join(repo, "primary-dirty.txt"), "primary\n", "utf8");
  const ambiguousInventory = await buildDoneWorkInventory({ repoRoot: repo, cwd: repo, config: DEFAULT_CONFIG });
  const ambiguous = resolveDoneTarget({ input: {}, inventory: ambiguousInventory });

  assert.equal(ambiguous.kind, "needs-selection");
  assert.equal(ambiguous.status, "needs-selection");
  assert.match(ambiguous.reason, /multiple dirty implementation targets/);
  assert.deepEqual(ambiguous.candidates.map((candidate) => candidate.targetKind).sort(), ["primary", "session"]);
  assert.ok(ambiguous.suggestedCommands.includes("guardian_done primary=true commitMessage=..."));
  assert.ok(ambiguous.suggestedCommands.includes(`guardian_done branch=${session.session.branch} commitMessage=...`));
});

test("guardian_done target resolver keeps clean primary cleanup and done-all behavior", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_resolve_clean", taskName: "resolve clean", createWorktree: true, config: DEFAULT_CONFIG });
  const withCleanSession = await buildDoneWorkInventory({ repoRoot: repo, cwd: repo, config: DEFAULT_CONFIG });
  const doneAll = resolveDoneTarget({ input: {}, inventory: withCleanSession });
  assert.equal(doneAll.kind, "done-all");

  const { base: cleanBase, repo: cleanRepo } = await createRepoWithOrigin();
  t.after(() => fs.rm(cleanBase, { recursive: true, force: true }));
  const cleanInventory = await buildDoneWorkInventory({ repoRoot: cleanRepo, cwd: cleanRepo, config: DEFAULT_CONFIG });
  const cleanupOnly = resolveDoneTarget({ input: {}, inventory: cleanInventory });
  assert.equal(cleanupOnly.kind, "cleanup-only");
});
