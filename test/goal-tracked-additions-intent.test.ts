import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianGoal } from "../src/goal.ts";
import { guardianStart } from "../src/start.ts";
import type { GuardianConfig } from "../src/types.ts";
import { isRecordLike } from "../src/types.ts";
import { installFakeGh } from "./delete-fixtures.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

const STRICT_GOAL_CONFIG: GuardianConfig = {
  ...DEFAULT_CONFIG,
  goal: { ...DEFAULT_CONFIG.goal, hygieneCompletion: "no-unprotected-residue" },
};

function record(value: unknown, name: string): Record<string, unknown> {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

function text(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(`${name} must be a non-empty string`);
}

async function fixture(t: test.TestContext, sessionId: string) {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, createWorktree: true, config: STRICT_GOAL_CONFIG });
  const session = record(started.session, "started.session");
  return {
    repo,
    sessionId,
    branch: text(session.branch, "session.branch"),
    worktree: text(session.worktree_path, "session.worktree_path"),
  };
}

test("intentionalPaths acknowledges an exact staged tracked addition", async (t) => {
  const started = await fixture(t, "ses_goal_tracked_intent");
  const feature = "src/tracked-feature.ts";
  await fs.mkdir(path.join(started.worktree, "src"), { recursive: true });
  await fs.writeFile(path.join(started.worktree, feature), "export const tracked = true;\n");
  await git(started.worktree, ["add", "--", feature]);
  await installFakeGh(t, { repo: started.repo, branch: started.branch, dynamicHead: true });
  const request = {
    repoRoot: started.repo,
    cwd: started.repo,
    sessionId: started.sessionId,
    commitMessage: "feat: deliver acknowledged tracked source",
    intentionalPaths: [feature],
    config: STRICT_GOAL_CONFIG,
  };

  const plan = record(await guardianGoal({ ...request, mode: "plan" }), "goal plan");
  const applied = record(await guardianGoal({ ...request, mode: "apply", confirm: true, confirmToken: text(plan.confirmToken, "plan.confirmToken") }), "goal apply");

  assert.equal(plan.status, "planned", JSON.stringify(plan));
  assert.equal(applied.complete, true, JSON.stringify(applied));
  assert.match((await git(started.repo, ["show", `origin/main:${feature}`])).stdout, /tracked = true/);
});

test("intentionalPaths rejects a baseline tracked file", async (t) => {
  const started = await fixture(t, "ses_goal_baseline_intent");

  const plan = record(await guardianGoal({
    repoRoot: started.repo,
    cwd: started.repo,
    sessionId: started.sessionId,
    mode: "plan",
    commitMessage: "feat: reject baseline acknowledgment",
    intentionalPaths: ["README.md"],
    config: STRICT_GOAL_CONFIG,
  }), "goal plan");

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.match(String(plan.reason), /baseline tracked files/);
});
