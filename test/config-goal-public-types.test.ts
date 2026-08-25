import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { normalizeConfig } from "../src/config.ts";
import type { GuardianConfig, GuardianGoalConfig, GuardianGoalHygieneCompletion } from "../src/index.ts";

test("package root exposes only public Guardian config types", () => {
  // Given
  const entryPath = path.resolve("src/index.ts");
  const program = ts.createProgram([entryPath], {
    allowImportingTsExtensions: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  });
  const checker = program.getTypeChecker();
  const entry = program.getSourceFile(entryPath);

  // When
  const moduleSymbol = entry === undefined ? undefined : checker.getSymbolAtLocation(entry);
  const exports = moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol);
  const exportNames = new Set(exports.map((symbol) => symbol.getName()));

  // Then
  assert.ok(exportNames.has("GuardianConfig"));
  assert.ok(exportNames.has("GuardianGoalConfig"));
  assert.ok(!exportNames.has("NormalizedGuardianConfig"));
  assert.ok(!exportNames.has("NormalizedGuardianGoalConfig"));
});

const legacyGoalConfig: GuardianGoalConfig = {
  commitDirty: true,
  landToBase: true,
  pushBase: true,
  cleanupWorktrees: true,
  cleanupBranches: true,
  cleanupHygiene: true,
  quarantineSessionResidue: false,
};

const legacyGuardianConfig: GuardianConfig = {
  remote: "origin",
  baseBranch: "main",
  worktreeRoot: ".worktrees/$REPO",
  branchPrefix: "guardian/",
  finishMode: "create-pr",
  commandInterceptionMode: "audit",
  autoStart: true,
  autoStartMode: "eager",
  autoFinish: false,
  autoCleanup: false,
  safetyRefRetentionDays: 30,
  requireEmptyStashInventory: false,
  allowBaseWorktreePreserveReset: false,
  allowDirtyPaths: [],
  protectedPaths: [],
  protectedBranches: [],
  trustedUpstreamRemotes: [],
  goal: legacyGoalConfig,
  lockTimeoutMs: 5_000,
};

test("legacy GuardianGoalConfig literals compile and normalize hygiene completion", () => {
  // Given
  const config = normalizeConfig({ goal: legacyGoalConfig });

  // When
  const hygieneCompletion: GuardianGoalHygieneCompletion = config.goal.hygieneCompletion;

  // Then
  assert.equal(hygieneCompletion, "no-unprotected-residue");
});

test("legacy GuardianConfig literals compile and normalize hygiene completion", () => {
  // Given
  const config = normalizeConfig(legacyGuardianConfig);

  // When
  const hygieneCompletion: GuardianGoalHygieneCompletion = config.goal.hygieneCompletion;

  // Then
  assert.equal(hygieneCompletion, "no-unprotected-residue");
});

test("public Guardian goal types expose strict residue completion", () => {
  // Given
  const hygieneCompletion: GuardianGoalHygieneCompletion = "no-unprotected-residue";

  // When
  const config = normalizeConfig({ goal: { hygieneCompletion } });

  // Then
  assert.equal(config.goal.hygieneCompletion, "no-unprotected-residue");
});
