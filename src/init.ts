import path from "node:path";
import { initializeConfig } from "./config.ts";
import { getRepoRoot } from "./git.ts";
import type { GuardianToolInput, GuardianToolResult } from "./types.ts";

export async function guardianInit(input: GuardianToolInput = {}): Promise<GuardianToolResult> {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const requestedRoot = typeof input.repoRoot === "string" ? input.repoRoot : cwd;
  const repoRoot = path.resolve(await getRepoRoot(requestedRoot));
  const result = await initializeConfig(repoRoot);
  return { ...result, cwd, suggestedCommands: ["guardian_status"] };
}
