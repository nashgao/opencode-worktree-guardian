import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { guardianDoneAll } from "../src/done-all.ts";
import { guardianFinish } from "../src/finish.ts";
import { formatGuardianOutput } from "../src/plugin/readable-output.ts";
import { createRepo, createRepoWithOrigin, git, makeBranchCommit, seedSession } from "./helpers.ts";

type LooseRecord = Record<string, unknown>;
type DoneResult = LooseRecord & {
  readonly preflight: { readonly stashCount?: unknown; readonly stashes?: unknown };
  readonly reason: string;
};

function asDone(result: LooseRecord): DoneResult {
  return result as DoneResult;
}

async function recordCurrentSession(repo: string, sessionId: string, branch: string, config: LooseRecord = DEFAULT_CONFIG) {
  const { stdout: commit } = await git(repo, ["rev-parse", "HEAD"]);
  await seedSession(repo, {
    session_id: sessionId,
    status: "active",
    branch,
    worktree_path: repo,
    base_ref: `${config.remote}/${config.baseBranch}`,
    head_commit: commit,
    safety_refs: [],
  }, config);
}

test("guardian_done done-all apply retains advisory stash inventory", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "done-all-stashed.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "done-all advisory stash"]);

  const plan = await guardianDoneAll({ repoRoot: repo, cwd: repo, mode: "plan", config: DEFAULT_CONFIG });
  const apply = await guardianDoneAll({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken, config: DEFAULT_CONFIG });

  assert.equal(plan.ok, true);
  assert.equal(apply.ok, true);
  assert.equal(apply.lane, "done-all");
  assert.equal(apply.stashCount, 1);
  assert.equal(Array.isArray(apply.stashes) ? apply.stashes.length : 0, 1);
  assert.match(formatGuardianOutput("guardian_done", apply), /\[WARN\] repository stash inventory: 1/);
});

test("guardian_done primary publish reports stash inventory without blocking by default", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "done-stashed.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "done publish stash"]);
  await fs.writeFile(path.join(repo, "done-feature.txt"), "feature\n");

  const plan = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: done feature" }));

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(plan.lane, "primary-main-publish");
  assert.equal(plan.preflight.stashCount, 1);
  assert.equal(Array.isArray(plan.preflight.stashes) ? plan.preflight.stashes.length : 0, 1);
});

test("guardian_done primary publish blocks stash inventory under strict policy", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "done-stashed-strict.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "strict done publish stash"]);
  await fs.writeFile(path.join(repo, "done-feature.txt"), "feature\n");
  const config = { ...DEFAULT_CONFIG, requireEmptyStashInventory: true };

  const plan = asDone(await guardianDone({ repoRoot: repo, cwd: repo, mode: "plan", commitMessage: "feat: done feature", config }));

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.match(plan.reason, /stash inventory/);
  assert.equal(plan.preflight.stashCount, 1);
});

test("preserve-only finish reports stash inventory without blocking by default", async () => {
  const repo = await createRepo();
  const config: LooseRecord = { ...DEFAULT_CONFIG, finishMode: "preserve-only" };
  const { branch } = await makeBranchCommit(repo, "guardian/preserve-stash");
  await recordCurrentSession(repo, "ses_preserve_stash", branch, config);
  await fs.writeFile(path.join(repo, "preserve-stash.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "preserve stash"]);

  const result = await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "ses_preserve_stash", config, mode: "plan" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "planned");
  assert.equal(result.preflight.stashCount, 1);
  assert.equal(Array.isArray(result.preflight.stashes) ? result.preflight.stashes.length : 0, 1);
});

test("preserve-only finish blocks stash inventory under strict policy", async () => {
  const repo = await createRepo();
  const config: LooseRecord = { ...DEFAULT_CONFIG, finishMode: "preserve-only", requireEmptyStashInventory: true };
  const { branch } = await makeBranchCommit(repo, "guardian/preserve-stash-strict");
  await recordCurrentSession(repo, "ses_preserve_stash_strict", branch, config);
  await fs.writeFile(path.join(repo, "preserve-stash-strict.txt"), "stashed\n");
  await git(repo, ["stash", "push", "-u", "-m", "strict preserve stash"]);

  const result = await guardianFinish({ repoRoot: repo, cwd: repo, sessionId: "ses_preserve_stash_strict", config, mode: "plan" });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(String(result.reason), /stash inventory/);
  assert.equal(result.preflight.stashCount, 1);
});
