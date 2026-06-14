import fs from "node:fs/promises";
import path from "node:path";
import type { GuardianConfig, GuardianFinishMode, LoadedGuardianConfig, LoadConfigOptions, RecordLike } from "./types.ts";
import { errorCode, isRecordLike } from "./types.ts";

export const CONFIG_PATH = path.join(".opencode", "worktree-guardian.json");

export const FINISH_MODES = new Set(["preserve-only", "push-branch", "create-pr", "merge-to-base"]);

export const DEFAULT_CONFIG: GuardianConfig = Object.freeze({
  remote: "origin",
  baseBranch: "main",
  worktreeRoot: ".worktrees/$REPO",
  branchPrefix: "guardian/",
  finishMode: "create-pr",
  autoStart: true,
  autoFinish: false,
  autoCleanup: false,
  safetyRefRetentionDays: 30,
  allowStashIfUnrelated: false,
  allowBaseWorktreePreserveReset: false,
  allowDirtyPaths: [],
  protectedBranches: ["main", "master", "develop", "production"],
  lockTimeoutMs: 5_000,
});

export type ConfigErrorKind = "unsupported_finish_mode";
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

export function normalizeConfig(input: RecordLike = {}): GuardianConfig {
  const config = { ...DEFAULT_CONFIG, ...input };
  if (!isGuardianFinishMode(config.finishMode)) {
    throw configError("unsupported_finish_mode", `Unsupported worktree guardian finishMode: ${String(config.finishMode)}`);
  }

  const protectedBranches = uniqueStrings([
    ...DEFAULT_CONFIG.protectedBranches,
    ...(Array.isArray(input.protectedBranches) ? input.protectedBranches : []),
  ]);

  return {
    ...config,
    autoStart: config.autoStart !== false,
    autoFinish: config.autoFinish === true,
    autoCleanup: config.autoCleanup === true,
    allowStashIfUnrelated: config.allowStashIfUnrelated === true,
    allowBaseWorktreePreserveReset: config.allowBaseWorktreePreserveReset === true,
    allowDirtyPaths: uniqueStrings(Array.isArray(input.allowDirtyPaths) ? input.allowDirtyPaths : []),
    protectedBranches,
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

export function expandWorktreeRoot(template: string, repoRoot: string) {
  const repoName = path.basename(repoRoot);
  return template.replaceAll("$REPO", repoName);
}
