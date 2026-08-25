import type { GuardCommandPayload, GuardianToolName, PlanCacheToolArgs, PlanTokenCache } from "../types.ts";
import { isMutableRecord } from "../types.ts";
import { normalizeAllowedRemoteBranches } from "../final-postflight.ts";
import { quarantinePlanCacheKey } from "../quarantine-tool.ts";

export function ensureToolArgs(output: GuardCommandPayload = {}) {
  if (!isMutableRecord(output.args)) output.args = {};
  return output.args;
}

function sortedStringArgs(value: unknown) {
  if (!Array.isArray(value)) return [];
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return [...new Set(strings)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export function normalizeOptionalToolStrings(toolArgs: PlanCacheToolArgs) {
  for (const key of ["repoRoot", "cwd", "sessionId", "branch", "targetPath", "worktreePath", "confirmToken"]) {
    if (typeof toolArgs[key] === "string" && toolArgs[key].trim() === "") delete toolArgs[key];
  }
}

async function planCacheKey(name: GuardianToolName, toolArgs: PlanCacheToolArgs, plannedConfirmToken?: string): Promise<string | null> {
  if (name === "guardian_quarantine") return await quarantinePlanCacheKey(toolArgs, plannedConfirmToken);
  return JSON.stringify({
    name,
    sessionId: typeof toolArgs.sessionId === "string" ? toolArgs.sessionId : "",
    repoRoot: typeof toolArgs.repoRoot === "string" ? toolArgs.repoRoot : "",
    cwd: typeof toolArgs.cwd === "string" ? toolArgs.cwd : "",
    paths: sortedStringArgs(toolArgs.paths),
    intentionalPaths: sortedStringArgs(toolArgs.intentionalPaths),
    cleanupPaths: sortedStringArgs(toolArgs.cleanupPaths),
    allowCategories: sortedStringArgs(toolArgs.allowCategories),
    allowedRemoteBranches: normalizeAllowedRemoteBranches(toolArgs.allowedRemoteBranches),
    allowTracked: toolArgs.allowTracked === true,
    allowRecursive: toolArgs.allowRecursive === true,
    allowDirtyNestedGit: toolArgs.allowDirtyNestedGit === true,
    rescue: toolArgs.rescue === true,
    primary: toolArgs.primary === true,
    commitMessage: typeof toolArgs.commitMessage === "string" ? toolArgs.commitMessage : "",
    finishMode: typeof toolArgs.finishMode === "string" ? toolArgs.finishMode : "",
    deleteBranch: toolArgs.deleteBranch === true,
    abandonUnmerged: toolArgs.abandonUnmerged === true,
    allowIgnoredFiles: toolArgs.allowIgnoredFiles === true,
    allowAdminBypass: toolArgs.allowAdminBypass === true,
    action: typeof toolArgs.action === "string" ? toolArgs.action : "",
    quarantineId: typeof toolArgs.quarantineId === "string" ? toolArgs.quarantineId : "",
    targetWorktreePath: typeof toolArgs.targetWorktreePath === "string" ? toolArgs.targetWorktreePath : "",
    timestamp: typeof toolArgs.timestamp === "string" ? toolArgs.timestamp : "",
  });
}

function isPlaceholderConfirmToken(value: unknown) {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  return normalized === "" || normalized === "CONFIRM_DELETE";
}

function shouldUseCachedPlanToken(name: GuardianToolName, toolArgs: PlanCacheToolArgs) {
  if (toolArgs.mode !== "apply") return false;
  if (name === "guardian_delete_paths") return toolArgs.confirmDelete === true;
  if (name === "guardian_hygiene") return toolArgs.confirmDelete === true;
  if (name === "guardian_gc") return toolArgs.confirmDelete === true;
  if (name === "guardian_quarantine") return toolArgs.action === "restore" ? toolArgs.confirm === true : toolArgs.action === "purge" && toolArgs.confirmDelete === true;
  if (name === "guardian_done" || name === "guardian_finish_workflow" || name === "guardian_goal") return toolArgs.confirm === true;
  return false;
}

function isCacheablePlanStatus(status: unknown): boolean {
  return status === "planned" || status === "planned-partial" || status === "rescue-planned";
}

export async function maybeInjectPlanConfirmToken(name: GuardianToolName, toolArgs: PlanCacheToolArgs, planCache?: PlanTokenCache): Promise<void> {
  if (!planCache || !shouldUseCachedPlanToken(name, toolArgs)) return;
  if (typeof toolArgs.confirmToken === "string" && !isPlaceholderConfirmToken(toolArgs.confirmToken)) return;
  const key = await planCacheKey(name, toolArgs);
  if (key === null) return;
  const cachedToken = planCache.get(key);
  if (cachedToken) toolArgs.confirmToken = cachedToken;
}

export async function rememberPlanConfirmToken(name: GuardianToolName, toolArgs: PlanCacheToolArgs, result: { readonly ok?: unknown; readonly status?: unknown; readonly confirmToken?: unknown }, planCache?: PlanTokenCache): Promise<void> {
  if (!planCache) return;
  if (toolArgs.mode !== "plan" || result.ok !== true || !isCacheablePlanStatus(result.status) || typeof result.confirmToken !== "string") return;
  if (!["guardian_delete_paths", "guardian_hygiene", "guardian_done", "guardian_finish_workflow", "guardian_goal", "guardian_gc", "guardian_quarantine"].includes(name)) return;
  const key = await planCacheKey(name, toolArgs, result.confirmToken);
  if (key !== null) planCache.set(key, result.confirmToken);
}
