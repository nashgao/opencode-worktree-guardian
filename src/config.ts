import fs from "node:fs/promises";
import path from "node:path";

export const CONFIG_PATH = path.join(".opencode", "worktree-guardian.json");

export const FINISH_MODES = new Set(["preserve-only", "push-branch", "create-pr", "merge-to-base"]);

export const DEFAULT_CONFIG: Record<string, any> = Object.freeze({
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
  allowDirtyPaths: [],
  protectedBranches: ["main", "master", "develop", "production"],
  lockTimeoutMs: 5_000,
});

function uniqueStrings(values: unknown[]) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

export function normalizeConfig(input: Record<string, any> = {}): Record<string, any> {
  const config: Record<string, any> = { ...DEFAULT_CONFIG, ...input };
  if (!FINISH_MODES.has(config.finishMode)) {
    throw new Error(`Unsupported worktree guardian finishMode: ${config.finishMode}`);
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
    allowDirtyPaths: uniqueStrings(Array.isArray(input.allowDirtyPaths) ? input.allowDirtyPaths : []),
    protectedBranches,
    lockTimeoutMs: Number.isFinite(config.lockTimeoutMs) ? config.lockTimeoutMs : DEFAULT_CONFIG.lockTimeoutMs,
  };
}

export async function loadConfig(repoRoot: string, options: Record<string, any> = {}): Promise<Record<string, any>> {
  const fileSystem = options.fs ?? fs;
  const configPath = options.configPath ?? path.join(repoRoot, CONFIG_PATH);
  let parsed = {};

  try {
    const raw = await fileSystem.readFile(configPath, "utf8");
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
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
