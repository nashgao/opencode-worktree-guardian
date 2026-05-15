import fs from "node:fs/promises";
import path from "node:path";
import { expandWorktreeRoot, loadConfig } from "./config.ts";
import { buildPreservedRef, createRef, getCurrentBranch, getHeadCommit, getRepoRoot, listWorktrees, runGit } from "./git.ts";
import { guardianFinish } from "./finish.ts";
import { guardianRecover, guardianStatus } from "./recover.ts";
import { getGuardianPaths, readState, recordSession } from "./state.ts";

async function safeRealpath(candidate: string) {
  try {
    return await fs.realpath(candidate);
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    return path.resolve(candidate);
  }
}

function isSameOrInside(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function resolveWorktreeTarget(repoRoot: string, config: Record<string, any>, requestedPath: string | undefined, branchName: string) {
  const root = path.resolve(repoRoot, expandWorktreeRoot(config.worktreeRoot, repoRoot));
  await fs.mkdir(root, { recursive: true });
  const resolvedRoot = await safeRealpath(root);
  const target = requestedPath ? path.resolve(repoRoot, requestedPath) : path.join(resolvedRoot, slug(branchName));
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const resolvedParent = await safeRealpath(parent);
  const resolvedTarget = path.join(resolvedParent, path.basename(target));
  if (!isSameOrInside(resolvedTarget, resolvedRoot)) {
    throw new Error(`worktreePath must stay inside configured worktreeRoot: ${config.worktreeRoot}`);
  }
  return resolvedTarget;
}

function slug(value: unknown) {
  return String(value ?? "work")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "work";
}

export async function collectKnownWorktreePaths(input: Record<string, any> = {}): Promise<string[]> {
  const cwd = input.cwd ?? input.repoRoot ?? process.cwd();
  const repoRoot = input.repoRoot ?? await getRepoRoot(cwd);
  const { config } = input.config ? { config: input.config } : await loadConfig(repoRoot);
  const paths = new Set<string>();
  if (input.currentWorktree) paths.add(path.resolve(input.currentWorktree));
  try {
    const worktreeRoot = path.resolve(repoRoot, expandWorktreeRoot(config.worktreeRoot, repoRoot));
    paths.add(worktreeRoot);
  } catch {}
  try {
    for (const entry of await listWorktrees(repoRoot)) paths.add(path.resolve(entry.path));
  } catch {}
  try {
    const guardianPaths = await getGuardianPaths(repoRoot);
    const state = await readState(guardianPaths, { repoRoot, config });
    const sessions: Array<Record<string, any>> = Object.values(state.sessions ?? {});
    for (const session of sessions) {
      if (session?.worktree_path) paths.add(path.resolve(session.worktree_path));
    }
  } catch {}
  return [...paths];
}

function matchesWorktree(expectedWorktree: string, actualPath: string) {
  return isSameOrInside(path.resolve(actualPath), path.resolve(expectedWorktree));
}

export async function resolveSessionWorktree(input: Record<string, any> = {}) {
  const sessionId = input.sessionId ?? input.sessionID;
  if (!sessionId) return { ok: true, sessionId: null, expectedWorktree: null, actualWorktree: null, matches: true };

  const cwd = input.cwd ?? input.repoRoot ?? process.cwd();
  const repoRoot = input.repoRoot ?? await getRepoRoot(cwd);
  const actualWorktree = input.actualWorktree ?? await getRepoRoot(cwd);
  const cache = input.cache;
  const cachedWorktree = typeof cache?.get === "function" ? cache.get(sessionId) : null;

  if (cachedWorktree) {
    const matches = matchesWorktree(cachedWorktree, actualWorktree);
    return {
      ok: matches,
      sessionId,
      expectedWorktree: cachedWorktree,
      actualWorktree,
      matches,
      source: "cache",
    };
  }

  const { config } = input.config ? { config: input.config } : await loadConfig(repoRoot);
  const state = input.state ?? await readState(await getGuardianPaths(repoRoot), { repoRoot, config });
  const session = state.sessions?.[sessionId];
  if (!session?.worktree_path) {
    return { ok: true, sessionId, expectedWorktree: null, actualWorktree, matches: true, source: "state" };
  }

  if (typeof cache?.set === "function") cache.set(sessionId, session.worktree_path);
  const matches = matchesWorktree(session.worktree_path, actualWorktree);
  return {
    ok: matches,
    sessionId,
    expectedWorktree: session.worktree_path,
    actualWorktree,
    matches,
    source: "state",
  };
}

export async function guardianStart(input: Record<string, any> = {}) {
  const cwd = input.cwd ?? input.repoRoot ?? process.cwd();
  const repoRoot = input.repoRoot ?? await getRepoRoot(cwd);
  const { config } = input.config ? { config: input.config } : await loadConfig(repoRoot);
  const sessionId = input.sessionId;
  if (!sessionId) throw new Error("sessionId is required");
  const guardianPaths = await getGuardianPaths(repoRoot);
  const state = await readState(guardianPaths, { repoRoot, config });
  const existing = state.sessions?.[sessionId];
  if (existing?.status === "active" && existing.worktree_path) {
    return { ok: true, session: existing, stateVersion: state.state_version, existing: true };
  }

  let worktreePath = await getRepoRoot(cwd);
  let branch = await getCurrentBranch(worktreePath);

  if (input.createWorktree === true) {
    const branchName = input.branch ?? `${config.branchPrefix}${slug(input.taskName)}-${slug(sessionId).slice(0, 8)}`;
    worktreePath = await resolveWorktreeTarget(repoRoot, config, input.worktreePath, branchName);
    await runGit(repoRoot, ["worktree", "add", "-b", branchName, worktreePath, `${config.remote}/${config.baseBranch}`]);
    branch = branchName;
  }

  if (!branch) throw new Error("Cannot start guardian session from detached HEAD");
  const headCommit = await getHeadCommit(worktreePath);
  const session = {
    session_id: sessionId,
    status: "active",
    branch,
    worktree_path: worktreePath,
    base_ref: `${config.remote}/${config.baseBranch}`,
    head_commit: headCommit,
    safety_refs: [],
  };

  const recordedState = await recordSession(repoRoot, config, session, { event: { type: "guardian_start", session_id: sessionId } });
  return { ok: true, session: recordedState.sessions[sessionId], stateVersion: recordedState.state_version };
}

export function buildInvisiblePolicy(config: Record<string, any>) {
  return [
    "Worktree Guardian policy:",
    "- Treat the current guardian-owned worktree and branch as preserved user work.",
    "- Do not run raw destructive git cleanup, reset, stash mutation, force-push, worktree removal, or rm -rf against worktrees.",
    "- Use guardian_status for read-only inspection and guardian_finish for gated completion.",
    `- Default finish mode is ${config.finishMode}; auto-finish is ${config.autoFinish ? "enabled by repo config" : "disabled"} unless repo config opts in.`,
  ].join("\n");
}

export function injectInvisiblePolicy(output: Record<string, any> | null | undefined, config: Record<string, any>) {
  if (!output || typeof output !== "object") return false;
  const policy = buildInvisiblePolicy(config);
  if (Array.isArray(output.system)) {
    output.system.push(policy);
    return true;
  }
  if (typeof output.system === "string") {
    output.system = `${output.system}\n\n${policy}`;
    return true;
  }
  output.system = [policy];
  return true;
}

export async function guardianPreserve(input: Record<string, any> = {}) {
  const cwd = input.cwd ?? input.repoRoot ?? process.cwd();
  const repoRoot = input.repoRoot ?? await getRepoRoot(cwd);
  const { config } = input.config ? { config: input.config } : await loadConfig(repoRoot);
  const sessionId = input.sessionId;
  if (!sessionId) throw new Error("sessionId is required");

  const worktreePath = await getRepoRoot(cwd);
  const branch = await getCurrentBranch(worktreePath);
  if (!branch) throw new Error("Cannot preserve detached HEAD");
  const headCommit = await getHeadCommit(worktreePath);
  const preservedRef = buildPreservedRef(sessionId, branch, input.timestamp);
  await createRef(worktreePath, preservedRef, headCommit);
  const state = await recordSession(repoRoot, config, {
    session_id: sessionId,
    status: "preserved",
    branch,
    worktree_path: worktreePath,
    base_ref: `${config.remote}/${config.baseBranch}`,
    head_commit: headCommit,
    safety_refs: [preservedRef],
  }, { event: { type: "guardian_preserve", session_id: sessionId, ref: preservedRef } });
  return { ok: true, status: "preserved", session: state.sessions[sessionId], preservedRef };
}

export function rewriteGuardianCommand(input: Record<string, any> = {}, output: Record<string, any> = {}) {
  const command = input?.command;
  if (typeof command !== "string") return false;
  const match = command.trim().match(/^\/?guardian\s+(status|finish|preserve|recover|start)\b(.*)$/);
  if (!match) return false;
  const [, action, rest] = match;
  const toolName = `guardian_${action}`;
  const text = `Use the ${toolName} native tool.${rest.trim() ? ` User arguments: ${rest.trim()}` : ""}`;
  if (!output || typeof output !== "object") return false;
  output.parts = [{ type: "text", text }];
  return true;
}

export async function recordLastSafeState(input: Record<string, any> = {}) {
  const cwd = input.cwd ?? input.repoRoot ?? process.cwd();
  const repoRoot = input.repoRoot ?? await getRepoRoot(cwd);
  const { config } = input.config ? { config: input.config } : await loadConfig(repoRoot);
  const sessionId = input.sessionId ?? input.sessionID;
  if (!sessionId) return { ok: false, reason: "sessionId is required" };
  const worktreePath = await getRepoRoot(cwd);
  const branch = await getCurrentBranch(worktreePath);
  if (!branch) return { ok: false, reason: "detached HEAD" };
  const headCommit = await getHeadCommit(worktreePath);
  const state = await recordSession(repoRoot, config, {
    session_id: sessionId,
    status: "active",
    branch,
    worktree_path: worktreePath,
    base_ref: `${config.remote}/${config.baseBranch}`,
    head_commit: headCommit,
  }, { event: { type: "last_safe_state", session_id: sessionId, tool: input.tool } });
  return { ok: true, session: state.sessions[sessionId], stateVersion: state.state_version };
}

export async function runGuardianTool(name: string, input: Record<string, any> = {}): Promise<Record<string, any>> {
  if (name === "guardian_start") return guardianStart(input);
  if (name === "guardian_status") return guardianStatus(input);
  if (name === "guardian_finish") return guardianFinish(input);
  if (name === "guardian_preserve") return guardianPreserve(input);
  if (name === "guardian_recover") return guardianRecover(input);
  throw new Error(`Unknown guardian tool: ${name}`);
}
