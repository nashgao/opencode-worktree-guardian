import fs from "node:fs/promises";
import path from "node:path";
import { expandWorktreeRoot, loadConfig, normalizeConfig } from "./config.ts";
import { realPathOrResolved, samePathOnDisk } from "./done-shared.ts";
import { getCommonGitDir, getDirtyFiles, getRepoRoot, listBranches, listRecoveryCandidates, listRefs, listStashes, listWorktrees } from "./git.ts";
import { scanWorkspaceHygiene } from "./hygiene.ts";
import { isActiveSession, isTerminalSession } from "./lifecycle.ts";
import { collectActiveSessionBaseDistances } from "./status-base-distance.ts";
import { terminalRecoveryPlans } from "./status-terminal-recovery.ts";
import { getGuardianPaths, readState } from "./state.ts";
import { cachedRemoteBranchCountReadOnly, listRemoteNamesReadOnly, operationalScope } from "./operational-scope.ts";
import type { GuardianConfig, GuardianSession, GuardianToolInput, LoadedGuardianConfig, WorktreeEntry } from "./types.ts";
import { errorMessage, isRecordLike } from "./types.ts";
import type { AnnotatedWorktreeEntry, GuardianRecoverResult, GuardianStatusResult, PoisonedSession, WorktreeAnnotationMetadata } from "./status-result-types.ts";

async function pathExists(candidate: string) {
  try {
    await fs.access(candidate);
    return true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return false;
  }
}

async function canonicalPathSet(paths: readonly string[]): Promise<ReadonlySet<string>> {
  const canonicalPaths = await Promise.all(paths.map((entry) => realPathOrResolved(entry)));
  return new Set(canonicalPaths.map((entry) => path.resolve(entry)));
}

function isInside(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isTempPath(candidate: string) {
  const normalized = path.resolve(candidate);
  return path.basename(normalized).startsWith("opencode-") || normalized.includes(path.sep + "opencode" + path.sep) || normalized.includes(path.sep + "var" + path.sep + "folders" + path.sep) || normalized.startsWith(path.resolve("/private/tmp")) || normalized.startsWith(path.resolve("/tmp"));
}

async function annotateWorktreeWithoutState(worktree: WorktreeEntry, repoRoot: string, config: GuardianConfig): Promise<AnnotatedWorktreeEntry> {
  const worktreePath = path.resolve(worktree.path);
  const guardianRoot = path.resolve(repoRoot, expandWorktreeRoot(config.worktreeRoot, repoRoot));
  if (isInside(worktreePath, guardianRoot)) return worktree;

  let metadata: WorktreeAnnotationMetadata = { guardianRoot };
  try {
    metadata = { ...metadata, commonGitDir: await getCommonGitDir(worktreePath) };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    metadata = { ...metadata, commonGitDirError: errorMessage(error) };
  }

  return {
    ...worktree,
    category: isTempPath(worktreePath) ? "external-temp-worktree" : "external-worktree",
    severity: "fail",
    reason: "linked Git worktree is outside Guardian ownership and outside the configured Guardian worktree root",
    metadata,
  };
}

async function poisonedSessionReason(session: GuardianSession, repoRoot: string, config: GuardianConfig) {
  const reasons: string[] = [];
  if (typeof session.worktree_path === "string" && await samePathOnDisk(session.worktree_path, repoRoot)) {
    reasons.push("active session is recorded on the primary repository worktree");
  }
  if (typeof session.branch === "string" && Array.isArray(config.protectedBranches) && config.protectedBranches.includes(session.branch)) {
    reasons.push("active session branch is protected");
  }
  return reasons.join("; ");
}

async function annotatePoisonedSession(session: GuardianSession, repoRoot: string, config: GuardianConfig): Promise<PoisonedSession | null> {
  const reason = await poisonedSessionReason(session, repoRoot, config);
  if (!reason) return null;
  return {
    ...session,
    severity: "fail",
    reason,
    suggestedCommand: "guardian_start createWorktree=true",
  };
}

type StatusConfig = {
  readonly config: GuardianConfig;
  readonly path: string | null;
  readonly loaded: boolean;
  readonly source: "defaults" | "file" | "input";
};

function statusConfigFromLoaded(loaded: LoadedGuardianConfig): StatusConfig {
  return {
    config: loaded.config,
    path: loaded.path,
    loaded: loaded.loaded,
    source: loaded.loaded ? "file" : "defaults",
  };
}

async function configFromInput(input: GuardianToolInput, repoRoot: string): Promise<StatusConfig> {
  if (input.config === undefined || input.config === null) return statusConfigFromLoaded(await loadConfig(repoRoot));
  if (!isRecordLike(input.config)) throw new Error("config must be an object");
  return { config: normalizeConfig(input.config), path: null, loaded: true, source: "input" };
}

export async function guardianStatus(input: GuardianToolInput = {}): Promise<GuardianStatusResult> {
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const statusConfig = await configFromInput(input, repoRoot);
  const config = statusConfig.config;
  const paths = await getGuardianPaths(repoRoot);
  const state = await readState(paths, { repoRoot, config });
  const worktrees = await listWorktrees(repoRoot);
  const canonicalRepoRoot = path.resolve(await realPathOrResolved(repoRoot));
  const worktreeEntries = await Promise.all(worktrees.map(async (entry) => ({
    entry,
    canonicalPath: path.resolve(await realPathOrResolved(entry.path)),
  })));
  const worktreePaths = new Set(worktreeEntries.map((entry) => entry.canonicalPath));
  const sessions = Object.values(state.sessions ?? {});
  const activeSessions = sessions.filter(isActiveSession);
  const terminalSessions = sessions.filter(isTerminalSession);
  const sessionWorktreePaths = await canonicalPathSet(activeSessions.map((session) => session.worktree_path).filter((entry): entry is string => typeof entry === "string"));
  const terminalSessionWorktrees = await Promise.all(terminalSessions.map(async (session) => ({
    session,
    canonicalWorktreePath: typeof session.worktree_path === "string" ? path.resolve(await realPathOrResolved(session.worktree_path)) : null,
  })));
  const sessionBranches = new Set(activeSessions.map((session) => session.branch).filter((entry): entry is string => typeof entry === "string"));
  const orphanedSessions = [];
  const poisonedSessions = [];

  for (const session of activeSessions) {
    const sessionWorktreePath = typeof session.worktree_path === "string" ? session.worktree_path : "";
    const canonicalSessionWorktreePath = sessionWorktreePath ? path.resolve(await realPathOrResolved(sessionWorktreePath)) : "";
    if (!sessionWorktreePath || !worktreePaths.has(canonicalSessionWorktreePath) || !(await pathExists(sessionWorktreePath))) {
      orphanedSessions.push(session);
    }
    const poisonedSession = await annotatePoisonedSession(session, repoRoot, config);
    if (poisonedSession) poisonedSessions.push(poisonedSession);
  }

  const branches = await listBranches(repoRoot);
  const remotes = await listRemoteNamesReadOnly(repoRoot);
  const branchesWithoutWorktrees = branches.filter((branch) => !worktrees.some((worktree) => worktree.branch === branch.name));
  const terminalRecovery = terminalRecoveryPlans({
    repoRoot,
    config,
    terminalSessions: terminalSessionWorktrees,
    worktrees: worktreeEntries,
    activeWorktreePaths: sessionWorktreePaths,
    activeBranches: sessionBranches,
    branchesWithoutWorktrees,
  });
  const worktreesWithoutState = await Promise.all(worktreeEntries
    .filter((worktree) => worktree.canonicalPath !== canonicalRepoRoot)
    .filter((worktree) => !sessionWorktreePaths.has(worktree.canonicalPath))
    .map((worktree) => annotateWorktreeWithoutState(worktree.entry, repoRoot, config)));
  const stateBranchesWithoutWorktrees = [...sessionBranches].filter((branch) => !worktrees.some((worktree) => worktree.branch === branch));
  const baseDistance = await collectActiveSessionBaseDistances(repoRoot, config, activeSessions, worktrees);
  const effectiveRemote = baseDistance.baseAuthority.status === "available" ? baseDistance.baseAuthority.effectiveRemote : String(config.remote);
  const effectiveRemoteBranchCount = await cachedRemoteBranchCountReadOnly(repoRoot, effectiveRemote);

  return {
    repoRoot,
    config,
    configPath: statusConfig.path,
    configLoaded: statusConfig.loaded,
    configSource: statusConfig.source,
    stateVersion: state.state_version,
    sessions,
    activeSessions,
    ...baseDistance,
    terminalSessions,
    terminalRecoveryActions: terminalRecovery.actions,
    terminalRecoveryActionCount: terminalRecovery.count,
    terminalRecoveryActionOmittedCount: terminalRecovery.omittedCount,
    orphanedSessions,
    poisonedSessions,
    worktrees,
    operationalScope: operationalScope({ effectiveRemote, remotes, localBranchCount: branches.length, effectiveRemoteBranchCount, freshness: "cached-read-only" }),
    branchesWithoutWorktrees,
    worktreesWithoutState,
    stateBranchesWithoutWorktrees,
    safetyRefs: await listRefs(repoRoot, "refs/opencode-guardian"),
    preservedRefs: await listRefs(repoRoot, "refs/opencode-guardian/preserved"),
    stashes: await listStashes(repoRoot),
    dirtyFiles: await getDirtyFiles(repoRoot),
    hygiene: await scanWorkspaceHygiene({ repoRoot, cwd: input.cwd, config }),
    suggestedCommands: ["guardian_status", "guardian_recover"],
  };
}

export async function guardianRecover(input: GuardianToolInput = {}): Promise<GuardianRecoverResult> {
  const status = await guardianStatus(input);
  const candidates = await listRecoveryCandidates(status.repoRoot);
  return {
    ...status,
    recoveryCandidates: candidates,
    suggestedCommands: [
      ...status.suggestedCommands,
      ...status.safetyRefs.map((ref) => `git branch recovery/<name> ${ref.commit}`),
      ...status.stashes.map((stash) => `git stash show -p ${stash.name}`),
    ],
  };
}
