import path from "node:path";
import { getCommonGitDir } from "./git.ts";
import type { GuardianPaths } from "./types.ts";

// Extracted from state.ts so path computation carries no dependency on session/state
// read-write logic or provenance capture. provenance.ts needs only path resolution, and
// importing it from state.ts previously created a cycle: state.ts -> session-provenance.ts
// -> provenance.ts -> state.ts. state.ts re-exports this for existing call sites.
export async function getGuardianPaths(repoRoot: string): Promise<GuardianPaths> {
  const gitDir = await getCommonGitDir(repoRoot);
  const dir = path.join(gitDir, "opencode-guardian");
  return {
    repoRoot,
    gitDir,
    dir,
    statePath: path.join(dir, "state.json"),
    eventsPath: path.join(dir, "events.jsonl"),
    reportPath: path.join(dir, "report.html"),
    lockPath: path.join(dir, "state.lock"),
    lockRef: "refs/opencode-guardian/locks/state",
    lockTmpDir: path.join(dir, "lock-tmp"),
    lockTombstonesDir: path.join(dir, "lock-tombstones"),
    provenanceDir: path.join(dir, "provenance"),
    quarantineDir: path.join(dir, "quarantine"),
    journalDir: path.join(dir, "journal"),
  };
}
