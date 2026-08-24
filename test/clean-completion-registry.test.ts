import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import plugin from "../src/index.ts";
import { CONFIG_PATH, DEFAULT_CONFIG } from "../src/config.ts";
import { buildDirtySessionDoneIntent } from "../src/done-intent.ts";
import { maybeInjectPlanConfirmToken, rememberPlanConfirmToken } from "../src/plugin/plan-token-cache.ts";
import { executeQuarantine } from "../src/quarantine-execute.ts";
import { getGuardianPaths } from "../src/state.ts";
import { guardianStart } from "../src/start.ts";
import type { PlanCacheToolArgs, PlanTokenCache } from "../src/types.ts";
import { createToolContext, runTool } from "./plugin-contract-helpers.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const codexCliPath = path.join(projectRoot, "codex", "hooks", "guardian-hook.ts");
const enabledConfig = { ...DEFAULT_CONFIG, goal: { ...DEFAULT_CONFIG.goal, quarantineSessionResidue: true } };

async function runCodexCli(args: readonly string[]) {
  const child = spawn(process.execPath, [codexCliPath, ...args], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  assert.equal(exitCode, 0, stderr);
  return Buffer.concat(stdoutChunks).toString("utf8").trim();
}

async function quarantineFixture(t: TestContext, sessionId: string) {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, path.dirname(CONFIG_PATH)), { recursive: true });
  await fs.writeFile(path.join(repo, ".gitignore"), ".completion-cache/\n");
  await fs.writeFile(path.join(repo, CONFIG_PATH), `${JSON.stringify(enabledConfig)}\n`);
  await git(repo, ["add", ".gitignore", CONFIG_PATH]);
  await git(repo, ["commit", "-m", "configure quarantine fixture"]);

  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: sessionId, createWorktree: true, config: enabledConfig });
  const worktreePath = String(started.session.worktree_path);
  const relativePath = ".completion-cache/residue.txt";
  const restoredPath = path.join(worktreePath, relativePath);
  await fs.mkdir(path.dirname(restoredPath), { recursive: true });
  await fs.writeFile(restoredPath, "adapter-bound residue\n");
  const intent = await buildDirtySessionDoneIntent({ cwd: worktreePath, worktreePath });
  const paths = await getGuardianPaths(repo);
  const manifestDigest = String((started.session.provenance as { readonly manifest?: { readonly digest?: string } }).manifest?.digest);
  const quarantined = await executeQuarantine({ paths, repoRoot: repo, config: enabledConfig, session: started.session, relativePath, manifestDigest, doneIntentDigest: intent.digest });
  const secondaryWorktreePath = path.join(base, `${sessionId}-secondary-worktree`);
  await git(repo, ["worktree", "add", "-b", `test-${sessionId}-secondary`, secondaryWorktreePath, "HEAD"]);
  const repoAlias = path.join(base, `${sessionId}-repo-alias`);
  const worktreeAlias = path.join(base, `${sessionId}-worktree-alias`);
  await fs.symlink(repo, repoAlias);
  await fs.symlink(worktreePath, worktreeAlias);
  return { repo, repoAlias, secondaryWorktreePath, worktreeAlias, worktreePath, restoredPath, quarantined };
}

test("OpenCode quarantine cache accepts canonical aliases and rejects cross-action reuse", async (t) => {
  const fixture = await quarantineFixture(t, "ses_plugin_quarantine_cache");
  const hooks = await plugin.server({ directory: fixture.repoAlias, worktree: fixture.worktreeAlias });
  const { context } = createToolContext();
  context.directory = fixture.repoAlias;
  context.worktree = fixture.worktreeAlias;
  const execute = hooks.tool.guardian_quarantine.execute;

  const plan = await runTool(execute, {
    repoRoot: fixture.repoAlias,
    cwd: fixture.repoAlias,
    mode: "plan",
    action: "restore",
    quarantineId: fixture.quarantined.quarantineId,
    targetWorktreePath: fixture.worktreeAlias,
  }, context);
  assert.equal(plan.metadata.status, "planned");

  const cache: PlanTokenCache = new Map();
  const planArgs: PlanCacheToolArgs = {
    repoRoot: fixture.repoAlias,
    cwd: fixture.repoAlias,
    mode: "plan",
    action: "restore",
    quarantineId: fixture.quarantined.quarantineId,
    targetWorktreePath: fixture.worktreeAlias,
  };
  await rememberPlanConfirmToken("guardian_quarantine", planArgs, plan.metadata, cache);
  const matchingApply: PlanCacheToolArgs = { ...planArgs, repoRoot: fixture.repo, cwd: fixture.repo, targetWorktreePath: fixture.worktreePath, mode: "apply", confirm: true, confirmToken: "" };
  const targetDrift: PlanCacheToolArgs = { ...matchingApply, targetWorktreePath: fixture.secondaryWorktreePath };
  const idDrift: PlanCacheToolArgs = { ...matchingApply, quarantineId: `${fixture.quarantined.quarantineId}-other` };
  const actionDrift: PlanCacheToolArgs = { ...matchingApply, action: "purge", targetWorktreePath: undefined, confirm: false, confirmDelete: true };
  const confirmationModeDrift: PlanCacheToolArgs = { ...matchingApply, confirm: false, confirmDelete: true };
  const unconfirmedApply: PlanCacheToolArgs = { ...matchingApply, confirm: false };
  await maybeInjectPlanConfirmToken("guardian_quarantine", matchingApply, cache);
  await maybeInjectPlanConfirmToken("guardian_quarantine", targetDrift, cache);
  await maybeInjectPlanConfirmToken("guardian_quarantine", idDrift, cache);
  await maybeInjectPlanConfirmToken("guardian_quarantine", actionDrift, cache);
  await maybeInjectPlanConfirmToken("guardian_quarantine", confirmationModeDrift, cache);
  await maybeInjectPlanConfirmToken("guardian_quarantine", unconfirmedApply, cache);
  assert.equal(matchingApply.confirmToken, plan.metadata.confirmToken);
  for (const drifted of [targetDrift, idDrift, actionDrift, confirmationModeDrift, unconfirmedApply]) assert.equal(drifted.confirmToken, "");

  const wrongAction = await runTool(execute, {
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    mode: "apply",
    action: "purge",
    quarantineId: fixture.quarantined.quarantineId,
    confirmDelete: true,
  }, context);
  assert.equal(wrongAction.metadata.status, "blocked");
  await fs.access(fixture.quarantined.artifactPath);

  const wrongTarget = await runTool(execute, {
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    mode: "apply",
    action: "restore",
    quarantineId: fixture.quarantined.quarantineId,
    targetWorktreePath: fixture.secondaryWorktreePath,
    confirm: true,
  }, context);
  assert.equal(wrongTarget.metadata.status, "blocked");
  await fs.access(fixture.quarantined.artifactPath);

  const restored = await runTool(execute, {
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    mode: "apply",
    action: "restore",
    quarantineId: fixture.quarantined.quarantineId,
    targetWorktreePath: fixture.worktreePath,
    confirm: true,
  }, context);
  assert.equal(restored.metadata.status, "restored", JSON.stringify(restored.metadata));
  assert.equal(await fs.readFile(fixture.restoredPath, "utf8"), "adapter-bound residue\n");
});

test("Codex quarantine cache persists the exact core binding and rejects cross-action reuse", async (t) => {
  const fixture = await quarantineFixture(t, "ses_codex_quarantine_cache");
  const planArgs = {
    repoRoot: fixture.repoAlias,
    cwd: fixture.repoAlias,
    mode: "plan",
    action: "restore",
    quarantineId: fixture.quarantined.quarantineId,
    targetWorktreePath: fixture.worktreeAlias,
  };
  const plan = await runCodexCli(["tool", "guardian_quarantine", JSON.stringify(planArgs)]);
  assert.match(plan, /guardian_quarantine planned/);

  const cachePath = path.join((await getGuardianPaths(fixture.repo)).dir, "codex-plan-cache.json");
  const cache = JSON.parse(await fs.readFile(cachePath, "utf8")) as { readonly entries?: Record<string, string> };
  const keys = Object.keys(cache.entries ?? {});
  assert.equal(keys.length, 1);
  const cacheIdentity = JSON.parse(keys[0]) as Record<string, unknown>;
  assert.deepEqual(Object.keys(cacheIdentity).sort(), ["boundPlan", "name"]);
  assert.equal(cacheIdentity.name, "guardian_quarantine");
  assert.match(String(cacheIdentity.boundPlan), /^[a-f0-9]{64}$/);

  const wrongAction = await runCodexCli(["tool", "guardian_quarantine", JSON.stringify({
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    mode: "apply",
    action: "purge",
    quarantineId: fixture.quarantined.quarantineId,
    confirmDelete: true,
  })]);
  assert.match(wrongAction, /guardian_quarantine blocked/);
  await fs.access(fixture.quarantined.artifactPath);

  const wrongTarget = await runCodexCli(["tool", "guardian_quarantine", JSON.stringify({
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    mode: "apply",
    action: "restore",
    quarantineId: fixture.quarantined.quarantineId,
    targetWorktreePath: fixture.secondaryWorktreePath,
    confirm: true,
  })]);
  assert.match(wrongTarget, /guardian_quarantine blocked/);
  await fs.access(fixture.quarantined.artifactPath);

  const wrongId = await runCodexCli(["tool", "guardian_quarantine", JSON.stringify({
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    mode: "apply",
    action: "restore",
    quarantineId: `${fixture.quarantined.quarantineId}-other`,
    targetWorktreePath: fixture.worktreePath,
    confirm: true,
  })]);
  assert.match(wrongId, /guardian_quarantine blocked/);
  await fs.access(fixture.quarantined.artifactPath);

  const unconfirmed = await runCodexCli(["tool", "guardian_quarantine", JSON.stringify({
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    mode: "apply",
    action: "restore",
    quarantineId: fixture.quarantined.quarantineId,
    targetWorktreePath: fixture.worktreePath,
  })]);
  assert.match(unconfirmed, /guardian_quarantine blocked/);
  await fs.access(fixture.quarantined.artifactPath);

  const restored = await runCodexCli(["tool", "guardian_quarantine", JSON.stringify({
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    mode: "apply",
    action: "restore",
    quarantineId: fixture.quarantined.quarantineId,
    targetWorktreePath: fixture.worktreePath,
    confirm: true,
  })]);
  assert.match(restored, /guardian_quarantine restored/);
  assert.equal(await fs.readFile(fixture.restoredPath, "utf8"), "adapter-bound residue\n");
});

test("Codex goal cache does not invalidate its own clean-completion plan", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const config = {
    ...DEFAULT_CONFIG,
    worktreeRoot: path.join(base, "worktrees", "$REPO"),
    goal: {
      ...DEFAULT_CONFIG.goal,
      commitDirty: false,
      landToBase: false,
      pushBase: false,
      cleanupWorktrees: false,
      cleanupBranches: false,
      hygieneCompletion: "no-unprotected-residue" as const,
      quarantineSessionResidue: true,
    },
  };
  await fs.mkdir(path.join(repo, path.dirname(CONFIG_PATH)), { recursive: true });
  await fs.writeFile(path.join(repo, CONFIG_PATH), `${JSON.stringify(config)}\n`);
  await git(repo, ["add", CONFIG_PATH]);
  await git(repo, ["commit", "-m", "enable clean completion"]);
  const sessionId = "ses_codex_goal_clean_completion_cache";
  await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "goal cache stability", createWorktree: true, config });

  const planned = await runCodexCli(["tool", "guardian_goal", JSON.stringify({ repoRoot: repo, cwd: repo, sessionId, mode: "plan" })]);
  assert.match(planned, /guardian_goal planned/);
  const applied = await runCodexCli(["tool", "guardian_goal", JSON.stringify({ repoRoot: repo, cwd: repo, sessionId, mode: "apply", confirm: true })]);
  const primaryStatus = await git(repo, ["status", "--short"]);

  assert.equal(primaryStatus.stdout, "");
  assert.match(applied, /guardian_goal complete/);
  assert.doesNotMatch(applied, /confirm token mismatch/);
});
