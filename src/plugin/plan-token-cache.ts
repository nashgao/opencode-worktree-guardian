import type { GuardCommandPayload, GuardianToolName, PlanCacheToolArgs, PlanTokenCache } from "../types.ts";
import { isMutableRecord } from "../types.ts";

export function ensureToolArgs(output: GuardCommandPayload = {}) {
  if (!isMutableRecord(output.args)) output.args = {};
  return output.args;
}

function sortedStringArgs(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").sort((left, right) => left.localeCompare(right)) : [];
}

export function normalizeOptionalToolStrings(toolArgs: PlanCacheToolArgs) {
  for (const key of ["repoRoot", "cwd", "sessionId", "branch", "targetPath", "worktreePath", "confirmToken"]) {
    if (typeof toolArgs[key] === "string" && toolArgs[key].trim() === "") delete toolArgs[key];
  }
}

function planCacheKey(name: GuardianToolName, toolArgs: PlanCacheToolArgs) {
  return JSON.stringify({
    name,
    sessionId: typeof toolArgs.sessionId === "string" ? toolArgs.sessionId : "",
    repoRoot: typeof toolArgs.repoRoot === "string" ? toolArgs.repoRoot : "",
    cwd: typeof toolArgs.cwd === "string" ? toolArgs.cwd : "",
    paths: sortedStringArgs(toolArgs.paths),
    cleanupPaths: sortedStringArgs(toolArgs.cleanupPaths),
    allowCategories: sortedStringArgs(toolArgs.allowCategories),
    allowTracked: toolArgs.allowTracked === true,
    allowRecursive: toolArgs.allowRecursive === true,
    allowDirtyNestedGit: toolArgs.allowDirtyNestedGit === true,
    primary: toolArgs.primary === true,
    commitMessage: typeof toolArgs.commitMessage === "string" ? toolArgs.commitMessage : "",
    finishMode: typeof toolArgs.finishMode === "string" ? toolArgs.finishMode : "",
    deleteBranch: toolArgs.deleteBranch === true,
    abandonUnmerged: toolArgs.abandonUnmerged === true,
    allowIgnoredFiles: toolArgs.allowIgnoredFiles === true,
    action: typeof toolArgs.action === "string" ? toolArgs.action : "",
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
  if (name === "guardian_done" || name === "guardian_finish_workflow") return toolArgs.confirm === true || toolArgs.confirmDelete === true;
  return false;
}

function isCacheablePlanStatus(status: unknown): boolean {
  return status === "planned" || status === "planned-partial";
}

export function maybeInjectPlanConfirmToken(name: GuardianToolName, toolArgs: PlanCacheToolArgs, planCache?: PlanTokenCache) {
  if (!planCache || !shouldUseCachedPlanToken(name, toolArgs)) return;
  if (typeof toolArgs.confirmToken === "string" && !isPlaceholderConfirmToken(toolArgs.confirmToken)) return;
  const cachedToken = planCache.get(planCacheKey(name, toolArgs));
  if (cachedToken) toolArgs.confirmToken = cachedToken;
}

export function rememberPlanConfirmToken(name: GuardianToolName, toolArgs: PlanCacheToolArgs, result: { readonly ok?: unknown; readonly status?: unknown; readonly confirmToken?: unknown }, planCache?: PlanTokenCache) {
  if (!planCache) return;
  if (toolArgs.mode !== "plan" || result.ok !== true || !isCacheablePlanStatus(result.status) || typeof result.confirmToken !== "string") return;
  if (!["guardian_delete_paths", "guardian_hygiene", "guardian_done", "guardian_finish_workflow", "guardian_gc"].includes(name)) return;
  planCache.set(planCacheKey(name, toolArgs), result.confirmToken);
}
