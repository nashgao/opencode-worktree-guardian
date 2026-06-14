import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, normalizeConfig } from "./config.ts";
import { getCommonGitDir, getRepoRoot, listWorktrees } from "./git.ts";
import { isTerminalSession } from "./lifecycle.ts";
import { getGuardianPaths, readState, updateState } from "./state.ts";
import type { GuardianConfig, GuardianSession, GuardianToolInput, GuardianToolResult, RecordLike, WorktreeEntry } from "./types.ts";
import { isRecordLike } from "./types.ts";

export type GcReason = "terminal-stale" | "poisoned-primary" | "poisoned-protected" | "orphaned" | "foreign-repo";

export type GcCandidate = {
  readonly session_id: string;
  readonly status: string;
  readonly reason: GcReason;
  readonly branch: string | null;
  readonly worktree_path: string | null;
  readonly updated_at: string | null;
  readonly age_days: number | null;
};

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function safeCommonGitDir(candidate: string): Promise<string | null> {
  try {
    return await getCommonGitDir(candidate);
  } catch {
    return null;
  }
}

function ageInDays(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return (Date.now() - parsed) / 86_400_000;
}

async function resolveGcConfig(input: GuardianToolInput, repoRoot: string): Promise<GuardianConfig> {
  if (input.config == null) return (await loadConfig(repoRoot)).config;
  if (isRecordLike(input.config)) return normalizeConfig(input.config);
  return (await loadConfig(repoRoot)).config;
}

// A Guardian session record is GC-eligible when it can never be used as-is:
//  - terminal-stale: terminal status older than the safety-ref retention window (git refs persist)
//  - poisoned-primary/protected: active binding that validate/status already condemn as poisoned
//  - orphaned: active binding whose worktree is gone from disk and from git worktree list
// Healthy active sessions (valid, on-disk, non-primary worktree) are never eligible.
async function collectGcCandidates(
  repoRoot: string,
  config: GuardianConfig,
  sessions: Record<string, GuardianSession>,
  worktrees: readonly WorktreeEntry[],
): Promise<GcCandidate[]> {
  const protectedBranches = Array.isArray(config.protectedBranches) ? config.protectedBranches.filter((branch): branch is string => typeof branch === "string") : [];
  const retentionDays = typeof config.safetyRefRetentionDays === "number" ? config.safetyRefRetentionDays : 30;
  const worktreePaths = new Set(worktrees.map((entry) => path.resolve(entry.path)));
  const repoCommonDir = path.resolve(await getCommonGitDir(repoRoot));
  const candidates: GcCandidate[] = [];
  for (const [sessionId, raw] of Object.entries(sessions)) {
    if (!isRecordLike(raw)) continue;
    const status = typeof raw.status === "string" ? raw.status : "";
    const branch = typeof raw.branch === "string" ? raw.branch : null;
    const worktreePath = typeof raw.worktree_path === "string" ? raw.worktree_path : null;
    const updatedAt = typeof raw.updated_at === "string" ? raw.updated_at : null;
    const ageDays = ageInDays(updatedAt);
    const base = { session_id: sessionId, status, branch, worktree_path: worktreePath, updated_at: updatedAt, age_days: ageDays };
    if (isTerminalSession(raw)) {
      if (ageDays !== null && ageDays >= retentionDays) candidates.push({ ...base, reason: "terminal-stale" });
      continue;
    }
    if (status !== "active") continue;
    if (worktreePath && path.resolve(worktreePath) === path.resolve(repoRoot)) {
      candidates.push({ ...base, reason: "poisoned-primary" });
      continue;
    }
    if (branch && protectedBranches.includes(branch)) {
      candidates.push({ ...base, reason: "poisoned-protected" });
      continue;
    }
    if (worktreePath) {
      const resolved = path.resolve(worktreePath);
      const listed = worktreePaths.has(resolved);
      const exists = listed || (await pathExists(resolved));
      if (!exists) {
        candidates.push({ ...base, reason: "orphaned" });
      } else if (!listed) {
        const worktreeCommonDir = await safeCommonGitDir(resolved);
        if (worktreeCommonDir !== null && path.resolve(worktreeCommonDir) !== repoCommonDir) candidates.push({ ...base, reason: "foreign-repo" });
      }
    }
  }
  return candidates.sort((left, right) => left.session_id.localeCompare(right.session_id));
}

function gcConfirmToken(repoRoot: string, candidates: readonly GcCandidate[]): string {
  const material = {
    repoRoot: path.resolve(repoRoot),
    candidates: candidates.map((candidate) => ({ session_id: candidate.session_id, status: candidate.status, reason: candidate.reason })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

function summarizeReasons(candidates: readonly GcCandidate[]): Record<GcReason, number> {
  const byReason: Record<GcReason, number> = { "terminal-stale": 0, "poisoned-primary": 0, "poisoned-protected": 0, orphaned: 0, "foreign-repo": 0 };
  for (const candidate of candidates) byReason[candidate.reason] += 1;
  return byReason;
}

export async function guardianGc(input: GuardianToolInput = {}): Promise<GuardianToolResult> {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const config = await resolveGcConfig(input, repoRoot);
  const mode = input.mode;
  const retentionDays = typeof config.safetyRefRetentionDays === "number" ? config.safetyRefRetentionDays : 30;
  if (mode !== "plan" && mode !== "apply") {
    return { ok: false, status: "blocked", reason: "mode must be plan or apply", repoRoot, mode: typeof mode === "string" ? mode : null };
  }
  const guardianPaths = await getGuardianPaths(repoRoot);
  const state = await readState(guardianPaths, { repoRoot, config });
  const worktrees = await listWorktrees(repoRoot);
  const candidates = await collectGcCandidates(repoRoot, config, state.sessions ?? {}, worktrees);
  const confirmToken = gcConfirmToken(repoRoot, candidates);
  const report: RecordLike = {
    repoRoot,
    mode,
    retentionDays,
    candidateCount: candidates.length,
    summary: summarizeReasons(candidates),
    candidates,
  };

  if (mode === "plan") {
    return { ok: true, status: "planned", confirmToken, prunedCount: 0, ...report };
  }

  if (input.confirmDelete !== true) {
    return { ok: false, status: "blocked", reason: "apply requires confirmDelete=true; re-run mode=plan, inspect candidates, then apply with confirmDelete=true and the returned confirmToken", confirmToken, ...report };
  }
  if (input.confirmToken !== confirmToken) {
    return { ok: false, status: "blocked", reason: "confirm token mismatch; the candidate set changed, re-run mode=plan and use the returned confirmToken", ...report };
  }
  if (candidates.length === 0) {
    return { ok: true, status: "pruned", prunedCount: 0, prunedSessionIds: [], confirmToken, ...report };
  }

  const prunedSessionIds = candidates.map((candidate) => candidate.session_id);
  const ids = new Set(prunedSessionIds);
  // Record-only: prune the dead state records. Git refs, branches, and worktrees are untouched,
  // so nothing reachable becomes unreachable; recovery refs/reflog remain available.
  const nextState = await updateState(repoRoot, config, (current) => {
    if (!current.sessions) current.sessions = {};
    for (const id of ids) {
      if (id in current.sessions) delete current.sessions[id];
    }
    return current;
  }, { event: { type: "guardian_gc", pruned: prunedSessionIds, count: ids.size } });

  return { ok: true, status: "pruned", prunedCount: ids.size, prunedSessionIds, stateVersion: nextState.state_version, confirmToken, ...report };
}
