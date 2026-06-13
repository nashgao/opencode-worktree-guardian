import { formatGuardianDeleteOutput, formatGuardianDeletePathsOutput, formatGuardianHygieneOutput, formatGuardianUnblockFinishOutput } from "./readable-output-cleanup.ts";
import { formatGuardianReportOutput, formatGuardianStatusOutput } from "./readable-output-status.ts";
import { formatGuardianDoneOutput, formatGuardianFinishWorkflowOutput } from "./readable-output-workflow.ts";

export const READABLE_GUARDIAN_TOOLS = new Set(["guardian_status", "guardian_recover", "guardian_report_html", "guardian_hygiene", "guardian_delete_paths", "guardian_delete_worktree", "guardian_unblock_finish", "guardian_finish_workflow", "guardian_done"]);

export function formatGuardianOutput(name: string, result: unknown) {
  if (name === "guardian_report_html") return formatGuardianReportOutput(result);
  if (name === "guardian_hygiene") return formatGuardianHygieneOutput(result);
  if (name === "guardian_delete_paths") return formatGuardianDeletePathsOutput(result);
  if (name === "guardian_delete_worktree") return formatGuardianDeleteOutput(result);
  if (name === "guardian_unblock_finish") return formatGuardianUnblockFinishOutput(result);
  if (name === "guardian_finish_workflow") return formatGuardianFinishWorkflowOutput(result);
  if (name === "guardian_done") return formatGuardianDoneOutput(result);
  return formatGuardianStatusOutput(name, result);
}
