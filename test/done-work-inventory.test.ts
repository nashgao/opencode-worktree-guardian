import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildDoneWorkInventory } from "../src/done-work-inventory.ts";
import { guardianStart } from "../src/tools.ts";
import { createRepoWithOrigin } from "./helpers.ts";

test("guardian_done work inventory reports primary and active session dirt without selecting a lane", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const dirty = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_inventory_dirty", taskName: "inventory dirty", createWorktree: true, config: DEFAULT_CONFIG });
  const clean = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_inventory_clean", taskName: "inventory clean", createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(repo, "primary-dirty.txt"), "primary\n", "utf8");
  await fs.writeFile(path.join(dirty.session.worktree_path, "session-dirty.txt"), "session\n", "utf8");

  const fromPrimary = await buildDoneWorkInventory({ repoRoot: repo, cwd: repo, config: DEFAULT_CONFIG });
  const fromSession = await buildDoneWorkInventory({ repoRoot: repo, cwd: dirty.session.worktree_path, config: DEFAULT_CONFIG });

  assert.equal(fromPrimary.repoRoot, repo);
  assert.equal(fromPrimary.currentWorktree, repo);
  assert.equal(fromSession.repoRoot, repo);
  assert.equal(fromSession.currentWorktree, dirty.session.worktree_path);
  assert.deepEqual(fromPrimary.primary.dirtyFiles, ["primary-dirty.txt"]);
  assert.deepEqual(fromSession.primary.dirtyFiles, ["primary-dirty.txt"]);
  assert.equal(fromPrimary.sessions.length, 2);
  assert.equal(fromPrimary.dirtyTargets.length, 2);

  const dirtySession = fromPrimary.sessions.find((session) => session.sessionId === "ses_inventory_dirty");
  const cleanSession = fromPrimary.sessions.find((session) => session.sessionId === "ses_inventory_clean");
  assert.ok(dirtySession);
  assert.ok(cleanSession);
  assert.equal(dirtySession.branch, dirty.session.branch);
  assert.deepEqual(dirtySession.dirtyFiles, ["session-dirty.txt"]);
  assert.equal(cleanSession.branch, clean.session.branch);
  assert.deepEqual(cleanSession.dirtyFiles, []);
});
