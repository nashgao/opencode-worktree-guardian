import WorktreeGuardianPlugin from "./plugin/server.ts";

export { DEFAULT_CONFIG, FINISH_MODES, loadConfig, normalizeConfig } from "./config.ts";
export { classifyGuardCommand, classifyNormalAgentGitCommand, classifyReadOnlyInspectionCommand, extractCommandText, tokenizeCommand } from "./guards.ts";
export { guardianDeletePaths } from "./delete-paths.ts";
export { guardianDeleteWorktree } from "./delete.ts";
export { guardianDone } from "./done.ts";
export { buildPreservedRef, buildSafetyRef, createSafetyRef, deleteBranch, getRepoRoot, listWorktrees, removeWorktree, runGit } from "./git.ts";
export { scanWorkspaceHygiene } from "./hygiene.ts";
export { acquireStateLock, appendEvent, getGuardianPaths, readState, recordSession, updateState, writeReportAtomic, writeStateAtomic } from "./state.ts";
export { guardianFinish } from "./finish.ts";
export { guardianRecover, guardianStatus } from "./recover.ts";
export { guardianReportHtml, renderGuardianReportHtml } from "./report.ts";
export { buildInvisiblePolicy, collectKnownWorktreePaths, guardianPreserve, guardianStart, injectInvisiblePolicy, recordLastSafeState, resolveSessionWorktree, rewriteGuardianCommand, runGuardianTool } from "./tools.ts";
export { guardianUnblockFinish } from "./unblock-finish.ts";
export type * from "./types.ts";

export default WorktreeGuardianPlugin;
