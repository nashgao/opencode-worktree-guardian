import fs from "node:fs/promises";
import { loadConfig, normalizeConfig } from "./config.ts";
import { guardianFinish } from "./finish.ts";
import { getHeadCommit, getRepoRoot } from "./git.ts";
import { isActiveSession } from "./lifecycle.ts";
import { isRecordLike } from "./types.ts";
import type { GuardianConfig, GuardianSession } from "./types.ts";
import { reattachCurrentGuardianWorktree } from "./done-reattach.ts";
import { guardianDoneLandClean } from "./done-land-clean.ts";
import { primaryMainDone } from "./done-primary-publish.ts";
import { dirtySnapshot, statusEntries } from "./done-primary-snapshot.ts";
import { blocked, samePath } from "./done-shared.ts";
import { guardianFinishWorkflow } from "./workflow.ts";
import { rescueDirtyWorktree } from "./done-rescue.ts";
import { guardianDoneAll } from "./done-all.ts";
import { buildDoneWorkInventory } from "./done-work-inventory.ts";
import type { DoneDirtyTarget, DoneWorkInventory } from "./done-work-inventory.ts";
import { resolveDoneTarget, type DoneTargetDecision } from "./done-target-resolver.ts";

function useDirectFinishMode(input: Record<string, unknown>) {
  return typeof input.finishMode === "string" && input.finishMode !== "create-pr";
}

function directFinishApplyBlocker(input: Record<string, unknown>, mode: "plan" | "apply") {
  if (mode !== "apply" || input.confirm === true) return null;
  const finishMode = typeof input.finishMode === "string" ? input.finishMode : "configured finish mode";
  return blocked("guardian_done direct finish apply requires confirm=true", {
    lane: "session-finish",
    nextAction: `guardian_done mode=apply confirm=true finishMode=${finishMode}`,
  });
}

function preservedSessionForWorktree(
  state: DoneWorkInventory["state"],
  currentWorktree: string,
  requestedSessionId: string | null,
): { readonly sessionId: string; readonly session: GuardianSession } | null {
  if (requestedSessionId) {
    const session = state.sessions?.[requestedSessionId];
    if (isRecordLike(session) && session.status === "preserved") return { sessionId: requestedSessionId, session };
    return null;
  }
  for (const [sessionId, session] of Object.entries(state.sessions ?? {})) {
    if (isRecordLike(session) && session.status === "preserved" && typeof session.worktree_path === "string" && samePath(session.worktree_path, currentWorktree)) {
      return { sessionId, session };
    }
  }
  return null;
}

function isLocalUntrackedStatus(status: string): boolean {
  return status === "??" || status === "!!";
}

async function preservedDoneNoOp(
  currentWorktree: string,
  config: GuardianConfig,
  sessionId: string,
  session: GuardianSession,
): Promise<Record<string, unknown>> {
  const branch = typeof session.branch === "string" ? session.branch : null;
  const commit = typeof session.head_commit === "string" ? session.head_commit : null;
  const safetyRefs = Array.isArray(session.safety_refs) ? session.safety_refs.filter((ref): ref is string => typeof ref === "string") : [];
  const safetyRef = safetyRefs[safetyRefs.length - 1] ?? null;
  let localUntrackedFileCount = 0;
  let localDirtyFileCount = 0;
  try {
    const snapshot = await dirtySnapshot(currentWorktree, config);
    const localEntries = await statusEntries(currentWorktree, { includeIgnored: true });
    localDirtyFileCount = snapshot.paths.length;
    localUntrackedFileCount = localEntries.filter((entry) => isLocalUntrackedStatus(entry.status)).length;
  } catch {
    localUntrackedFileCount = 0;
  }
  return {
    ok: true,
    status: "no-op",
    lane: "already-preserved",
    message: "session already preserved",
    sessionId,
    sessionStatus: session.status,
    branch,
    commit,
    safetyRef,
    safetyRefs,
    localUntrackedFileCount,
    localDirtyFileCount,
    session,
  };
}

function withSelectedTarget(result: Record<string, unknown>, selectedTarget: DoneDirtyTarget | undefined): Record<string, unknown> {
  return selectedTarget ? { ...result, selectedTarget } : result;
}

async function realPathOrOriginal(value: string): Promise<string> {
  return fs.realpath(value).catch(() => value);
}

async function runSessionTarget(
  decision: Extract<DoneTargetDecision, { readonly kind: "session-finish" }>,
  input: Record<string, unknown>,
  mode: "plan" | "apply",
  inventory: DoneWorkInventory,
  config: GuardianConfig,
): Promise<Record<string, unknown>> {
  const sessionBranch = decision.branch ?? inventory.currentBranch;
  if (samePath(decision.worktreePath, inventory.repoRoot) || sessionBranch && inventory.protectedBranches.includes(sessionBranch)) {
    return blocked("active Guardian session is bound to the primary worktree or a protected branch; repair it before finishing", {
      lane: "poisoned-primary-protected-session",
      sessionId: decision.sessionId,
      currentWorktree: inventory.currentWorktree,
      sessionWorktree: decision.worktreePath,
      currentBranch: inventory.currentBranch,
      sessionBranch,
      baseBranch: inventory.baseBranch,
      suggestedCommands: ["guardian_start createWorktree=true", "guardian_status"],
    });
  }
  if (useDirectFinishMode(input)) {
    const applyBlocker = directFinishApplyBlocker(input, mode);
    if (applyBlocker) return applyBlocker;
    const finish = await guardianFinish({ ...input, mode, repoRoot: inventory.repoRoot, cwd: decision.worktreePath, sessionId: decision.sessionId, config });
    return withSelectedTarget({ ...finish, lane: "session-finish" }, decision.selectedTarget);
  }
  const result = await guardianDoneLandClean({
    input: { ...input, mode },
    repoRoot: inventory.repoRoot,
    cwd: decision.worktreePath,
    sessionId: decision.sessionId,
    session: decision.session,
    config,
  });
  return withSelectedTarget({ ...result, lane: "session-finish" }, decision.selectedTarget);
}

function primaryRescueRecommended(inventory: DoneWorkInventory): Record<string, unknown> {
  return {
    ok: false,
    status: "blocked",
    lane: "primary-rescue-recommended",
    reason: "dirty protected primary work is not on the configured base branch; rescue it to a Guardian worktree before finishing",
    currentBranch: inventory.currentBranch,
    baseBranch: inventory.baseBranch,
    suggestedCommands: ["guardian_start createWorktree=true", "guardian_status"],
  };
}

function requestedPoisonedSessionBlocker(inventory: DoneWorkInventory, requestedSessionId: string | null): Record<string, unknown> | null {
  if (!requestedSessionId) return null;
  const session = inventory.state.sessions?.[requestedSessionId];
  if (!isRecordLike(session) || !isActiveSession(session) || typeof session.worktree_path !== "string") return null;
  const sessionBranch = typeof session.branch === "string" ? session.branch : inventory.currentBranch;
  if (!samePath(session.worktree_path, inventory.repoRoot) && !(sessionBranch && inventory.protectedBranches.includes(sessionBranch))) return null;
  return blocked("active Guardian session is bound to the primary worktree or a protected branch; repair it before finishing", {
    lane: "poisoned-primary-protected-session",
    sessionId: requestedSessionId,
    currentWorktree: inventory.currentWorktree,
    sessionWorktree: session.worktree_path,
    currentBranch: inventory.currentBranch,
    sessionBranch,
    baseBranch: inventory.baseBranch,
    suggestedCommands: ["guardian_start createWorktree=true", "guardian_status"],
  });
}

export async function guardianDone(input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const rawCwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const cwd = await realPathOrOriginal(rawCwd);
  const rawRepoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const repoRoot = await realPathOrOriginal(rawRepoRoot);
  const config = isRecordLike(input.config) ? normalizeConfig(input.config) : (await loadConfig(repoRoot)).config;
  const requestedMode = input.mode ?? "plan";
  if (requestedMode !== "plan" && requestedMode !== "apply") return { ok: false, status: "blocked", reason: "mode must be plan or apply", mode: requestedMode };
  const mode = requestedMode;

  const inventory = await buildDoneWorkInventory({ repoRoot, cwd, config });
  if (input.rescue === true) {
    return rescueDirtyWorktree(inventory.currentWorktree, config, input);
  }
  const requestedSessionId = typeof input.sessionId === "string" && input.sessionId.trim().length > 0 ? input.sessionId : null;
  const poisonBlocker = requestedPoisonedSessionBlocker(inventory, requestedSessionId);
  if (poisonBlocker) return poisonBlocker;
  const preserved = preservedSessionForWorktree(inventory.state, inventory.currentWorktree, requestedSessionId);
  if (preserved) {
    const preservedHead = typeof preserved.session.head_commit === "string" ? preserved.session.head_commit : null;
    const currentHead = await getHeadCommit(inventory.currentWorktree).catch(() => null);
    if (preservedHead && currentHead === preservedHead) {
      return preservedDoneNoOp(inventory.currentWorktree, config, preserved.sessionId, preserved.session);
    }
  }

  const decision = resolveDoneTarget({ input: { ...input, mode }, inventory });
  switch (decision.kind) {
    case "session-finish":
      return runSessionTarget(decision, input, mode, inventory, config);
    case "primary-main-publish":
      return withSelectedTarget(await primaryMainDone(repoRoot, repoRoot, config, input), decision.selectedTarget);
    case "done-all":
      return guardianDoneAll({ ...input, repoRoot, cwd: repoRoot, config });
    case "cleanup-only": {
      const cleanup = await guardianFinishWorkflow({ ...input, repoRoot, cwd: repoRoot, config, abandonUnmerged: true });
      return { ...cleanup, lane: "cleanup-only" };
    }
    case "reattach":
      return reattachCurrentGuardianWorktree(repoRoot, inventory.currentWorktree, inventory.currentBranch, config, requestedSessionId, { ...input, mode });
    case "primary-rescue-recommended":
      return primaryRescueRecommended(inventory);
    case "needs-selection":
      return decision;
    case "blocked":
      return decision;
  }
}
