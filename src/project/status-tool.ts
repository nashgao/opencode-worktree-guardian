import { collectProjectSnapshot } from "./snapshot.ts";
import { writeProjectReportForSnapshot } from "./report.ts";
import type { CollectProjectSnapshotInput, ProjectSnapshot } from "./types.ts";
import type { GuardianToolInput, GuardianToolResult } from "../types.ts";

type ProjectStatusResult = GuardianToolResult & ProjectSnapshot & {
  readonly reportPath?: string;
};

function statusInput(input: GuardianToolInput): CollectProjectSnapshotInput {
  return {
    ...(typeof input.repoRoot === "string" ? { repoRoot: input.repoRoot } : {}),
    ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
    ...(Array.isArray(input.projectRoots) ? { projectRoots: input.projectRoots } : {}),
  };
}

export async function guardianProjectStatus(input: GuardianToolInput = {}): Promise<ProjectStatusResult> {
  const snapshot = await collectProjectSnapshot(statusInput(input));
  if (input.writeReport === true) {
    const report = await writeProjectReportForSnapshot(snapshot);
    return { ...snapshot, reportPath: report.reportPath };
  }
  return snapshot;
}
