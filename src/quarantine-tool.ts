import crypto from "node:crypto";
import path from "node:path";
import { loadConfig, normalizeConfig } from "./config.ts";
import { canonicalPathOrResolved } from "./filesystem-boundaries.ts";
import { getCommonGitDir, getRepoRoot, listWorktrees, tryGit } from "./git.ts";
import { executePurge, executeRestore } from "./quarantine-execute.ts";
import { readQuarantineItem } from "./quarantine-journal.ts";
import { getGuardianPaths, readState } from "./state.ts";
import type { GuardianQuarantineAction } from "./quarantine-types.ts";
import type { GuardianConfig, GuardianSession, GuardianToolInput, GuardianToolResult } from "./types.ts";
import { isRecordLike } from "./types.ts";

function actionFromInput(value: unknown): GuardianQuarantineAction | null {
  return value === "restore" || value === "purge" ? value : null;
}

async function configFor(input: GuardianToolInput, repoRoot: string): Promise<GuardianConfig> {
  return isRecordLike(input.config) ? normalizeConfig(input.config) : (await loadConfig(repoRoot)).config;
}

function token(input: {
  readonly action: GuardianQuarantineAction;
  readonly commonGitDir: string;
  readonly confirmationMode: "confirm" | "confirmDelete";
  readonly destinationPath: string | null;
  readonly fingerprintDigest: string;
  readonly itemDigest: string;
  readonly itemState: "available";
  readonly quarantineId: string;
  readonly repoRoot: string;
  readonly targetWorktreePath: string | null;
}): string {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function itemSession(state: Awaited<ReturnType<typeof readState>>, sessionId: string): GuardianSession | null {
  const session = state.sessions[sessionId];
  return session && typeof session.session_id === "string" ? session : null;
}

async function repositoryIdentity(candidateRoot: string): Promise<{ readonly commonGitDir: string; readonly repoRoot: string; readonly worktreePaths: readonly string[] }> {
  const commonGitDir = await canonicalPathOrResolved(await getCommonGitDir(candidateRoot));
  const worktrees = await listWorktrees(candidateRoot);
  const worktreePaths: string[] = [];
  const primaryPaths: string[] = [];
  for (const entry of worktrees) {
    const worktreePath = await canonicalPathOrResolved(entry.path);
    worktreePaths.push(worktreePath);
    const gitDir = await tryGit(entry.path, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    if (gitDir.ok && await canonicalPathOrResolved(gitDir.stdout) === commonGitDir) primaryPaths.push(worktreePath);
  }
  if (primaryPaths.length !== 1 || !primaryPaths[0]) throw new Error("could not identify the primary Git worktree");
  return { commonGitDir, repoRoot: primaryPaths[0], worktreePaths };
}

export async function quarantinePlanCacheKey(input: GuardianToolInput, plannedConfirmToken?: string): Promise<string | null> {
  let boundPlan = plannedConfirmToken;
  if (typeof boundPlan !== "string") {
    const planned = await guardianQuarantine({ ...input, mode: "plan" });
    if (planned.ok !== true || planned.status !== "planned" || typeof planned.confirmToken !== "string") return null;
    boundPlan = planned.confirmToken;
  }
  return JSON.stringify({ name: "guardian_quarantine", boundPlan });
}

export async function guardianQuarantine(input: GuardianToolInput = {}): Promise<GuardianToolResult> {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const candidateRoot = await canonicalPathOrResolved(typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd));
  const { commonGitDir, repoRoot, worktreePaths } = await repositoryIdentity(candidateRoot);
  const config = await configFor(input, repoRoot);
  const action = actionFromInput(input.action);
  const quarantineId = typeof input.quarantineId === "string" ? input.quarantineId : "";
  if (!action || !quarantineId || (input.mode !== "plan" && input.mode !== "apply")) return { ok: false, status: "blocked", reason: "action, quarantineId, and mode=plan|apply are required", repoRoot };
  const paths = await getGuardianPaths(repoRoot);
  const item = await readQuarantineItem({ paths, quarantineId });
  if (!item || item.record.state !== "available") return { ok: false, status: "blocked", action, quarantineId, reason: "quarantine item is missing or no longer available", repoRoot };
  const state = await readState(paths, { repoRoot, config });
  const session = itemSession(state, item.record.sessionId);
  if (!session) return { ok: false, status: "blocked", action, quarantineId, reason: "quarantine item session is unavailable", repoRoot };
  const eligible = [...new Set(worktreePaths)].filter((candidate) => candidate !== repoRoot);
  const requestedTarget = typeof input.targetWorktreePath === "string" ? await canonicalPathOrResolved(input.targetWorktreePath) : null;
  if (action === "restore" && requestedTarget && !eligible.includes(requestedTarget)) return { ok: false, status: "blocked", action, quarantineId, reason: "restore target is not a registered non-primary worktree", eligibleTargetWorktreePaths: eligible, repoRoot };
  const originalTarget = await canonicalPathOrResolved(item.record.originalWorktreePath);
  const selectedTarget = action === "restore" ? requestedTarget ?? (eligible.includes(originalTarget) ? originalTarget : null) : null;
  if (action === "restore" && !selectedTarget) return { ok: true, status: "needs-selection", action, quarantineId, eligibleTargetWorktreePaths: eligible, repoRoot };
  const confirmationMode = action === "restore" ? "confirm" : "confirmDelete";
  const destinationPath = selectedTarget ? path.resolve(selectedTarget, item.record.originalRelativePath) : null;
  const confirmToken = token({
    action,
    commonGitDir,
    confirmationMode,
    destinationPath,
    fingerprintDigest: item.record.fingerprintDigest,
    itemDigest: item.digest,
    itemState: item.record.state,
    quarantineId,
    repoRoot,
    targetWorktreePath: selectedTarget,
  });
  if (input.mode === "plan") return { ok: true, status: "planned", action, quarantineId, ...(selectedTarget ? { selectedTargetWorktreePath: selectedTarget } : {}), confirmToken, repoRoot };
  const confirmed = action === "restore" ? input.confirm === true : input.confirmDelete === true;
  if (!confirmed) return { ok: false, status: "blocked", action, quarantineId, reason: action === "restore" ? "restore apply requires confirm=true" : "purge apply requires confirmDelete=true", ...(selectedTarget ? { selectedTargetWorktreePath: selectedTarget } : {}), repoRoot };
  if (input.confirmToken !== confirmToken) return { ok: false, status: "blocked", action, quarantineId, reason: "confirm token mismatch; re-run mode=plan", ...(selectedTarget ? { selectedTargetWorktreePath: selectedTarget } : {}), repoRoot };
  try {
    if (action === "restore" && selectedTarget) {
      await executeRestore({ paths, repoRoot, config, session, quarantineId, targetWorktreePath: selectedTarget });
      return { ok: true, status: "restored", action, quarantineId, selectedTargetWorktreePath: selectedTarget, repoRoot };
    }
    await executePurge({ paths, quarantineId });
    return { ok: true, status: "purged", action, quarantineId, repoRoot };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { ok: false, status: "blocked", action, quarantineId, reason: error.message, ...(selectedTarget ? { selectedTargetWorktreePath: selectedTarget } : {}), repoRoot };
  }
}
