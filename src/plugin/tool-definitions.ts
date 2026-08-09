import type { PlanTokenCache } from "../types.ts";
import { guardianTool } from "./native-tool.ts";

export function createTools(planCache: PlanTokenCache) {
  return {
    guardian_done: guardianTool("guardian_done", "Plan or apply the safest implementation-done path for this repository state, including default repo-wide session finish, local base sync, and redundant cleanup sweep planning.", planCache),
    guardian_start: guardianTool("guardian_start", "Create or attach this OpenCode session to a guardian-owned worktree.", planCache),
    guardian_status: guardianTool("guardian_status", "Report guardian state, worktrees, safety refs, stash inventory, and blockers without mutating the repo.", planCache),
    guardian_delete_paths: guardianTool("guardian_delete_paths", "Plan or apply exact path deletion with confirm-token, fingerprint, tracked-file, recursive, and protected-root gates.", planCache),
    guardian_delete_worktree: guardianTool("guardian_delete_worktree", "Plan or apply safe Guardian-mediated worktree deletion with confirm-token and safety-ref gates.", planCache),
    guardian_unblock_finish: guardianTool("guardian_unblock_finish", "Plan or apply safe finish blocker resolution, such as committing review artifacts with confirm-token gates.", planCache),
    guardian_finish_workflow: guardianTool("guardian_finish_workflow", "Plan or apply an implementation-done workflow that verifies clean state and removes redundant merged worktrees and branches through Guardian gates.", planCache),
    guardian_finish: guardianTool("guardian_finish", "Apply the configured gated finish mode for the current Guardian worktree.", planCache),
    guardian_preserve: guardianTool("guardian_preserve", "Mark the current Guardian worktree as terminal/preserved with a safety ref.", planCache),
    guardian_goal: guardianTool("guardian_goal", "Plan or apply config.goal through Guardian gates. Plans report complete=null; strict actionable plans may be planned-partial. After apply inspect complete and hygienePostcondition: ok=true/status=partial/complete=false is possible. Cleanup remains limited to token-bound known-cleanable findings.", planCache),
    guardian_project_status: guardianTool("guardian_project_status", "Read project roadmap, milestone, plan, and ULW evidence into a static project intelligence snapshot.", planCache),
    guardian_recover: guardianTool("guardian_recover", "List recovery refs, orphaned sessions, stash inventory, and suggested recovery commands without mutation.", planCache),
    guardian_report_html: guardianTool("guardian_report_html", "Write a static offline HTML report for guardian sessions, worktrees, branches, risks, and recovery commands.", planCache),
    guardian_hygiene: guardianTool("guardian_hygiene", "Scan, plan, or apply token-gated cleanup for workspace hygiene findings.", planCache),
    guardian_init: guardianTool("guardian_init", "Write the default repo-local Guardian config if it is missing, without creating sessions or worktrees.", planCache),
    guardian_gc: guardianTool("guardian_gc", "Plan or apply record-only Guardian state cleanup of stale terminal, poisoned, and orphaned session records.", planCache),
  };
}
