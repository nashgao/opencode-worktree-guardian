import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { guardianStart } from "../src/tools.ts";
import { createRepoWithOrigin } from "./helpers.ts";

type DoneResult = Record<string, unknown> & {
  readonly candidates?: readonly { readonly targetKind: string }[];
  readonly commitMessage?: string;
  readonly dirtyFiles?: readonly string[];
  readonly dirtySnapshot?: { readonly paths: readonly string[] };
  readonly lane?: string;
  readonly reason?: string;
  readonly status?: string;
  readonly suggestedCommands?: readonly string[];
  readonly worktreePath?: string;
};

function asDone(result: Record<string, unknown>): DoneResult {
  return result as DoneResult;
}

async function setupDirtyPrimaryAndSession(sessionId: string) {
  const { base, repo } = await createRepoWithOrigin();
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: sessionId, createWorktree: true, config: DEFAULT_CONFIG });
  await fs.writeFile(path.join(repo, "primary-target.txt"), "primary dirt\n");
  await fs.writeFile(path.join(started.session.worktree_path, "session-dirt.txt"), "session dirt\n");
  return { base, repo, started };
}

test("guardian_done explicit session target wins from dirty primary cwd", async (t) => {
  const { base, repo, started } = await setupDirtyPrimaryAndSession("ses_done_target_session");
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_done_target_session", commitMessage: "feat: finish session work" }));

  assert.equal(result.ok, true);
  assert.equal(result.status, "planned");
  assert.equal(result.lane, "session-finish");
  assert.equal(result.worktreePath, started.session.worktree_path);
  assert.deepEqual(result.dirtyFiles, ["session-dirt.txt"]);
  assert.equal(result.commitMessage, "feat: finish session work");
});

test("guardian_done bare dirty primary plus dirty session needs explicit target selection", async (t) => {
  const { base, repo, started } = await setupDirtyPrimaryAndSession("ses_done_target_ambiguous");
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: ambiguous work" }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "needs-selection");
  assert.equal(result.lane, "select-target");
  assert.match(String(result.reason), /multiple dirty implementation targets/);
  assert.deepEqual(result.candidates?.map((candidate) => candidate.targetKind).sort(), ["primary", "session"]);
  assert.ok(result.suggestedCommands?.includes("guardian_done primary=true commitMessage=..."));
  assert.ok(result.suggestedCommands?.includes(`guardian_done branch=${started.session.branch} commitMessage=...`));
});

test("guardian_done primary=true selects dirty primary when an active session is also dirty", async (t) => {
  const { base, repo } = await setupDirtyPrimaryAndSession("ses_done_target_primary");
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const result = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", primary: true, commitMessage: "feat: publish primary work" }));

  assert.equal(result.ok, true);
  assert.equal(result.status, "planned");
  assert.equal(result.lane, "primary-main-publish");
  assert.deepEqual(result.dirtySnapshot?.paths, ["primary-target.txt"]);
  assert.equal(result.commitMessage, "feat: publish primary work");
});
