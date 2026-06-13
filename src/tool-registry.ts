import { guardianDeletePaths } from "./delete-paths.ts";
import { guardianDeleteWorktree } from "./delete.ts";
import { guardianDone } from "./done.ts";
import { guardianFinish } from "./finish.ts";
import { guardianHygiene } from "./hygiene.ts";
import { guardianPreserve } from "./preserve.ts";
import { guardianRecover, guardianStatus } from "./recover.ts";
import { guardianReportHtml } from "./report.ts";
import { guardianStart } from "./start.ts";
import { guardianUnblockFinish } from "./unblock-finish.ts";
import { guardianFinishWorkflow } from "./workflow.ts";
import type { GuardianToolInput, GuardianToolName, GuardianToolResult } from "./types.ts";
import { isGuardianToolName } from "./types.ts";

type GuardianToolRunner = (input: GuardianToolInput) => Promise<GuardianToolResult>;

export const GUARDIAN_TOOL_RUNNERS = {
  guardian_delete_paths: guardianDeletePaths,
  guardian_delete_worktree: guardianDeleteWorktree,
  guardian_done: guardianDone,
  guardian_finish: guardianFinish,
  guardian_finish_workflow: guardianFinishWorkflow,
  guardian_hygiene: guardianHygiene,
  guardian_preserve: guardianPreserve,
  guardian_recover: guardianRecover,
  guardian_report_html: guardianReportHtml,
  guardian_start: guardianStart,
  guardian_status: guardianStatus,
  guardian_unblock_finish: guardianUnblockFinish,
} satisfies Record<GuardianToolName, GuardianToolRunner>;

export async function runGuardianTool(name: GuardianToolName | string, input: GuardianToolInput = {}): Promise<GuardianToolResult> {
  if (isGuardianToolName(name)) return GUARDIAN_TOOL_RUNNERS[name](input);
  throw new Error(`Unknown guardian tool: ${name}`);
}
