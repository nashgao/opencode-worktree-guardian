import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { getCommonGitDir } from "./git.ts";

export const STATE_SCHEMA_VERSION = "1.0.0";

export async function getGuardianPaths(repoRoot: string) {
  const gitDir = await getCommonGitDir(repoRoot);
  const dir = path.join(gitDir, "opencode-guardian");
  return {
    dir,
    statePath: path.join(dir, "state.json"),
    eventsPath: path.join(dir, "events.jsonl"),
    lockPath: path.join(dir, "state.lock"),
  };
}

export function createEmptyState({ repoRoot, config }: Record<string, any>) {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    state_version: 0,
    repo_root: repoRoot,
    base_branch: config.baseBranch,
    remote: config.remote,
    finish_mode: config.finishMode,
    worktree_root: config.worktreeRoot,
    sessions: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function assertNotSymlink(filePath: string, label: string) {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) throw new Error(`Refusing guardian ${label} symlink: ${filePath}`);
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
}

function validateStateShape(state: any) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Invalid guardian state: expected object");
  if (state.schema_version !== STATE_SCHEMA_VERSION) {
    throw new Error(`Unsupported guardian state schema_version: ${state.schema_version}`);
  }
  if (typeof state.state_version !== "number") throw new Error("Invalid guardian state: state_version must be a number");
  if (!state.sessions || typeof state.sessions !== "object" || Array.isArray(state.sessions)) {
    throw new Error("Invalid guardian state: sessions must be an object");
  }
  return state;
}

export async function readState(paths: Record<string, string>, context: Record<string, any>) {
  try {
    await assertNotSymlink(paths.statePath, "state");
    const raw = await fs.readFile(paths.statePath, "utf8");
    return validateStateShape(JSON.parse(raw));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return createEmptyState(context);
  }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function acquireStateLock(paths: Record<string, string>, options: Record<string, any> = {}) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const started = Date.now();
  await fs.mkdir(paths.dir, { recursive: true });

  while (true) {
    let handle: FileHandle | undefined;
    try {
      await assertNotSymlink(paths.lockPath, "lock");
      handle = await fs.open(paths.lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
      return async () => {
        await handle.close();
        await fs.unlink(paths.lockPath).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error.code !== "EEXIST") throw error;
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timed out acquiring guardian state lock at ${paths.lockPath}`);
      }
      await sleep(25);
    }
  }
}

export async function writeStateAtomic(paths: Record<string, string>, state: Record<string, any>) {
  await fs.mkdir(paths.dir, { recursive: true });
  await assertNotSymlink(paths.statePath, "state");
  const tmpPath = `${paths.statePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
  await fs.rename(tmpPath, paths.statePath);
}

export async function appendEvent(paths: Record<string, string>, event: Record<string, any>) {
  await fs.mkdir(paths.dir, { recursive: true });
  await assertNotSymlink(paths.eventsPath, "events");
  await fs.appendFile(paths.eventsPath, `${JSON.stringify({ ...event, at: event.at ?? new Date().toISOString() })}\n`);
}

export async function updateState(repoRoot: string, config: Record<string, any>, updater: (state: any) => any | Promise<any>, options: Record<string, any> = {}) {
  const paths = options.paths ?? await getGuardianPaths(repoRoot);
  const release = await acquireStateLock(paths, { timeoutMs: config.lockTimeoutMs });
  try {
    const previous = await readState(paths, { repoRoot, config });
    const next = await updater(structuredClone(previous));
    next.state_version = (previous.state_version ?? 0) + 1;
    next.updated_at = new Date().toISOString();
    await writeStateAtomic(paths, next);
    if (options.event) await appendEvent(paths, { ...options.event, state_version: next.state_version });
    return next;
  } finally {
    await release();
  }
}

export async function recordSession(repoRoot: string, config: Record<string, any>, session: Record<string, any>, options: Record<string, any> = {}) {
  return updateState(repoRoot, config, (state) => {
    const previous = state.sessions[session.session_id];
    state.sessions[session.session_id] = {
      ...previous,
      ...session,
      state_version: (previous?.state_version ?? 0) + 1,
      safety_refs: session.safety_refs ?? previous?.safety_refs ?? [],
      created_at: previous?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    return state;
  }, { ...options, event: options.event ?? { type: "session_recorded", session_id: session.session_id } });
}
