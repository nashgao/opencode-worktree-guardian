import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CONFIG_PATH, DEFAULT_CONFIG, initializeConfig, loadConfig, normalizeConfig } from "../src/config.ts";
import { guardianHygiene, scanWorkspaceHygiene } from "../src/hygiene.ts";
import { readState, STATE_SCHEMA_VERSION } from "../src/state.ts";
import { isRecordLike, type GuardianPaths } from "../src/types.ts";
import { createRepo, createTempDir, git } from "./helpers.ts";

const TEMPLATE_PROTECTED_PATHS = [".beads", ".omo", ".omc", ".omx", ".sisyphus", ".milestones", ".opencode", ".codegraph", ".worktrees"];

async function writeArtifact(repo: string, relative: string) {
  const target = path.join(repo, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "artifact\n");
}

function findingPaths(result: Record<string, unknown>) {
  return (result.findings as Array<Record<string, unknown>>).map((finding) => finding.path).sort();
}

test("config defaults are delivery-first and cleanup-conservative", () => {
  const config = normalizeConfig();
  assert.equal(config.finishMode, "create-pr");
  assert.equal(config.commandInterceptionMode, "audit");
  assert.equal(config.autoStart, true);
  assert.equal(config.autoStartMode, "eager");
  assert.equal(config.autoFinish, false);
  assert.equal(config.autoCleanup, false);
  assert.equal(config.requireEmptyStashInventory, false);
  assert.equal("allowStashIfUnrelated" in config, false);
  assert.deepEqual(config.allowDirtyPaths, []);
  assert.deepEqual(config.protectedPaths, TEMPLATE_PROTECTED_PATHS);
  assert.deepEqual(config.protectedBranches, DEFAULT_CONFIG.protectedBranches);
  assert.equal(config.goal.hygieneCompletion, "authorized-cleanup");
});

test("missing goal config defaults hygiene completion", () => {
  const config = normalizeConfig({});

  assert.equal(config.goal.hygieneCompletion, "authorized-cleanup");
});

test("partial legacy goal config preserves explicit values and defaults hygiene completion", () => {
  const config = normalizeConfig({ goal: { cleanupHygiene: false } });

  assert.equal(config.goal.cleanupHygiene, false);
  assert.equal(config.goal.hygieneCompletion, "authorized-cleanup");
});

test("goal hygiene completion accepts strict unprotected-finding policy", () => {
  const config = normalizeConfig({ goal: { hygieneCompletion: "no-unprotected-findings" } });

  assert.equal(config.goal.hygieneCompletion, "no-unprotected-findings");
});

test("invalid goal hygiene completion fails closed", () => {
  assert.throws(
    () => normalizeConfig({ goal: { hygieneCompletion: "delete-everything" } }),
    (error: unknown) => isRecordLike(error) && error.configErrorKind === "unsupported_goal_hygiene_completion",
  );
});

test("malformed goal config containers fail closed", () => {
  for (const goal of [null, [], "goal", 1, true]) {
    assert.throws(
      () => normalizeConfig({ goal }),
      (error: unknown) => isRecordLike(error) && error.configErrorKind === "invalid_goal_config",
    );
  }
});

test("quarantine session residue requires an explicit boolean opt-in", () => {
  assert.equal(normalizeConfig().goal.quarantineSessionResidue, false);
  assert.equal(normalizeConfig({ goal: { quarantineSessionResidue: true } }).goal.quarantineSessionResidue, true);
  assert.throws(
    () => normalizeConfig({ goal: { quarantineSessionResidue: "yes" } }),
    (error: unknown) => isRecordLike(error) && error.configErrorKind === "invalid_quarantine_session_residue",
  );
});

test("legacy state schema loads without optional provenance references", async () => {
  const repo = await createTempDir();
  const paths: GuardianPaths = {
    repoRoot: repo,
    gitDir: repo,
    dir: repo,
    statePath: path.join(repo, "state.json"),
    eventsPath: path.join(repo, "events.jsonl"),
    reportPath: path.join(repo, "report.html"),
    lockPath: path.join(repo, "state.lock"),
    lockRef: "refs/opencode-guardian/locks/state",
    lockTmpDir: path.join(repo, "lock-tmp"),
    lockTombstonesDir: path.join(repo, "lock-tombstones"),
    provenanceDir: path.join(repo, "provenance"),
    quarantineDir: path.join(repo, "quarantine"),
    journalDir: path.join(repo, "journal"),
  };
  await fs.writeFile(paths.statePath, JSON.stringify({
    schema_version: STATE_SCHEMA_VERSION,
    state_version: 1,
    sessions: { ses_legacy: { session_id: "ses_legacy", status: "active" } },
  }));

  const state = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(state.schema_version, STATE_SCHEMA_VERSION);
  assert.equal(state.sessions.ses_legacy?.provenance, undefined);
});

test("config defaults protect Beads state from cleanup", () => {
  const config = normalizeConfig();

  assert.equal(config.protectedPaths.includes(".beads"), true);
});

test("hygiene protects Beads state and matches suspicious directory segments despite config overrides", async () => {
  const repo = await createRepo();
  for (const relative of [".beads/embeddeddolt/owg/.dolt/repo_state.json", "ordinary/repo_state.json", "research-dump/file.txt"]) {
    const target = path.join(repo, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "state\n");
  }

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config: { ...DEFAULT_CONFIG, protectedPaths: ["keep-me"] } });

  assert.deepEqual(result.findings.map((finding) => finding.path), ["research-dump"]);
  assert.deepEqual(result.exclusions.map((exclusion) => exclusion.path), [".beads"]);
});

test("hygiene scanner ignores tracked files even when names match known artifact patterns", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "hyperf-tracked/file.txt");
  await git(repo, ["add", "hyperf-tracked/file.txt"]);
  await git(repo, ["commit", "-m", "track matching artifact name"]);

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(findingPaths(result).includes("hyperf-tracked"), false);
  assert.equal(result.summary.findingCount, 0);
});

test("hygiene scanner excludes protected dependency and build directories", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "node_modules/librarian-alpha/file.txt");
  await writeArtifact(repo, "vendor/hyperf-demo/file.txt");
  await writeArtifact(repo, "target/test-phpkafka/file.txt");

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(result.summary.findingCount, 0);
  assert.deepEqual((result.exclusions as Array<Record<string, unknown>>).map((entry) => entry.path).sort(), ["node_modules", "target", "vendor"]);
});

test("hygiene scanner excludes agent and local tooling state directories from cleanup findings", async () => {
  const repo = await createRepo();
  await fs.writeFile(path.join(repo, ".gitignore"), "logs/\n");
  await writeArtifact(repo, ".milestones/logs/progress-events.jsonl");
  await writeArtifact(repo, ".omc/session.json");
  await writeArtifact(repo, ".omo/plan.md");
  await writeArtifact(repo, ".omx/cache.json");
  await writeArtifact(repo, ".sisyphus/state.json");
  await writeArtifact(repo, ".opencode/worktree-guardian.json");
  await writeArtifact(repo, ".codegraph/index.sqlite");
  await writeArtifact(repo, ".worktrees/cache.json");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "track ignore rules"]);

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.equal(result.summary.findingCount, 0);
  assert.deepEqual((result.exclusions as Array<Record<string, unknown>>).map((entry) => entry.path).sort(), [".codegraph", ".milestones", ".omc", ".omo", ".omx", ".opencode", ".sisyphus", ".worktrees"]);
  assert.deepEqual((result as Record<string, unknown>).reviewableCandidates, []);
});

test("hygiene scanner excludes configured protected paths from cleanup findings", async () => {
  const repo = await createRepo();
  const config = { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths, ".agent-state"] };
  await writeArtifact(repo, ".agent-state/node-compile-cache/cache.blob");
  await writeArtifact(repo, ".agent-state/research-dump/file.txt");

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config });

  assert.equal(result.ok, true);
  assert.equal(result.summary.findingCount, 0);
  assert.deepEqual((result.exclusions as Array<Record<string, unknown>>).map((entry) => entry.path).sort(), [".agent-state"]);
  assert.deepEqual((result as Record<string, unknown>).reviewableCandidates, []);
});

test("hygiene scanner collapses known residue names to cleanup roots", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "guardian-residue/.opencode/worktree-guardian.json");
  await writeArtifact(repo, "guardian-origin-abc123/remote.git/hooks/push-to-checkout.sample");
  const nested = path.join(repo, "opencode-temp-abc123", "checkout");
  await fs.mkdir(nested, { recursive: true });
  await git(nested, ["init", "-b", "main"]);
  await git(nested, ["config", "user.email", "guardian@example.test"]);
  await git(nested, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(nested, "README.md"), "nested\n");
  await git(nested, ["add", "README.md"]);
  await git(nested, ["commit", "-m", "nested initial"]);

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(findingPaths(result).includes("guardian-origin-abc123"), true);
  assert.equal(findingPaths(result).includes("guardian-origin-abc123/remote.git/hooks/push-to-checkout.sample"), false);
  assert.equal(findingPaths(result).includes("guardian-residue"), true);
  assert.equal(findingPaths(result).includes("guardian-residue/.opencode/worktree-guardian.json"), false);
  assert.equal(findingPaths(result).includes("opencode-temp-abc123"), true);
  assert.equal(findingPaths(result).includes("opencode-temp-abc123/checkout"), false);
});

test("hygiene scanner recognizes nested Guardian residue without weakening protected or tracked-path guards", async () => {
  const repo = await createRepo();
  const nestedResidue = "test-fixtures/guardian-origin-nested/remote.git/objects/pack";
  const trackedResidue = "tracked-parent/guardian-origin-tracked/remote.git/objects/pack";
  await writeArtifact(repo, nestedResidue);
  await writeArtifact(repo, ".beads/guardian-origin-protected/remote.git/objects/pack");
  await writeArtifact(repo, "tracked-parent/guardian-origin-tracked/.keep");
  await git(repo, ["add", "tracked-parent/guardian-origin-tracked/.keep"]);
  await git(repo, ["commit", "-m", "track nested residue guard"]);
  await writeArtifact(repo, trackedResidue);

  const scan = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });
  const plan = await guardianHygiene({
    repoRoot: repo,
    config: DEFAULT_CONFIG,
    mode: "plan",
    cleanupPaths: ["tracked-parent/guardian-origin-tracked"],
    allowCategories: ["suspicious"],
  });

  assert.equal(findingPaths(scan).includes("test-fixtures/guardian-origin-nested"), true);
  assert.equal(findingPaths(scan).includes(".beads/guardian-origin-protected"), false);
  assert.equal((scan.exclusions as Array<Record<string, unknown>>).some((entry) => entry.path === ".beads"), true);
  assert.equal(plan.ok, false);
  assert.equal((plan.blockers as Array<Record<string, unknown>>).some((blocker) => String(blocker.reason).includes("tracked files")), true);
});

test("command interception defaults to audit", () => {
  assert.equal(DEFAULT_CONFIG.commandInterceptionMode, "audit");
  assert.equal(normalizeConfig({}).commandInterceptionMode, "audit");
});

test("command interception accepts strict mode", () => {
  assert.equal(normalizeConfig({ commandInterceptionMode: "strict" }).commandInterceptionMode, "strict");
});

test("invalid command interception modes fail closed", () => {
  assert.throws(
    () => normalizeConfig({ commandInterceptionMode: "block" }),
    (error: unknown) => isRecordLike(error) && error.configErrorKind === "unsupported_command_interception_mode",
  );
});

test("repo-local config replaces template protected paths", async () => {
  const repo = await createTempDir();
  await fs.mkdir(path.join(repo, ".opencode"));
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({
    finishMode: "create-pr",
    autoStart: false,
    autoStartMode: "lazy",
    autoFinish: true,
    allowDirtyPaths: [".claude/logs/**", "", ".claude/logs/**", ".omx/**"],
    protectedPaths: ["./.agent-state", ".omo/cache", "../outside", "/tmp/outside", ".agent-state/logs"],
    protectedBranches: ["release"],
  }));

  const { config, loaded } = await loadConfig(repo);
  assert.equal(loaded, true);
  assert.equal(config.finishMode, "create-pr");
  assert.equal(config.autoStart, false);
  assert.equal(config.autoStartMode, "lazy");
  assert.equal(config.autoFinish, true);
  assert.equal(config.autoCleanup, false);
  assert.equal(config.requireEmptyStashInventory, false);
  assert.equal("allowStashIfUnrelated" in config, false);
  assert.deepEqual(config.allowDirtyPaths, [".claude/logs/**", ".omx/**"]);
  assert.deepEqual(config.protectedPaths, [".beads", ".agent-state", ".omo/cache"]);
  assert.deepEqual(config.protectedBranches, ["main", "master", "develop", "production", "release"]);
});

test("repo-local strict hygiene completion keeps automatic cleanup disabled and protects Beads", async () => {
  const repo = await createTempDir();
  await fs.mkdir(path.join(repo, ".opencode"));
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({
    finishMode: "create-pr",
    protectedPaths: [".omo", ".omc", ".omx", ".sisyphus", ".milestones", ".opencode", ".codegraph", ".worktrees"],
    goal: { hygieneCompletion: "no-unprotected-findings" },
  }));

  const { config } = await loadConfig(repo);

  assert.equal(config.autoCleanup, false);
  assert.equal(config.goal.hygieneCompletion, "no-unprotected-findings");
  assert.equal(config.protectedPaths.includes(".beads"), true);
});

test("repo-local config uses template protected paths when the field is absent", async () => {
  const repo = await createTempDir();
  await fs.mkdir(path.join(repo, ".opencode"));
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({
    autoStartMode: "lazy",
  }));

  const { config, loaded } = await loadConfig(repo);

  assert.equal(loaded, true);
  assert.equal(config.autoStartMode, "lazy");
  assert.deepEqual(config.protectedPaths, TEMPLATE_PROTECTED_PATHS);
});

test("missing config loads defaults without pretending a file was read", async () => {
  const repo = await createTempDir();

  const { config, loaded } = await loadConfig(repo);

  assert.equal(loaded, false);
  assert.deepEqual(config, DEFAULT_CONFIG);
});

test("config initialization writes defaults once", async () => {
  const repo = await createTempDir();
  const configPath = path.join(repo, CONFIG_PATH);

  const created = await initializeConfig(repo);
  const existing = await initializeConfig(repo);
  const loaded = await loadConfig(repo);

  assert.equal(created.status, "created");
  assert.equal(created.created, true);
  assert.equal(created.configPath, configPath);
  assert.equal(existing.status, "exists");
  assert.equal(existing.created, false);
  assert.deepEqual(loaded.config, DEFAULT_CONFIG);
  assert.deepEqual(loaded.config.protectedPaths, TEMPLATE_PROTECTED_PATHS);
  assert.equal(await fs.readFile(configPath, "utf8"), `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  assert.equal(JSON.parse(await fs.readFile(configPath, "utf8")).goal.hygieneCompletion, "authorized-cleanup");
});

test("non-object config payloads fail closed at the boundary", async () => {
  for (const payload of [[], null, "create-pr", 1, true]) {
    const repo = await createTempDir();
    await fs.mkdir(path.join(repo, ".opencode"));
    await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify(payload));

    await assert.rejects(
      () => loadConfig(repo),
      (error: unknown) => isRecordLike(error) && error.configErrorKind === "invalid_config_root",
    );
  }
});

test("invalid finish modes fail closed", () => {
  assert.throws(() => normalizeConfig({ finishMode: "delete-everything" }), /Unsupported/);
});

test("invalid auto-start modes fail closed", () => {
  assert.throws(() => normalizeConfig({ autoStartMode: "sometimes" }), /Unsupported/);
});

test("stash inventory strictness is explicit opt-in", () => {
  const config = normalizeConfig({ requireEmptyStashInventory: true });

  assert.equal(config.requireEmptyStashInventory, true);
});

test("retired stash relationship config does not preserve the legacy field", () => {
  const legacyEnabled = normalizeConfig({ allowStashIfUnrelated: true });
  const legacyDisabled = normalizeConfig({ allowStashIfUnrelated: false });

  assert.equal(legacyEnabled.requireEmptyStashInventory, false);
  assert.equal(legacyDisabled.requireEmptyStashInventory, false);
  assert.equal("allowStashIfUnrelated" in legacyEnabled, false);
  assert.equal("allowStashIfUnrelated" in legacyDisabled, false);
});

test("repo-local legacy stash config loads advisory policy without preserving the retired field", async () => {
  const repo = await createTempDir();
  await fs.mkdir(path.join(repo, ".opencode"));
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({ allowStashIfUnrelated: false }));

  const { config, loaded } = await loadConfig(repo);

  assert.equal(loaded, true);
  assert.equal(config.requireEmptyStashInventory, false);
  assert.equal("allowStashIfUnrelated" in config, false);
});
