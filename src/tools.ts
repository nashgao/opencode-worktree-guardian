import fs from "node:fs/promises";
import path from "node:path";
import { expandWorktreeRoot, loadConfig } from "./config.ts";
import { guardianDeleteWorktree } from "./delete.ts";
import { guardianDone } from "./done.ts";
import { buildPreservedRef, createRef, getCurrentBranch, getHeadCommit, getRepoRoot, listWorktrees, runGit } from "./git.ts";
import { guardianFinish } from "./finish.ts";
import { guardianHygieneCleanup, scanWorkspaceHygiene } from "./hygiene.ts";
import { isTerminalSession } from "./lifecycle.ts";
import { guardianRecover, guardianStatus } from "./recover.ts";
import { guardianReportHtml } from "./report.ts";
import { getGuardianPaths, readState, recordSession } from "./state.ts";
import { guardianUnblockFinish } from "./unblock-finish.ts";
import { guardianFinishWorkflow } from "./workflow.ts";

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

function samePath(left: string, right: string) {
  return path.resolve(left) === path.resolve(right);
}

async function validateRecordedBinding(repoRoot: string, config: Record<string, any>, session: Record<string, any>, actualWorktree: string) {
  const expectedWorktree = session.worktree_path;
  if (!matchesWorktree(expectedWorktree, actualWorktree)) return { ok: false, reason: "session worktree path does not match actual worktree" };
  const entries = await listWorktrees(repoRoot);
  const matches = entries.filter((entry: any) => samePath(entry.path, expectedWorktree));
  if (matches.length !== 1) return { ok: false, reason: matches.length > 1 ? "recorded worktree path matches multiple git worktrees" : "recorded worktree is not checked out in git worktree list" };
  const entry: any = matches[0];
  if (entry.detached || !entry.branch) return { ok: false, reason: "recorded worktree is detached" };
  if (typeof session.branch === "string" && entry.branch !== session.branch) return { ok: false, reason: "recorded branch does not match checked-out worktree branch" };
  if (Array.isArray(config.protectedBranches) && config.protectedBranches.includes(entry.branch)) return { ok: false, reason: "recorded worktree branch is protected" };
  if (samePath(entry.path, repoRoot)) return { ok: false, reason: "recorded worktree is the primary repository worktree" };
  return { ok: true, branch: entry.branch };
}

async function validateOwnedSession(repoRoot: string, config: Record<string, any>, session: Record<string, any>) {
  if (!session.worktree_path) return { ok: false, reason: "recorded session has no worktree path" };
  return validateRecordedBinding(repoRoot, config, session, session.worktree_path);
}

function protectedBranchReason(config: Record<string, any>, branch: string | null) {
  if (!branch) return "detached HEAD cannot be recorded by guardian";
  return Array.isArray(config.protectedBranches) && config.protectedBranches.includes(branch)
    ? "protected branches cannot be recorded as Guardian-owned worktrees"
    : null;
}

async function createSessionWorktree(repoRoot: string, config: Record<string, any>, input: Record<string, any>, sessionId: string) {
  const branchName = input.branch ?? `${config.branchPrefix}${slug(input.taskName)}-${slug(sessionId).slice(0, 8)}`;
  const unsafeReason = protectedBranchReason(config, branchName);
  if (unsafeReason) return { ok: false, status: "blocked", reason: unsafeReason, branch: branchName };
  const worktreePath = await resolveWorktreeTarget(repoRoot, config, input.worktreePath, branchName);
  await runGit(repoRoot, ["worktree", "add", "-b", branchName, worktreePath, `${config.remote}/${config.baseBranch}`]);
  return { ok: true, branch: branchName, worktreePath };
}

export async function resolveSessionWorktree(input: Record<string, any> = {}) {
  const sessionId = input.sessionId ?? input.sessionID;
  if (!sessionId) return { ok: true, sessionId: null, expectedWorktree: null, actualWorktree: null, matches: true };

  const cwd = input.cwd ?? input.repoRoot ?? process.cwd();
  const repoRoot = input.repoRoot ?? await getRepoRoot(cwd);
  const actualWorktree = input.actualWorktree ?? await getRepoRoot(cwd);
  const cache = input.cache;
  const validateBinding = input.validateBinding === true;
  const cachedWorktree = typeof cache?.get === "function" ? cache.get(sessionId) : null;

  if (cachedWorktree && !validateBinding) {
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
  if (isTerminalSession(session)) {
    return { ok: true, sessionId, expectedWorktree: null, actualWorktree, matches: true, source: "terminal-state", terminal: true, status: session.status };
  }
  if (!session?.worktree_path) {
    return { ok: true, sessionId, expectedWorktree: null, actualWorktree, matches: true, source: "state" };
  }

  if (typeof cache?.set === "function") cache.set(sessionId, session.worktree_path);
  const matches = matchesWorktree(session.worktree_path, actualWorktree);
  if (matches && validateBinding) {
    const binding = await validateRecordedBinding(repoRoot, config, session, actualWorktree);
    if (!binding.ok) {
      return {
        ok: false,
        reason: binding.reason,
        sessionId,
        expectedWorktree: session.worktree_path,
        actualWorktree,
        matches: false,
        source: "state",
      };
    }
  }
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
  if (isTerminalSession(existing)) {
    return {
      ok: false,
      status: "blocked",
      reason: `session ${sessionId} is terminal (${existing.status}); start a new session instead of recreating a deleted or finished worktree`,
      session: existing,
      stateVersion: state.state_version,
    };
  }
  if (existing?.status === "active" && existing.worktree_path) {
    const binding = await validateOwnedSession(repoRoot, config, existing);
    if (binding.ok) return { ok: true, session: existing, stateVersion: state.state_version, existing: true };
    if (input.createWorktree !== true) {
      return {
        ok: false,
        status: "blocked",
        reason: `recorded session cannot be used: ${binding.reason}; rerun guardian_start with createWorktree=true`,
        session: existing,
        stateVersion: state.state_version,
      };
    }
    const previous = { worktree_path: existing.worktree_path, branch: existing.branch, reason: binding.reason };
    const created = await createSessionWorktree(repoRoot, config, input, sessionId);
    if (!created.ok) return { ...created, session: existing, stateVersion: state.state_version, previous };
    const headCommit = await getHeadCommit(created.worktreePath);
    const repairedSession = {
      ...existing,
      session_id: sessionId,
      status: "active",
      branch: created.branch,
      worktree_path: created.worktreePath,
      base_ref: `${config.remote}/${config.baseBranch}`,
      head_commit: headCommit,
      safety_refs: existing.safety_refs ?? [],
    };
    const repairedState = await recordSession(repoRoot, config, repairedSession, { event: { type: "guardian_start_repair", session_id: sessionId, reason: binding.reason } });
    return { ok: true, session: repairedState.sessions[sessionId], stateVersion: repairedState.state_version, existing: false, repaired: true, previous };
  }

  let worktreePath = await getRepoRoot(cwd);
  let branch = await getCurrentBranch(worktreePath);

  if (input.createWorktree === true) {
    const created = await createSessionWorktree(repoRoot, config, input, sessionId);
    if (!created.ok) return { ...created, stateVersion: state.state_version };
    worktreePath = created.worktreePath;
    branch = created.branch;
  }

  if (!branch) throw new Error("Cannot start guardian session from detached HEAD");
  const unsafeReason = input.createWorktree === true ? null : protectedBranchReason(config, branch);
  if (unsafeReason) return { ok: false, status: "blocked", reason: unsafeReason, branch, worktreePath };
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
    "- Guardian auto-starts session worktree ownership by default; repo config autoStart=false disables automatic ownership.",
    "- Do not run raw destructive git cleanup, reset, stash mutation, force-push, worktree removal, or rm -rf against worktrees.",
    "- Finish Guardian work through guardian_finish so the configured mode can push, suggest a PR, preserve, or explicitly merge protected branches after gates pass.",
    "- Use guardian_status for read-only inspection and guardian_finish for gated completion.",
    "- Safe mutating shell/git tool calls for a recorded Guardian session are routed into that recorded worktree automatically.",
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
  const unsafeReason = protectedBranchReason(config, branch);
  if (unsafeReason) return { ok: false, status: "blocked", reason: unsafeReason, branch, worktreePath };
  const headCommit = await getHeadCommit(worktreePath);
  const preservedRef = buildPreservedRef(sessionId, branch, input.timestamp);
  await createRef(worktreePath, preservedRef, headCommit);
  const recordedState = await recordSession(repoRoot, config, {
    session_id: sessionId,
    status: "preserved",
    branch,
    worktree_path: worktreePath,
    base_ref: `${config.remote}/${config.baseBranch}`,
    head_commit: headCommit,
    safety_refs: [preservedRef],
  }, { event: { type: "guardian_preserve", session_id: sessionId, ref: preservedRef } });
  return { ok: true, status: "preserved", session: recordedState.sessions[sessionId], preservedRef };
}

export function rewriteGuardianCommand(input: Record<string, any> = {}, output: Record<string, any> = {}) {
  const command = input?.command;
  if (typeof command !== "string") return false;
  const match = command.trim().match(/^\/?guardian\s+(done|status|finish-workflow|finish|preserve|recover|report|start|hygiene-cleanup|hygiene|delete-worktree|unblock-finish)\b(.*)$/);
  if (!match) return false;
  const [, action, rest] = match;
  const toolName = action === "report" ? "guardian_report_html" : action === "delete-worktree" ? "guardian_delete_worktree" : action === "hygiene-cleanup" ? "guardian_hygiene_cleanup" : action === "unblock-finish" ? "guardian_unblock_finish" : action === "finish-workflow" ? "guardian_finish_workflow" : `guardian_${action}`;
  const deleteGuidance = action === "delete-worktree" ? " Run mode=plan first. Stale local Guardian branch cleanup requires an exact branch or terminal sessionId plus deleteBranch=true and Guardian ownership proof from terminal state or safety refs. Intentional unmerged local abandonment requires deleteBranch=true plus abandonUnmerged=true in both plan and apply after inspecting unmerged commit evidence." : "";
  const hygieneCleanupGuidance = action === "hygiene-cleanup" ? " Run mode=plan first, inspect exact targets/blockers, get explicit user confirmation, then apply with confirmDelete=true. guardian_hygiene remains report-only." : "";
  const doneGuidance = action === "done" ? " Run mode=plan first. Dirty primary-main publishing requires an explicit commitMessage and fresh confirmToken; cleanup after publish returns a separate cleanup plan and must not be silently applied." : "";
  const text = `Use the ${toolName} native tool.${deleteGuidance}${hygieneCleanupGuidance}${doneGuidance}${rest.trim() ? ` User arguments: ${rest.trim()}` : ""}`;
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
  const guardianPaths = await getGuardianPaths(repoRoot);
  const state = await readState(guardianPaths, { repoRoot, config });
  const existing = state.sessions?.[sessionId];
  if (isTerminalSession(existing)) return { ok: true, status: "skipped", reason: `session ${sessionId} is terminal (${existing.status})`, session: existing };
  const worktreePath = await getRepoRoot(cwd);
  const branch = await getCurrentBranch(worktreePath);
  if (!branch) return { ok: false, reason: "detached HEAD" };
  const unsafeReason = protectedBranchReason(config, branch);
  if (unsafeReason) return { ok: false, reason: unsafeReason, branch, worktreePath };
  const headCommit = await getHeadCommit(worktreePath);
  const recordedState = await recordSession(repoRoot, config, {
    session_id: sessionId,
    status: "active",
    branch,
    worktree_path: worktreePath,
    base_ref: `${config.remote}/${config.baseBranch}`,
    head_commit: headCommit,
  }, { event: { type: "last_safe_state", session_id: sessionId, tool: input.tool } });
  return { ok: true, session: recordedState.sessions[sessionId], stateVersion: recordedState.state_version };
}

export async function runGuardianTool(name: string, input: Record<string, any> = {}): Promise<Record<string, any>> {
  if (name === "guardian_done") return guardianDone(input);
  if (name === "guardian_start") return guardianStart(input);
  if (name === "guardian_status") return guardianStatus(input);
  if (name === "guardian_delete_worktree") return guardianDeleteWorktree(input);
  if (name === "guardian_finish") return guardianFinish(input);
  if (name === "guardian_finish_workflow") return guardianFinishWorkflow(input);
  if (name === "guardian_preserve") return guardianPreserve(input);
  if (name === "guardian_recover") return guardianRecover(input);
  if (name === "guardian_report_html") return guardianReportHtml(input);
  if (name === "guardian_hygiene") return scanWorkspaceHygiene(input);
  if (name === "guardian_hygiene_cleanup") return guardianHygieneCleanup(input);
  if (name === "guardian_unblock_finish") return guardianUnblockFinish(input);
  throw new Error(`Unknown guardian tool: ${name}`);
}
