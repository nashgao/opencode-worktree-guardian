import { formatGuardianDeleteOutput, formatGuardianDeletePathsOutput, formatGuardianHygieneOutput, formatGuardianQuarantineOutput, formatGuardianUnblockFinishOutput } from "./readable-output-cleanup.ts";
import { formatGuardianFinishWorkflowOutput } from "./readable-output-finish-workflow.ts";
import { formatGuardianGoalOutput } from "./readable-output-goal.ts";
import { formatGuardianInitOutput, formatGuardianReportOutput, formatGuardianStatusOutput } from "./readable-output-status.ts";
import { formatGuardianDoneOutput } from "./readable-output-workflow.ts";
import { formatProjectStatusOutput } from "../project/readable-output.ts";

export const READABLE_GUARDIAN_TOOLS = new Set(["guardian_status", "guardian_recover", "guardian_report_html", "guardian_project_status", "guardian_hygiene", "guardian_init", "guardian_delete_paths", "guardian_delete_worktree", "guardian_quarantine", "guardian_unblock_finish", "guardian_finish_workflow", "guardian_done", "guardian_goal"]);

export function formatGuardianOutput(name: string, result: unknown) {
  if (name === "guardian_report_html") return formatGuardianReportOutput(result);
  if (name === "guardian_project_status") return formatProjectStatusOutput(result);
  if (name === "guardian_init") return formatGuardianInitOutput(result);
  if (name === "guardian_hygiene") return formatGuardianHygieneOutput(result);
  if (name === "guardian_delete_paths") return formatGuardianDeletePathsOutput(result);
  if (name === "guardian_delete_worktree") return formatGuardianDeleteOutput(result);
  if (name === "guardian_quarantine") return formatGuardianQuarantineOutput(result);
  if (name === "guardian_unblock_finish") return formatGuardianUnblockFinishOutput(result);
  if (name === "guardian_finish_workflow") return formatGuardianFinishWorkflowOutput(result);
  if (name === "guardian_done") return formatGuardianDoneOutput(result);
  if (name === "guardian_goal") return formatGuardianGoalOutput(result);
  return formatGuardianStatusOutput(name, result);
}
