import type { GuardianToolInput } from "../types.ts";

export function rewriteGuardianCommand(input: GuardianToolInput = {}, output: GuardianToolInput = {}) {
  const command = input?.command;
  if (typeof command !== "string") return false;
  const match = command.trim().match(/^\/?guardian\s+(done|status|finish-workflow|finish|preserve|recover|report|start|hygiene|delete-paths|delete-worktree|unblock-finish)(?:\s+(.*))?$/);
  if (!match) return false;
  const action = match[1];
  const rest = match[2] ?? "";
  if (!action) return false;
  const toolName = action === "report" ? "guardian_report_html" : action === "delete-worktree" ? "guardian_delete_worktree" : action === "delete-paths" ? "guardian_delete_paths" : action === "unblock-finish" ? "guardian_unblock_finish" : action === "finish-workflow" ? "guardian_finish_workflow" : `guardian_${action}`;
  const deleteGuidance = action === "delete-worktree" ? " Run mode=plan first. Stale local Guardian branch cleanup requires an exact branch or terminal sessionId plus deleteBranch=true and Guardian ownership proof from terminal state or safety refs. Intentional unmerged local abandonment requires deleteBranch=true plus abandonUnmerged=true in both plan and apply after inspecting unmerged commit evidence." : "";
  const deletePathsGuidance = action === "delete-paths" ? " Run mode=plan first with exact paths, inspect target status and blockers, get explicit user confirmation, then apply with confirmDelete=true. Tracked source deletion requires allowTracked=true; directory deletion requires allowRecursive=true." : "";
  const hygieneCleanupGuidance = action === "hygiene" ? " With no mode it scans only. For cleanup, run mode=plan first, inspect exact targets/blockers, get explicit user confirmation, then apply with confirmDelete=true." : "";
  const doneGuidance = action === "done" ? " Run mode=plan first. Dirty primary-main publishing requires an explicit commitMessage and explicit user confirmation; apply with confirm=true so the plugin reuses the matching internal plan token. Cleanup after publish returns a separate cleanup plan and must not be silently applied." : "";
  const text = `Use the ${toolName} native tool.${deleteGuidance}${deletePathsGuidance}${hygieneCleanupGuidance}${doneGuidance}${rest.trim() ? ` User arguments: ${rest.trim()}` : ""}`;
  if (!output || typeof output !== "object") return false;
  output.parts = [{ type: "text", text }];
  return true;
}
