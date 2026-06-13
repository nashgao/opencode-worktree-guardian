import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { getCommonGitDir } from "./git.ts";
import { clearTerminalLifecycleFields } from "./lifecycle.ts";
import type { GuardianConfig, GuardianPaths, GuardianSession, GuardianState, GuardianStateRecord, RecordLike } from "./types.ts";
import { errorCode, isRecordLike } from "./types.ts";

export const STATE_SCHEMA_VERSION = "1.0.0";

export type StateErrorKind = "invalid_shape" | "unsupported_schema" | "symlink" | "lock_timeout";
export type StateBoundaryError = Error & { readonly stateErrorKind: StateErrorKind; readonly guardianPath?: string };
type GuardianConfigInput = GuardianConfig | RecordLike;

function stateError(kind: StateErrorKind, message: string, guardianPath?: string): StateBoundaryError {
  return Object.assign(new Error(message), {
    stateErrorKind: kind,
    ...(guardianPath === undefined ? {} : { guardianPath }),
  });
}

export async function getGuardianPaths(repoRoot: string): Promise<GuardianPaths> {
  const gitDir = await getCommonGitDir(repoRoot);
  const dir = path.join(gitDir, "opencode-guardian");
  return {
    dir,
    statePath: path.join(dir, "state.json"),
    eventsPath: path.join(dir, "events.jsonl"),
    reportPath: path.join(dir, "report.html"),
    lockPath: path.join(dir, "state.lock"),
  };
}

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

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function acquireStateLock(paths: GuardianPaths, options: { readonly timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const started = Date.now();
  await fs.mkdir(paths.dir, { recursive: true });

  while (true) {
    let handle: FileHandle | undefined;
    try {
      await assertNotSymlink(paths.lockPath, "lock");
      handle = await fs.open(paths.lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
      const acquiredHandle = handle;
      return async () => {
        await acquiredHandle.close();
        await fs.unlink(paths.lockPath).catch((error) => {
          if (errorCode(error) !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (errorCode(error) !== "EEXIST") throw error;
      if (Date.now() - started >= timeoutMs) {
        throw stateError("lock_timeout", `Timed out acquiring guardian state lock at ${paths.lockPath}`, paths.lockPath);
      }
      await sleep(25);
    }
  }
}

export async function writeStateAtomic(paths: GuardianPaths, state: GuardianState | GuardianStateRecord) {
  await fs.mkdir(paths.dir, { recursive: true });
  await assertNotSymlink(paths.statePath, "state");
  const tmpPath = `${paths.statePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
  await fs.rename(tmpPath, paths.statePath);
}

export async function writeReportAtomic(paths: GuardianPaths, html: string) {
  await fs.mkdir(paths.dir, { recursive: true });
  await assertNotSymlink(paths.reportPath, "report");
  const tmpPath = `${paths.reportPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, html);
  await fs.rename(tmpPath, paths.reportPath);
}

export async function appendEvent(paths: GuardianPaths, event: RecordLike) {
  await fs.mkdir(paths.dir, { recursive: true });
  await assertNotSymlink(paths.eventsPath, "events");
  await fs.appendFile(paths.eventsPath, `${JSON.stringify({ ...event, at: event.at ?? new Date().toISOString() })}\n`);
}

export async function updateState(repoRoot: string, config: GuardianConfigInput, updater: (state: GuardianStateRecord) => GuardianStateRecord | Promise<GuardianStateRecord>, options: { readonly paths?: GuardianPaths; readonly event?: RecordLike } = {}) {
  const paths = options.paths ?? await getGuardianPaths(repoRoot);
  const release = await acquireStateLock(paths, { timeoutMs: typeof config.lockTimeoutMs === "number" ? config.lockTimeoutMs : 5_000 });
  try {
    const previous = await readState(paths, { repoRoot, config });
    const next = await updater(structuredClone(previous));
    next.state_version = (previous.state_version ?? 0) + 1;
    next.updated_at = new Date().toISOString();
    const event = options.event ? { ...options.event, state_version: next.state_version } : null;
    if (event) await assertNotSymlink(paths.eventsPath, "events");
    await writeStateAtomic(paths, next);
    try {
      if (event) await appendEvent(paths, event);
    } catch (error) {
      await writeStateAtomic(paths, previous);
      throw error;
    }
    return next;
  } finally {
    await release();
  }
}

export async function recordSession(repoRoot: string, config: GuardianConfigInput, session: GuardianSession, options: { readonly paths?: GuardianPaths; readonly event?: RecordLike } = {}) {
  return updateState(repoRoot, config, (state) => {
    if (!state.sessions) state.sessions = {};
    const sessionId = session.session_id;
    if (!sessionId) throw new Error("session.session_id is required");
    const previous = isRecordLike(state.sessions[sessionId]) ? state.sessions[sessionId] : undefined;
    const now = new Date().toISOString();
    if (session.status === "active" && typeof session.worktree_path === "string") {
      for (const [candidateSessionId, candidate] of Object.entries(state.sessions)) {
        if (candidateSessionId !== sessionId && isRecordLike(candidate) && candidate.status === "active" && typeof candidate.worktree_path === "string" && path.resolve(candidate.worktree_path) === path.resolve(session.worktree_path)) {
          state.sessions[candidateSessionId] = {
            ...candidate,
            status: "superseded",
            superseded_by: sessionId,
            superseded_at: now,
            updated_at: now,
          };
        }
      }
    }
    state.sessions[sessionId] = clearTerminalLifecycleFields({
      ...previous,
      ...session,
      state_version: (typeof previous?.state_version === "number" ? previous.state_version : 0) + 1,
      safety_refs: session.safety_refs ?? previous?.safety_refs ?? [],
      created_at: previous?.created_at ?? now,
      updated_at: now,
    });
    return state;
  }, { ...options, event: options.event ?? { type: "session_recorded", session_id: session.session_id } });
}
