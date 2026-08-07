import fs from "node:fs/promises";
import path from "node:path";
import { samePathOnDisk } from "./done-shared.ts";
import { getCommonGitDir, getHeadCommit } from "./git.ts";
import { clearTerminalLifecycleFields } from "./lifecycle.ts";
import { getGuardianPaths } from "./guardian-paths.ts";
import { appendDurable, writeDurableAtomic } from "./state-durable-file.ts";
import { DEFAULT_STATE_LOCK_TIMEOUT_MS, withStateLock } from "./state-lock.ts";
import { ineligibleSessionProvenance, isProvenanceEnabled } from "./session-provenance.ts";
import type { StateLockOptions } from "./state-lock.ts";
import type { GuardianConfig, GuardianPaths, GuardianSession, GuardianState, GuardianStateRecord, RecordLike } from "./types.ts";
import { errorCode, isRecordLike } from "./types.ts";

export const STATE_SCHEMA_VERSION = "1.0.0";

export type StateErrorKind = "invalid_shape" | "unsupported_schema" | "symlink" | "lock_blocked" | "lock_ownership_lost" | "lock_reentrant" | "lock_timeout" | "illegal_active_binding";
export type StateBoundaryError = Error & { readonly stateErrorKind: StateErrorKind; readonly guardianPath?: string };
type GuardianConfigInput = GuardianConfig | RecordLike;

function stateError(kind: StateErrorKind, message: string, guardianPath?: string): StateBoundaryError {
  return Object.assign(new Error(message), {
    stateErrorKind: kind,
    ...(guardianPath === undefined ? {} : { guardianPath }),
  });
}

// Path computation lives in guardian-paths.ts to avoid a cycle through provenance.ts
// (state.ts -> session-provenance.ts -> provenance.ts -> state.ts). Re-exported here
// so existing `import { getGuardianPaths } from "./state.ts"` call sites are unaffected.
export { getGuardianPaths };

export function createEmptyState({ repoRoot, config }: { readonly repoRoot: string; readonly config: GuardianConfigInput }): GuardianState {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    state_version: 0,
    repo_root: repoRoot,
    base_branch: typeof config.baseBranch === "string" ? config.baseBranch : "",
    remote: typeof config.remote === "string" ? config.remote : "",
    finish_mode: typeof config.finishMode === "string" ? config.finishMode : "",
    worktree_root: typeof config.worktreeRoot === "string" ? config.worktreeRoot : "",
    sessions: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function assertNotSymlink(filePath: string, label: string) {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) throw stateError("symlink", `Refusing guardian ${label} symlink: ${filePath}`, filePath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function validateStateShape(state: unknown): GuardianStateRecord {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw stateError("invalid_shape", "Invalid guardian state: expected object");
  if (!isRecordLike(state)) throw stateError("invalid_shape", "Invalid guardian state: expected object");
  if (state.schema_version !== STATE_SCHEMA_VERSION) {
    throw stateError("unsupported_schema", `Unsupported guardian state schema_version: ${String(state.schema_version)}`);
  }
  if (typeof state.state_version !== "number") throw stateError("invalid_shape", "Invalid guardian state: state_version must be a number");
  if (!state.sessions || typeof state.sessions !== "object" || Array.isArray(state.sessions)) {
    throw stateError("invalid_shape", "Invalid guardian state: sessions must be an object");
  }
  const sessions: Record<string, GuardianSession> = {};
  for (const [sessionId, session] of Object.entries(state.sessions)) {
    if (isRecordLike(session)) sessions[sessionId] = session;
  }
  return {
    ...state,
    sessions,
  };
}

export async function readState(paths: GuardianPaths, context: { readonly repoRoot: string; readonly config: GuardianConfigInput }): Promise<GuardianStateRecord> {
  try {
    await assertNotSymlink(paths.statePath, "state");
    const raw = await fs.readFile(paths.statePath, "utf8");
    return validateStateShape(JSON.parse(raw));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return createEmptyState(context);
  }
}

export async function writeStateAtomic(paths: GuardianPaths, state: GuardianState | GuardianStateRecord) {
  await assertNotSymlink(paths.statePath, "state");
  await writeDurableAtomic(paths.statePath, paths.lockTmpDir, `${JSON.stringify(state, null, 2)}\n`);
}

export async function writeReportAtomic(paths: GuardianPaths, html: string) {
  await assertNotSymlink(paths.reportPath, "report");
  await writeDurableAtomic(paths.reportPath, paths.lockTmpDir, html);
}

export async function appendEvent(paths: GuardianPaths, event: RecordLike) {
  await assertNotSymlink(paths.eventsPath, "events");
  await appendDurable(paths.eventsPath, `${JSON.stringify({ ...event, at: event.at ?? new Date().toISOString() })}\n`);
}

export async function withStateTransaction<T>(paths: GuardianPaths, operation: () => Promise<T>, options: StateLockOptions = {}): Promise<T> {
  return withStateLock(paths, options, operation);
}

type UpdateStateLockedInput = {
  readonly repoRoot: string;
  readonly config: GuardianConfigInput;
  readonly paths: GuardianPaths;
  readonly updater: (state: GuardianStateRecord) => GuardianStateRecord | Promise<GuardianStateRecord>;
  readonly event?: RecordLike;
};

async function updateStateLocked(input: UpdateStateLockedInput): Promise<GuardianStateRecord> {
  const { repoRoot, config, paths, updater } = input;
  const previous = await readState(paths, { repoRoot, config });
  const next = await updater(structuredClone(previous));
  next.state_version = (previous.state_version ?? 0) + 1;
  next.updated_at = new Date().toISOString();
  const event = input.event ? { ...input.event, state_version: next.state_version } : null;
  if (event) await assertNotSymlink(paths.eventsPath, "events");
  await writeStateAtomic(paths, next);
  try {
    if (event) await appendEvent(paths, event);
  } catch (error) {
    await writeStateAtomic(paths, previous);
    throw error;
  }
  return next;
}

export async function updateState(repoRoot: string, config: GuardianConfigInput, updater: (state: GuardianStateRecord) => GuardianStateRecord | Promise<GuardianStateRecord>, options: { readonly paths?: GuardianPaths; readonly event?: RecordLike } = {}) {
  const paths = options.paths ?? await getGuardianPaths(repoRoot);
  return withStateTransaction(paths, () => updateStateLocked({ repoRoot, config, paths, updater, ...(options.event === undefined ? {} : { event: options.event }) }), {
    timeoutMs: typeof config.lockTimeoutMs === "number" ? config.lockTimeoutMs : DEFAULT_STATE_LOCK_TIMEOUT_MS,
  });
}

type SessionBindingFields = { readonly status?: unknown; readonly worktree_path?: unknown; readonly branch?: unknown; readonly session_id?: unknown };

async function isActivePrimaryBinding(repoRoot: string, session: SessionBindingFields | undefined): Promise<boolean> {
  return session?.status === "active" && typeof session.worktree_path === "string" && await samePathOnDisk(session.worktree_path, repoRoot);
}

function isActiveProtectedBinding(protectedBranches: readonly string[], session: SessionBindingFields | undefined): boolean {
  return session?.status === "active" && typeof session.branch === "string" && protectedBranches.includes(session.branch);
}

// Guardian's validate/status layers treat an active session bound to the primary worktree
// or a protected branch as poisoned. Refuse to *newly* establish such a binding so no
// write path (e.g. a tool-after checkpoint or a fresh start) can create poison. Re-recording
// an already-poisoned active session is tolerated so finish/done/recovery can still process
// and clean up legacy poison.
async function assertActiveSessionBoundary(
  repoRoot: string,
  config: GuardianConfigInput,
  previous: SessionBindingFields | undefined,
  next: SessionBindingFields,
): Promise<void> {
  if (next.status !== "active") return;
  const protectedBranches = Array.isArray(config.protectedBranches) ? config.protectedBranches : [];
  if (await isActivePrimaryBinding(repoRoot, next) && !await isActivePrimaryBinding(repoRoot, previous)) {
    throw stateError("illegal_active_binding", `Refusing to newly bind active session ${String(next.session_id)} to the primary repository worktree: ${repoRoot}`);
  }
  if (isActiveProtectedBinding(protectedBranches, next) && !isActiveProtectedBinding(protectedBranches, previous)) {
    throw stateError("illegal_active_binding", `Refusing to newly bind active session ${String(next.session_id)} to a protected branch: ${String(next.branch)}`);
  }
}

async function assertSameRepoBinding(repoRoot: string, previous: SessionBindingFields | undefined, next: SessionBindingFields): Promise<void> {
  if (next.status !== "active" || typeof next.worktree_path !== "string") return;
  // Tolerate re-recording an already cross-repo-bound active session so finish/done/recovery can clean up legacy contamination.
  if (previous?.status === "active" && typeof previous.worktree_path === "string" && await samePathOnDisk(previous.worktree_path, next.worktree_path)) return;
  let repoCommonDir: string;
  let worktreeCommonDir: string;
  try {
    repoCommonDir = path.resolve(await getCommonGitDir(repoRoot));
    worktreeCommonDir = path.resolve(await getCommonGitDir(next.worktree_path));
  } catch {
    return;
  }
  if (repoCommonDir !== worktreeCommonDir) {
    throw stateError("illegal_active_binding", `Refusing to bind active session ${String(next.session_id)} whose worktree ${String(next.worktree_path)} belongs to a different git repository than ${repoRoot}`);
  }
}

export async function recordSession(repoRoot: string, config: GuardianConfigInput, session: GuardianSession, options: { readonly paths?: GuardianPaths; readonly event?: RecordLike } = {}) {
  return updateState(repoRoot, config, async (state) => {
    if (!state.sessions) state.sessions = {};
    const sessionId = session.session_id;
    if (!sessionId) throw new Error("session.session_id is required");
    const previous = isRecordLike(state.sessions[sessionId]) ? state.sessions[sessionId] : undefined;
    const now = new Date().toISOString();
    let supersededBinding = false;
    if (session.status === "active" && typeof session.worktree_path === "string") {
      for (const [candidateSessionId, candidate] of Object.entries(state.sessions)) {
        if (candidateSessionId !== sessionId && isRecordLike(candidate) && candidate.status === "active" && typeof candidate.worktree_path === "string" && await samePathOnDisk(candidate.worktree_path, session.worktree_path)) {
          supersededBinding = true;
          const superseded = {
            ...candidate,
            status: "superseded",
            superseded_by: sessionId,
            superseded_at: now,
            updated_at: now,
            ...ineligibleSessionProvenance(config),
          };
          delete superseded.provenance;
          delete superseded.lineage_id;
          if (!isProvenanceEnabled(config)) {
            delete superseded.provenance_status;
            delete superseded.quarantine_eligible;
          }
          state.sessions[candidateSessionId] = superseded;
        }
      }
    }
    const merged = clearTerminalLifecycleFields({
      ...previous,
      ...session,
      state_version: (typeof previous?.state_version === "number" ? previous.state_version : 0) + 1,
      safety_refs: session.safety_refs ?? previous?.safety_refs ?? [],
      created_at: previous?.created_at ?? now,
      updated_at: now,
    });
    const bindingChanged = previous?.status === "active"
      && merged.status === "active"
      && typeof previous.worktree_path === "string"
      && typeof merged.worktree_path === "string"
      && (!await samePathOnDisk(previous.worktree_path, merged.worktree_path) || previous.branch !== merged.branch);
    if (supersededBinding || bindingChanged) {
      delete merged.provenance;
      delete merged.lineage_id;
      if (isProvenanceEnabled(config)) {
        merged.provenance_status = "ineligible";
        merged.quarantine_eligible = false;
      } else {
        delete merged.provenance_status;
        delete merged.quarantine_eligible;
      }
    } else if (!previous && merged.status !== "active" && isProvenanceEnabled(config)) {
      merged.provenance_status = "ineligible";
      merged.quarantine_eligible = false;
    }
    if (isProvenanceEnabled(config) && merged.quarantine_eligible === false) {
      delete merged.provenance;
      delete merged.lineage_id;
    }
    await assertActiveSessionBoundary(repoRoot, config, previous, merged);
    await assertSameRepoBinding(repoRoot, previous, merged);
    state.sessions[sessionId] = merged;
    return state;
  }, { ...options, event: options.event ?? { type: "session_recorded", session_id: session.session_id } });
}


export async function checkpointSession(
  repoRoot: string,
  config: GuardianConfigInput,
  sessionId: string,
  options: { readonly expectedWorktreePath: string; readonly event?: RecordLike },
) {
  return updateState(repoRoot, config, async (state) => {
    if (!state.sessions) state.sessions = {};
    const current = isRecordLike(state.sessions[sessionId]) ? state.sessions[sessionId] : undefined;
    if (!current || current.status !== "active" || typeof current.worktree_path !== "string") return state;
    if (!await samePathOnDisk(current.worktree_path, options.expectedWorktreePath)) return state;
    const headCommit = await getHeadCommit(current.worktree_path);
    state.sessions[sessionId] = { ...current, head_commit: headCommit, updated_at: new Date().toISOString() };
    return state;
  }, { event: options.event });
}
