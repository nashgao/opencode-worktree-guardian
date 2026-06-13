import { runGuardianHygieneMode } from "./hygiene-apply.ts";
import { scanWorkspaceHygiene } from "./hygiene-scan.ts";

export type { HygieneCategory, HygieneSeverity } from "./hygiene-scan.ts";
export { scanWorkspaceHygiene } from "./hygiene-scan.ts";

export async function guardianHygiene(input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  if (input.mode != null) return runGuardianHygieneMode(input);
  return scanWorkspaceHygiene(input);
}
