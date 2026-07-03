import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeProtectedPaths } from "./protected-paths.ts";
import type { GuardianAutoStartMode, GuardianConfig, GuardianFinishMode, LoadedGuardianConfig, LoadConfigOptions, RecordLike } from "./types.ts";
import { errorCode, isRecordLike } from "./types.ts";

export const CONFIG_PATH = path.join(".opencode", "worktree-guardian.json");
const DEFAULT_CONFIG_TEMPLATE_URL = new URL("../templates/worktree-guardian.json", import.meta.url);
const DEFAULT_CONFIG_TEMPLATE = readFileSync(DEFAULT_CONFIG_TEMPLATE_URL, "utf8");

export const FINISH_MODES = new Set(["preserve-only", "push-branch", "create-pr", "merge-to-base"]);
export const AUTO_START_MODES = new Set(["eager", "lazy"]);

export type ConfigErrorKind = "unsupported_finish_mode" | "unsupported_auto_start_mode";
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

function parseDefaultConfigTemplate(raw: string): GuardianConfig {
  const value: unknown = JSON.parse(raw);
  if (!isRecordLike(value)) throw templateError("root must be an object");
  const finishMode = value.finishMode;
  if (!isGuardianFinishMode(finishMode)) throw templateError("finishMode is unsupported");
  const autoStartMode = value.autoStartMode;
  if (!isGuardianAutoStartMode(autoStartMode)) throw templateError("autoStartMode is unsupported");
  return {
    remote: stringField(value, "remote"),
    baseBranch: stringField(value, "baseBranch"),
    worktreeRoot: stringField(value, "worktreeRoot"),
    branchPrefix: stringField(value, "branchPrefix"),
    finishMode,
    autoStart: booleanField(value, "autoStart"),
    autoStartMode,
    autoFinish: booleanField(value, "autoFinish"),
    autoCleanup: booleanField(value, "autoCleanup"),
    safetyRefRetentionDays: numberField(value, "safetyRefRetentionDays"),
    allowStashIfUnrelated: booleanField(value, "allowStashIfUnrelated"),
    allowBaseWorktreePreserveReset: booleanField(value, "allowBaseWorktreePreserveReset"),
    allowDirtyPaths: uniqueStrings(stringArrayField(value, "allowDirtyPaths")),
    protectedPaths: normalizeProtectedPaths(stringArrayField(value, "protectedPaths")),
    protectedBranches: uniqueStrings(stringArrayField(value, "protectedBranches")),
    trustedUpstreamRemotes: uniqueStrings(stringArrayField(value, "trustedUpstreamRemotes")),
    lockTimeoutMs: numberField(value, "lockTimeoutMs"),
  };
}

export const DEFAULT_CONFIG: GuardianConfig = Object.freeze(parseDefaultConfigTemplate(DEFAULT_CONFIG_TEMPLATE));

export function normalizeConfig(input: RecordLike = {}): GuardianConfig {
  const config = { ...DEFAULT_CONFIG, ...input };
  if (!isGuardianFinishMode(config.finishMode)) {
    throw configError("unsupported_finish_mode", `Unsupported worktree guardian finishMode: ${String(config.finishMode)}`);
  }
  if (!isGuardianAutoStartMode(config.autoStartMode)) {
    throw configError("unsupported_auto_start_mode", `Unsupported worktree guardian autoStartMode: ${String(config.autoStartMode)}`);
  }

  const protectedBranches = uniqueStrings([
    ...DEFAULT_CONFIG.protectedBranches,
    ...(Array.isArray(input.protectedBranches) ? input.protectedBranches : []),
  ]);

  return {
    ...config,
    autoStart: config.autoStart !== false,
    autoStartMode: config.autoStartMode,
    autoFinish: config.autoFinish === true,
    autoCleanup: config.autoCleanup === true,
    allowStashIfUnrelated: config.allowStashIfUnrelated === true,
    allowBaseWorktreePreserveReset: config.allowBaseWorktreePreserveReset === true,
    allowDirtyPaths: uniqueStrings(Array.isArray(input.allowDirtyPaths) ? input.allowDirtyPaths : []),
    protectedPaths: normalizeProtectedPaths(Array.isArray(config.protectedPaths) ? config.protectedPaths : []),
    protectedBranches,
    trustedUpstreamRemotes: uniqueStrings(Array.isArray(input.trustedUpstreamRemotes) ? input.trustedUpstreamRemotes : []),
    lockTimeoutMs: typeof config.lockTimeoutMs === "number" && Number.isFinite(config.lockTimeoutMs) ? config.lockTimeoutMs : DEFAULT_CONFIG.lockTimeoutMs,
  };
}

export async function loadConfig(repoRoot: string, options: LoadConfigOptions = {}): Promise<LoadedGuardianConfig> {
  const fileSystem = options.fs ?? fs;
  const configPath = options.configPath ?? path.join(repoRoot, CONFIG_PATH);
  let parsed: RecordLike = {};

  try {
    const raw = await fileSystem.readFile(configPath, "utf8");
    const value: unknown = JSON.parse(raw);
    parsed = isRecordLike(value) ? value : {};
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
