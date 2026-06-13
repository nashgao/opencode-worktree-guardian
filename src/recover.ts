import fs from "node:fs/promises";
import path from "node:path";
import { expandWorktreeRoot, loadConfig, normalizeConfig } from "./config.ts";
import { getCommonGitDir, getDirtyFiles, getRepoRoot, listBranches, listRecoveryCandidates, listRefs, listStashes, listWorktrees } from "./git.ts";
import type { GitBranchEntry, GitRefEntry, GitStashEntry } from "./git.ts";
import { scanWorkspaceHygiene } from "./hygiene.ts";
import { isActiveSession, isTerminalSession } from "./lifecycle.ts";
import { getGuardianPaths, readState } from "./state.ts";
import type { GuardianConfig, GuardianSession, GuardianToolInput, GuardianToolResult, WorktreeEntry } from "./types.ts";
import { errorMessage, isRecordLike } from "./types.ts";

type WorktreeAnnotationMetadata = {
  readonly guardianRoot: string;
  readonly commonGitDir?: string;
  readonly commonGitDirError?: string;
};

type AnnotatedWorktreeEntry = WorktreeEntry & {
  readonly category?: "external-temp-worktree" | "external-worktree";
  readonly severity?: "fail";
  readonly reason?: string;
  readonly metadata?: WorktreeAnnotationMetadata;
};

type PoisonedSession = GuardianSession & {
  readonly severity: "fail";
  readonly reason: string;
  readonly suggestedCommand: string;
};

type HygieneSummary = Record<string, unknown> & {
  readonly findingCount: number;
  readonly reviewableCandidateCount: number;
  readonly reviewableShownCount: number;
  readonly reviewableOmittedCount: number;
  readonly reviewableTruncated: boolean;
};

type HygieneReviewableCandidate = {
  readonly path: string;
  readonly status: "ignored" | "untracked";
  readonly reason: string;
  readonly source: string;
  readonly suggestedDeletePathCommand: string;
};

type HygieneStatus = Record<string, unknown> & {
  readonly ok?: unknown;
  readonly summary: HygieneSummary;
  readonly findings: readonly (Record<string, unknown> & { readonly path?: unknown })[];
  readonly reviewableCandidates: readonly HygieneReviewableCandidate[];
};

type GuardianStatusResult = Omit<GuardianToolResult, "activeSessions" | "terminalSessions" | "worktrees" | "safetyRefs" | "sessions"> & {
  readonly repoRoot: string;
  readonly config: GuardianConfig;
  readonly stateVersion: number | undefined;
  readonly sessions: readonly GuardianSession[];
  readonly activeSessions: readonly GuardianSession[];
  readonly terminalSessions: readonly GuardianSession[];
  readonly orphanedSessions: readonly GuardianSession[];
  readonly poisonedSessions: readonly PoisonedSession[];
  readonly worktrees: readonly WorktreeEntry[];
  readonly branchesWithoutWorktrees: readonly GitBranchEntry[];
  readonly worktreesWithoutState: readonly AnnotatedWorktreeEntry[];
  readonly stateBranchesWithoutWorktrees: readonly string[];
  readonly safetyRefs: readonly GitRefEntry[];
  readonly preservedRefs: readonly GitRefEntry[];
  readonly stashes: readonly GitStashEntry[];
  readonly dirtyFiles: readonly string[];
  readonly hygiene: HygieneStatus;
  readonly suggestedCommands: readonly string[];
};

type GuardianRecoverResult = GuardianStatusResult & {
  readonly recoveryCandidates: Awaited<ReturnType<typeof listRecoveryCandidates>>;
};

async function pathExists(candidate: string) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
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

function poisonedSessionReason(session: GuardianSession, repoRoot: string, config: GuardianConfig) {
  const reasons: string[] = [];
  if (typeof session.worktree_path === "string" && path.resolve(session.worktree_path) === path.resolve(repoRoot)) {
    reasons.push("active session is recorded on the primary repository worktree");
  }
  if (typeof session.branch === "string" && Array.isArray(config.protectedBranches) && config.protectedBranches.includes(session.branch)) {
    reasons.push("active session branch is protected");
  }
  return reasons.join("; ");
}

function annotatePoisonedSession(session: GuardianSession, repoRoot: string, config: GuardianConfig): PoisonedSession | null {
  const reason = poisonedSessionReason(session, repoRoot, config);
  if (!reason) return null;
  return {
    ...session,
    severity: "fail",
    reason,
    suggestedCommand: "guardian_start createWorktree=true",
  };
}

async function configFromInput(input: GuardianToolInput, repoRoot: string): Promise<GuardianConfig> {
  if (input.config === undefined || input.config === null) return (await loadConfig(repoRoot)).config;
  if (!isRecordLike(input.config)) throw new Error("config must be an object");
  return normalizeConfig(input.config);
}

export async function guardianStatus(input: GuardianToolInput = {}): Promise<GuardianStatusResult> {
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const config = await configFromInput(input, repoRoot);
  const paths = await getGuardianPaths(repoRoot);
  const state = await readState(paths, { repoRoot, config });
  const worktrees = await listWorktrees(repoRoot);
  const worktreePaths = new Set(worktrees.map((entry) => path.resolve(entry.path)));
  const sessions = Object.values(state.sessions ?? {});
  const activeSessions = sessions.filter(isActiveSession);
  const terminalSessions = sessions.filter(isTerminalSession);
  const sessionWorktreePaths = new Set(activeSessions.map((session) => session.worktree_path).filter((entry): entry is string => typeof entry === "string").map((entry) => path.resolve(entry)));
  const sessionBranches = new Set(activeSessions.map((session) => session.branch).filter((entry): entry is string => typeof entry === "string"));
  const orphanedSessions = [];
  const poisonedSessions = [];

  for (const session of activeSessions) {
    if (!session.worktree_path || !worktreePaths.has(path.resolve(session.worktree_path)) || !(await pathExists(session.worktree_path))) {
      orphanedSessions.push(session);
    }
    const poisonedSession = annotatePoisonedSession(session, repoRoot, config);
    if (poisonedSession) poisonedSessions.push(poisonedSession);
  }

  const branches = await listBranches(repoRoot);
  const branchesWithoutWorktrees = branches.filter((branch) => !worktrees.some((worktree) => worktree.branch === branch.name));
  const worktreesWithoutState = await Promise.all(worktrees
    .filter((worktree) => !sessionWorktreePaths.has(path.resolve(worktree.path)))
    .map((worktree) => annotateWorktreeWithoutState(worktree, repoRoot, config)));
  const stateBranchesWithoutWorktrees = [...sessionBranches].filter((branch) => !worktrees.some((worktree) => worktree.branch === branch));

  return {
    repoRoot,
    config,
    stateVersion: state.state_version,
    sessions,
    activeSessions,
    terminalSessions,
    orphanedSessions,
    poisonedSessions,
    worktrees,
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
