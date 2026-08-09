import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeProtectedPaths } from "./protected-paths.ts";
import type {
  GuardianAutoStartMode,
  GuardianCommandInterceptionMode,
  GuardianFinishMode,
  GuardianGoalHygieneCompletion,
  LoadedGuardianConfig,
  LoadConfigOptions,
  RecordLike,
} from "./types.ts";
import { errorCode, isRecordLike } from "./types.ts";
import type { NormalizedGuardianConfig, NormalizedGuardianGoalConfig } from "./normalized-config.ts";

export const CONFIG_PATH = path.join(".opencode", "worktree-guardian.json");
const DEFAULT_CONFIG_TEMPLATE_URL = new URL("../templates/worktree-guardian.json", import.meta.url);
const DEFAULT_CONFIG_TEMPLATE = readFileSync(DEFAULT_CONFIG_TEMPLATE_URL, "utf8");

export const FINISH_MODES = new Set(["preserve-only", "push-branch", "create-pr", "merge-to-base"]);
export const AUTO_START_MODES = new Set(["eager", "lazy"]);
export const COMMAND_INTERCEPTION_MODES = new Set(["audit", "strict"]);
export const GOAL_HYGIENE_COMPLETIONS = new Set(["authorized-cleanup", "no-unprotected-findings"]);

export type ConfigErrorKind =
  | "invalid_config_root"
  | "unsupported_finish_mode"
  | "unsupported_auto_start_mode"
  | "unsupported_command_interception_mode"
  | "invalid_goal_config"
  | "unsupported_goal_hygiene_completion"
  | "invalid_quarantine_session_residue";
export type ConfigBoundaryError = Error & { readonly configErrorKind: ConfigErrorKind };

function configError(kind: ConfigErrorKind, message: string): ConfigBoundaryError {
  return Object.assign(new Error(message), { configErrorKind: kind });
}

function uniqueStrings(values: readonly unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function isGuardianFinishMode(value: unknown): value is GuardianFinishMode {
  return typeof value === "string" && FINISH_MODES.has(value);
}

function isGuardianAutoStartMode(value: unknown): value is GuardianAutoStartMode {
  return typeof value === "string" && AUTO_START_MODES.has(value);
}

function isGuardianCommandInterceptionMode(value: unknown): value is GuardianCommandInterceptionMode {
  return typeof value === "string" && COMMAND_INTERCEPTION_MODES.has(value);
}

function isGuardianGoalHygieneCompletion(value: unknown): value is GuardianGoalHygieneCompletion {
  return typeof value === "string" && GOAL_HYGIENE_COMPLETIONS.has(value);
}

function templateError(message: string) {
  return new Error(`Invalid worktree guardian default config template: ${message}`);
}

function stringField(record: RecordLike, key: string) {
  const value = record[key];
  if (typeof value !== "string") throw templateError(`${key} must be a string`);
  return value;
}

function booleanField(record: RecordLike, key: string) {
  const value = record[key];
  if (typeof value !== "boolean") throw templateError(`${key} must be a boolean`);
  return value;
}

function numberField(record: RecordLike, key: string) {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw templateError(`${key} must be a finite number`);
  return value;
}

function stringArrayField(record: RecordLike, key: string) {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw templateError(`${key} must be a string array`);
  return value;
}

function goalField(record: RecordLike, key: string): NormalizedGuardianGoalConfig {
  const value = record[key];
  if (!isRecordLike(value)) throw templateError(`${key} must be an object`);
  const hygieneCompletion = stringField(value, "hygieneCompletion");
  if (!isGuardianGoalHygieneCompletion(hygieneCompletion)) throw templateError("goal.hygieneCompletion is unsupported");
  return {
    commitDirty: booleanField(value, "commitDirty"),
    landToBase: booleanField(value, "landToBase"),
    pushBase: booleanField(value, "pushBase"),
    cleanupWorktrees: booleanField(value, "cleanupWorktrees"),
    cleanupBranches: booleanField(value, "cleanupBranches"),
    cleanupHygiene: booleanField(value, "cleanupHygiene"),
    hygieneCompletion,
    quarantineSessionResidue: booleanField(value, "quarantineSessionResidue"),
  };
}

function parseDefaultConfigTemplate(raw: string): NormalizedGuardianConfig {
  const value: unknown = JSON.parse(raw);
  if (!isRecordLike(value)) throw templateError("root must be an object");
  const finishMode = value.finishMode;
  if (!isGuardianFinishMode(finishMode)) throw templateError("finishMode is unsupported");
  const autoStartMode = value.autoStartMode;
  if (!isGuardianAutoStartMode(autoStartMode)) throw templateError("autoStartMode is unsupported");
  const commandInterceptionMode = value.commandInterceptionMode;
  if (!isGuardianCommandInterceptionMode(commandInterceptionMode)) throw templateError("commandInterceptionMode is unsupported");
  return {
    remote: stringField(value, "remote"),
    baseBranch: stringField(value, "baseBranch"),
    worktreeRoot: stringField(value, "worktreeRoot"),
    branchPrefix: stringField(value, "branchPrefix"),
    finishMode,
    commandInterceptionMode,
    autoStart: booleanField(value, "autoStart"),
    autoStartMode,
    autoFinish: booleanField(value, "autoFinish"),
    autoCleanup: booleanField(value, "autoCleanup"),
    safetyRefRetentionDays: numberField(value, "safetyRefRetentionDays"),
    requireEmptyStashInventory: booleanField(value, "requireEmptyStashInventory"),
    allowBaseWorktreePreserveReset: booleanField(value, "allowBaseWorktreePreserveReset"),
    allowDirtyPaths: uniqueStrings(stringArrayField(value, "allowDirtyPaths")),
    goal: goalField(value, "goal"),
    protectedPaths: normalizeProtectedPaths(stringArrayField(value, "protectedPaths")),
    protectedBranches: uniqueStrings(stringArrayField(value, "protectedBranches")),
    trustedUpstreamRemotes: uniqueStrings(stringArrayField(value, "trustedUpstreamRemotes")),
    lockTimeoutMs: numberField(value, "lockTimeoutMs"),
  };
}

export const DEFAULT_CONFIG: NormalizedGuardianConfig = Object.freeze(parseDefaultConfigTemplate(DEFAULT_CONFIG_TEMPLATE));

type NormalizedLoadedGuardianConfig = Omit<LoadedGuardianConfig, "config"> & {
  readonly config: NormalizedGuardianConfig;
};

export function normalizeGoalConfig(input: unknown): NormalizedGuardianGoalConfig {
  if (input === undefined) return DEFAULT_CONFIG.goal;
  if (!isRecordLike(input)) throw configError("invalid_goal_config", "goal must be an object");
  const hygieneCompletion = input.hygieneCompletion;
  if (hygieneCompletion !== undefined && !isGuardianGoalHygieneCompletion(hygieneCompletion)) {
    throw configError("unsupported_goal_hygiene_completion", `Unsupported goal hygieneCompletion: ${String(hygieneCompletion)}`);
  }
  const quarantineSessionResidue = input.quarantineSessionResidue;
  if (quarantineSessionResidue !== undefined && typeof quarantineSessionResidue !== "boolean") {
    throw configError("invalid_quarantine_session_residue", "goal.quarantineSessionResidue must be a boolean");
  }
  return {
    commitDirty: typeof input.commitDirty === "boolean" ? input.commitDirty : DEFAULT_CONFIG.goal.commitDirty,
    landToBase: typeof input.landToBase === "boolean" ? input.landToBase : DEFAULT_CONFIG.goal.landToBase,
    pushBase: typeof input.pushBase === "boolean" ? input.pushBase : DEFAULT_CONFIG.goal.pushBase,
    cleanupWorktrees: typeof input.cleanupWorktrees === "boolean" ? input.cleanupWorktrees : DEFAULT_CONFIG.goal.cleanupWorktrees,
    cleanupBranches: typeof input.cleanupBranches === "boolean" ? input.cleanupBranches : DEFAULT_CONFIG.goal.cleanupBranches,
    cleanupHygiene: typeof input.cleanupHygiene === "boolean" ? input.cleanupHygiene : DEFAULT_CONFIG.goal.cleanupHygiene,
    hygieneCompletion: hygieneCompletion ?? DEFAULT_CONFIG.goal.hygieneCompletion,
    quarantineSessionResidue: quarantineSessionResidue ?? DEFAULT_CONFIG.goal.quarantineSessionResidue,
  };
}

export function normalizeConfig(input: RecordLike = {}): NormalizedGuardianConfig {
  const { allowStashIfUnrelated: retiredAllowStashIfUnrelated, ...supportedInput } = input;
  void retiredAllowStashIfUnrelated;
  const config = { ...DEFAULT_CONFIG, ...supportedInput };
  if (!isGuardianFinishMode(config.finishMode)) {
    throw configError("unsupported_finish_mode", `Unsupported worktree guardian finishMode: ${String(config.finishMode)}`);
  }
  if (!isGuardianAutoStartMode(config.autoStartMode)) {
    throw configError("unsupported_auto_start_mode", `Unsupported worktree guardian autoStartMode: ${String(config.autoStartMode)}`);
  }
  if (!isGuardianCommandInterceptionMode(config.commandInterceptionMode)) {
    throw configError("unsupported_command_interception_mode", `Unsupported worktree guardian commandInterceptionMode: ${String(config.commandInterceptionMode)}`);
  }

  const protectedBranches = uniqueStrings([
    ...DEFAULT_CONFIG.protectedBranches,
    ...(Array.isArray(supportedInput.protectedBranches) ? supportedInput.protectedBranches : []),
  ]);

  return {
    ...config,
    commandInterceptionMode: config.commandInterceptionMode,
    autoStart: config.autoStart !== false,
    autoStartMode: config.autoStartMode,
    autoFinish: config.autoFinish === true,
    autoCleanup: config.autoCleanup === true,
    requireEmptyStashInventory: config.requireEmptyStashInventory === true,
    allowBaseWorktreePreserveReset: config.allowBaseWorktreePreserveReset === true,
    allowDirtyPaths: uniqueStrings(Array.isArray(supportedInput.allowDirtyPaths) ? supportedInput.allowDirtyPaths : []),
    goal: normalizeGoalConfig(supportedInput.goal),
    protectedPaths: normalizeProtectedPaths(Array.isArray(config.protectedPaths) ? config.protectedPaths : []),
    protectedBranches,
    trustedUpstreamRemotes: uniqueStrings(Array.isArray(supportedInput.trustedUpstreamRemotes) ? supportedInput.trustedUpstreamRemotes : []),
    lockTimeoutMs: typeof config.lockTimeoutMs === "number" && Number.isFinite(config.lockTimeoutMs) ? config.lockTimeoutMs : DEFAULT_CONFIG.lockTimeoutMs,
  };
}

export async function loadConfig(repoRoot: string, options: LoadConfigOptions = {}): Promise<NormalizedLoadedGuardianConfig> {
  const fileSystem = options.fs ?? fs;
  const configPath = options.configPath ?? path.join(repoRoot, CONFIG_PATH);
  let parsed: RecordLike = {};

  try {
    const raw = await fileSystem.readFile(configPath, "utf8");
    const value: unknown = JSON.parse(raw);
    if (!isRecordLike(value)) {
      throw configError("invalid_config_root", "Worktree Guardian config root must be an object");
    }
    parsed = value;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  return {
    config: normalizeConfig(parsed),
    path: configPath,
    loaded: Object.keys(parsed).length > 0,
  };
}

export function defaultConfigFileContent() {
  return DEFAULT_CONFIG_TEMPLATE.endsWith("\n") ? DEFAULT_CONFIG_TEMPLATE : `${DEFAULT_CONFIG_TEMPLATE}\n`;
}

async function configFileExists(configPath: string) {
  try {
    await fs.access(configPath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export async function initializeConfig(repoRoot: string): Promise<Record<string, unknown>> {
  const configPath = path.join(repoRoot, CONFIG_PATH);
  if (await configFileExists(configPath)) {
    const loaded = await loadConfig(repoRoot);
    return { ok: true, status: "exists", repoRoot, configPath, created: false, config: loaded.config, loaded: loaded.loaded };
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  try {
    await fs.writeFile(configPath, defaultConfigFileContent(), { flag: "wx" });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const loaded = await loadConfig(repoRoot);
  return { ok: true, status: "created", repoRoot, configPath, created: true, config: loaded.config, loaded: loaded.loaded };
}

export function expandWorktreeRoot(template: string, repoRoot: string) {
  const repoName = path.basename(repoRoot);
  return template.replaceAll("$REPO", repoName);
}
