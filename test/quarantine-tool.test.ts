import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildDirtySessionDoneIntent } from "../src/done-intent.ts";
import { guardianGoal } from "../src/goal.ts";
import { executeQuarantine } from "../src/quarantine-execute.ts";
import { guardianQuarantine } from "../src/quarantine-tool.ts";
import { guardianRecover } from "../src/recover.ts";
import { getGuardianPaths } from "../src/state.ts";
import { guardianStart } from "../src/start.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepoWithOrigin, git, installFakeGh } from "./helpers.ts";

const enabledConfig = { ...DEFAULT_CONFIG, goal: { ...DEFAULT_CONFIG.goal, quarantineSessionResidue: true } };

function quarantineItemSummary(value: unknown) {
  if (!isRecordLike(value)) throw new TypeError("quarantine item summary must be a record");
  return {
    quarantineId: value.quarantineId,
    originalRelativePath: value.originalRelativePath,
    state: value.state,
  };
}

test("guardian_quarantine plans and confirmed-purges an available item", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, ".gitignore"), ".completion-cache/\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore completion cache"]);
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_quarantine_tool", taskName: "quarantine tool", createWorktree: true, config: enabledConfig });
  const worktreePath = String(started.session.worktree_path);
  const relativePath = ".completion-cache/residue.txt";
  await fs.mkdir(path.dirname(path.join(worktreePath, relativePath)), { recursive: true });
  await fs.writeFile(path.join(worktreePath, relativePath), "preserve me\n");
  const intent = await buildDirtySessionDoneIntent({ cwd: worktreePath, worktreePath });
  const paths = await getGuardianPaths(repo);
  const manifestDigest = String((started.session.provenance as { readonly manifest?: { readonly digest?: string } }).manifest?.digest);
  const quarantined = await executeQuarantine({ paths, repoRoot: repo, config: enabledConfig, session: started.session, relativePath, manifestDigest, doneIntentDigest: intent.digest });

  const plan = await guardianQuarantine({ repoRoot: repo, config: enabledConfig, mode: "plan", action: "purge", quarantineId: quarantined.quarantineId });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  const applied = await guardianQuarantine({ repoRoot: repo, config: enabledConfig, mode: "apply", action: "purge", quarantineId: quarantined.quarantineId, confirmDelete: true, confirmToken: plan.confirmToken });

  assert.equal(applied.ok, true);
  assert.equal(applied.status, "purged");
  await assert.rejects(fs.access(quarantined.artifactPath));
});

test("guardian_quarantine binds canonical repository and restore destination identities", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, ".gitignore"), ".completion-cache/\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore completion cache"]);
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_quarantine_identity", taskName: "quarantine identity", createWorktree: true, config: enabledConfig });
  const worktreePath = String(started.session.worktree_path);
  const relativePath = ".completion-cache/residue.txt";
  const restoredPath = path.join(worktreePath, relativePath);
  await fs.mkdir(path.dirname(restoredPath), { recursive: true });
  await fs.writeFile(restoredPath, "preserve me\n");
  const intent = await buildDirtySessionDoneIntent({ cwd: worktreePath, worktreePath });
  const paths = await getGuardianPaths(repo);
  const manifestDigest = String((started.session.provenance as { readonly manifest?: { readonly digest?: string } }).manifest?.digest);
  const quarantined = await executeQuarantine({ paths, repoRoot: repo, config: enabledConfig, session: started.session, relativePath, manifestDigest, doneIntentDigest: intent.digest });
  const repoAlias = path.join(base, "repo-alias");
  const worktreeAlias = path.join(base, "worktree-alias");
  await fs.symlink(repo, repoAlias);
  await fs.symlink(worktreePath, worktreeAlias);

  const invalidPlan = await guardianQuarantine({ repoRoot: repoAlias, config: enabledConfig, mode: "plan", action: "restore", quarantineId: quarantined.quarantineId, targetWorktreePath: repoAlias });
  assert.equal(invalidPlan.ok, false, JSON.stringify(invalidPlan));
  assert.equal(invalidPlan.status, "blocked");
  assert.equal(invalidPlan.confirmToken, undefined);
  const linkedRootPrimaryPlan = await guardianQuarantine({ repoRoot: worktreePath, cwd: worktreePath, config: enabledConfig, mode: "plan", action: "restore", quarantineId: quarantined.quarantineId, targetWorktreePath: repo });
  assert.equal(linkedRootPrimaryPlan.ok, false, JSON.stringify(linkedRootPrimaryPlan));
  assert.equal(linkedRootPrimaryPlan.status, "blocked");
  assert.equal(linkedRootPrimaryPlan.confirmToken, undefined);
  const plan = await guardianQuarantine({ repoRoot: repoAlias, config: enabledConfig, mode: "plan", action: "restore", quarantineId: quarantined.quarantineId, targetWorktreePath: worktreeAlias });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.status, "planned");
  assert.equal(plan.selectedTargetWorktreePath, await fs.realpath(worktreePath));
  const wrongConfirmation = await guardianQuarantine({ repoRoot: repo, config: enabledConfig, mode: "apply", action: "restore", quarantineId: quarantined.quarantineId, targetWorktreePath: worktreePath, confirmDelete: true, confirmToken: plan.confirmToken });
  assert.equal(wrongConfirmation.ok, false, JSON.stringify(wrongConfirmation));
  assert.equal(wrongConfirmation.status, "blocked");
  const wrongAction = await guardianQuarantine({ repoRoot: repo, config: enabledConfig, mode: "apply", action: "purge", quarantineId: quarantined.quarantineId, confirmDelete: true, confirmToken: plan.confirmToken });
  assert.equal(wrongAction.ok, false, JSON.stringify(wrongAction));
  assert.equal(wrongAction.status, "blocked");
  await fs.access(quarantined.artifactPath);
  const applied = await guardianQuarantine({ repoRoot: repo, config: enabledConfig, mode: "apply", action: "restore", quarantineId: quarantined.quarantineId, targetWorktreePath: worktreePath, confirm: true, confirmToken: plan.confirmToken });

  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.status, "restored");
  assert.equal(await fs.readFile(restoredPath, "utf8"), "preserve me\n");
});

test("guardian_recover inventories available quarantine items without mutating them", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, ".gitignore"), ".completion-cache/\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore completion cache"]);
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_recover_quarantine", taskName: "recover quarantine", createWorktree: true, config: enabledConfig });
  const worktreePath = String(started.session.worktree_path);
  const relativePath = ".completion-cache/residue.txt";
  await fs.mkdir(path.dirname(path.join(worktreePath, relativePath)), { recursive: true });
  await fs.writeFile(path.join(worktreePath, relativePath), "preserve me\n");
  const intent = await buildDirtySessionDoneIntent({ cwd: worktreePath, worktreePath });
  const paths = await getGuardianPaths(repo);
  const manifestDigest = String((started.session.provenance as { readonly manifest?: { readonly digest?: string } }).manifest?.digest);
  const quarantined = await executeQuarantine({ paths, repoRoot: repo, config: enabledConfig, session: started.session, relativePath, manifestDigest, doneIntentDigest: intent.digest });

  const recovered = await guardianRecover({ repoRoot: repo, cwd: worktreePath, config: enabledConfig });
  const recoveredRecord: Record<string, unknown> = isRecordLike(recovered) ? recovered : {};
  const items = Array.isArray(recoveredRecord.quarantineItems) ? recoveredRecord.quarantineItems : [];
  const incomplete = Array.isArray(recoveredRecord.incompleteQuarantineOperations) ? recoveredRecord.incompleteQuarantineOperations : [];

  assert.deepEqual(items.map(quarantineItemSummary), [{ quarantineId: quarantined.quarantineId, originalRelativePath: relativePath, state: "available" }]);
  assert.equal(incomplete.length, 0);
  await assert.rejects(fs.access(path.join(worktreePath, relativePath)));
  await fs.access(quarantined.artifactPath);
});

test("guardian_goal quarantines eligible residue before its normal done apply", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, ".gitignore"), ".completion-cache/\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore completion cache"]);
  await git(repo, ["push", "origin", "main"]);
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_goal_quarantine", taskName: "goal quarantine", createWorktree: true, config: enabledConfig });
  const worktreePath = String(started.session.worktree_path);
  await fs.mkdir(path.join(worktreePath, ".completion-cache"), { recursive: true });
  await fs.writeFile(path.join(worktreePath, ".completion-cache", "residue.txt"), "preserve me\n");
  await fs.writeFile(path.join(worktreePath, "implementation.txt"), "commit me\n");
  await installFakeGh(t, { repo, branch: String(started.session.branch), dynamicHead: true });

  const plan = await guardianGoal({ repoRoot: repo, cwd: worktreePath, sessionId: started.session.session_id, mode: "plan", commitMessage: "feat: clean completion", config: enabledConfig });

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.status, "planned");
  const applied = await guardianGoal({ repoRoot: repo, cwd: worktreePath, sessionId: started.session.session_id, mode: "apply", confirm: true, confirmToken: plan.confirmToken, commitMessage: "feat: clean completion", config: enabledConfig });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.complete, true, JSON.stringify(applied));
});
