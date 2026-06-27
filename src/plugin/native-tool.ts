import { tool } from "@opencode-ai/plugin";
import { resolveSessionWorktree } from "../session/worktree-binding.ts";
import { runGuardianTool } from "../tool-registry.ts";
import type { GuardianNativeToolReturn, GuardianToolInput, GuardianToolName, HookContext, PlanCacheToolArgs, PlanTokenCache } from "../types.ts";
import { normalizeOptionalToolStrings, maybeInjectPlanConfirmToken, rememberPlanConfirmToken } from "./plan-token-cache.ts";
import { formatGuardianOutput, READABLE_GUARDIAN_TOOLS } from "./readable-output.ts";
import { resolveActualWorktreeOrPath } from "./session-routing.ts";

const z = tool.schema;
const SESSION_WORKTREE_DEFAULT_TOOLS = new Set(["guardian_finish", "guardian_preserve"]);

async function getRecordedToolWorktree(name: GuardianToolName, toolArgs: PlanCacheToolArgs, context: HookContext) {
  if (!SESSION_WORKTREE_DEFAULT_TOOLS.has(name)) return null;
  if (typeof toolArgs.repoRoot !== "string" || typeof toolArgs.sessionId !== "string") return null;
  const contextCwd = typeof context?.worktree === "string" ? context.worktree : typeof context?.directory === "string" ? context.directory : toolArgs.repoRoot;
  const actualWorktree = await resolveActualWorktreeOrPath(contextCwd);
  const sessionWorktree = await resolveSessionWorktree({
    repoRoot: toolArgs.repoRoot,
    cwd: contextCwd,
    actualWorktree,
    sessionId: toolArgs.sessionId,
  });
  return typeof sessionWorktree?.expectedWorktree === "string" ? sessionWorktree.expectedWorktree : null;
}

export function guardianTool(name: GuardianToolName, description: string, planCache?: PlanTokenCache) {
  return tool({
    description,
    args: {
      repoRoot: z.string().optional(),
      cwd: z.string().optional(),
      sessionId: z.string().optional(),
      taskName: z.string().optional(),
      branch: z.string().optional(),
      targetPath: z.string().optional(),
      worktreePath: z.string().optional(),
      createWorktree: z.boolean().optional(),
      mode: z.enum(["plan", "apply"]).optional(),
      confirmToken: z.string().optional(),
      confirmDelete: z.boolean().optional(),
      confirm: z.boolean().optional(),
      all: z.boolean().optional(),
      action: z.enum(["commit-review-artifacts"]).optional(),
      commitMessage: z.string().optional(),
      deleteBranch: z.boolean().optional(),
      abandonUnmerged: z.boolean().optional(),
      allowIgnoredFiles: z.boolean().optional(),
      allowRedundantDirtyPaths: z.boolean().optional(),
      paths: z.array(z.string()).optional(),
      allowTracked: z.boolean().optional(),
      allowRecursive: z.boolean().optional(),
      cleanupPaths: z.array(z.string()).optional(),
      allowCategories: z.array(z.enum(["known-cleanable", "nested-git", "suspicious"])).optional(),
      allowDirtyNestedGit: z.boolean().optional(),
      timestamp: z.string().optional(),
      finishMode: z.enum(["preserve-only", "push-branch", "create-pr", "merge-to-base"]).optional(),
      allowMergeToBase: z.boolean().optional(),
      allowAdminBypass: z.boolean().optional(),
      allowBaseWorktreePreserveReset: z.boolean().optional(),
      projectRoots: z.array(z.string()).optional(),
      writeReport: z.boolean().optional(),
    },
    async execute(args: GuardianToolInput, context: HookContext): Promise<GuardianNativeToolReturn> {
      context.metadata?.({ title: name });
      const toolArgs = { ...args };
      normalizeOptionalToolStrings(toolArgs);
      if (toolArgs.repoRoot == null && typeof context?.directory === "string") toolArgs.repoRoot = context.directory;
      const shouldInjectContextSession = name === "guardian_unblock_finish"
        || name !== "guardian_done" && toolArgs.targetPath == null && toolArgs.branch == null;
      if (toolArgs.sessionId == null && shouldInjectContextSession) {
        if (typeof context?.sessionID === "string") toolArgs.sessionId = context.sessionID;
        else if (typeof context?.sessionId === "string") toolArgs.sessionId = context.sessionId;
      }
      if (toolArgs.cwd == null) {
        const recordedWorktree = await getRecordedToolWorktree(name, toolArgs, context);
        if (recordedWorktree) toolArgs.cwd = recordedWorktree;
        else if (typeof context?.worktree === "string") toolArgs.cwd = context.worktree;
        else if (typeof context?.directory === "string") toolArgs.cwd = context.directory;
      }
      maybeInjectPlanConfirmToken(name, toolArgs, planCache);
      const result = await runGuardianTool(name, toolArgs);
      rememberPlanConfirmToken(name, toolArgs, result, planCache);
      return {
        title: name,
        metadata: result,
        output: READABLE_GUARDIAN_TOOLS.has(name) ? formatGuardianOutput(name, result) : JSON.stringify(result, null, 2),
      };
    },
  });
}
