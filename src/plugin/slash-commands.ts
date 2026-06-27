import type { GuardianToolInput } from "../types.ts";

export function rewriteGuardianCommand(input: GuardianToolInput = {}, output: GuardianToolInput = {}) {
  const command = input?.command;
  if (typeof command !== "string") return false;
  const match = command.trim().match(/^\/?guardian\s+(done|status|project-status|finish-workflow|finish|preserve|recover|report|start|hygiene|gc|delete-paths|delete-worktree|unblock-finish)(?:\s+(.*))?$/);
  if (!match) return false;
  const action = match[1];
  const rest = match[2] ?? "";
  if (!action) return false;
  const toolName = action === "report" ? "guardian_report_html" : action === "project-status" ? "guardian_project_status" : action === "delete-worktree" ? "guardian_delete_worktree" : action === "delete-paths" ? "guardian_delete_paths" : action === "unblock-finish" ? "guardian_unblock_finish" : action === "finish-workflow" ? "guardian_finish_workflow" : `guardian_${action}`;
  const deleteGuidance = action === "delete-worktree" ? " Run mode=plan first. Dirty targets block by default; use allowRedundantDirtyPaths=true only in direct plan/apply when Guardian proves each dirty path already matches the fetched base tree and reports dirtySnapshotRef. Stale local Guardian branch cleanup requires an exact branch or terminal sessionId plus deleteBranch=true and Guardian ownership proof from terminal state or safety refs. Intentional unmerged local abandonment requires deleteBranch=true plus abandonUnmerged=true in both plan and apply after inspecting unmerged commit evidence." : "";
  const deletePathsGuidance = action === "delete-paths" ? " Run mode=plan first with exact paths, inspect target status and blockers, get explicit user confirmation, then apply with confirmDelete=true. Tracked source deletion requires allowTracked=true; directory deletion requires allowRecursive=true." : "";
  const hygieneCleanupGuidance = action === "hygiene" ? " With no mode it scans only. For cleanup, run mode=plan first, inspect exact targets/blockers, get explicit user confirmation, then apply with confirmDelete=true." : "";
  const doneGuidance = action === "done" ? " Run mode=plan first. Active session apply requires explicit confirmation with confirm=true; when the session is dirty, include commitMessage so Guardian can commit before creating or reusing the PR, merging it, proving remote-base reachability, then removing the stale worktree and local branch. Dirty primary-main publishing also requires commitMessage and confirm=true; publish cleanup returns a separate cleanup plan. Admin bypass requires allowAdminBypass=true." : "";
  const projectStatusGuidance = action === "project-status" ? " Treat default output as read-only evidence. writeReport=true is the only report write and writes the static project intelligence HTML report." : "";
  const text = `Use the ${toolName} native tool.${deleteGuidance}${deletePathsGuidance}${hygieneCleanupGuidance}${doneGuidance}${projectStatusGuidance}${rest.trim() ? ` User arguments: ${rest.trim()}` : ""}`;
  if (!output || typeof output !== "object") return false;
  output.parts = [{ type: "text", text }];
  return true;
}
