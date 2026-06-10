import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expandWorktreeRoot, loadConfig } from "./config.ts";

const execFileAsync = promisify(execFile);
import { guardianFinish } from "./finish.ts";
import { createSafetyRef, fetchRemote, getCurrentBranch, getHeadCommit, getRefCommit, getRepoRoot, isAncestor, listStashes, runGit } from "./git.ts";
import { guardianFinishWorkflow } from "./workflow.ts";
import { isActiveSession } from "./lifecycle.ts";
import { getGuardianPaths, readState } from "./state.ts";

function samePath(left: string, right: string) {
  return path.resolve(left) === path.resolve(right);
}

function isInside(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isGuardianWorktreeStatusPath(repoRoot: string, config: Record<string, any>, statusPath: string) {
  const guardianRoot = path.resolve(repoRoot, expandWorktreeRoot(String(config.worktreeRoot), repoRoot));
  const absoluteStatusPath = path.resolve(repoRoot, statusPath.replace(/\/$/, ""));
  return isInside(absoluteStatusPath, guardianRoot);
}

function blocked(reason: string, details: Record<string, unknown> = {}, preflight?: Record<string, unknown>) {
  if (preflight) preflight.blockers = [...((preflight.blockers as string[] | undefined) ?? []), reason];
  return { ok: false, status: "blocked", reason, ...details, ...(preflight ? { preflight } : {}) };
}

function text(input: unknown) {
  return typeof input === "string" ? input : "";
}

function errorMessage(error: unknown) {
  if (typeof error === "object" && error !== null) {
    const details = error as Record<string, unknown>;
    if (typeof details.gitStderr === "string" && details.gitStderr.length > 0) return details.gitStderr;
    if (typeof details.message === "string" && details.message.length > 0) return details.message;
  }
  return String(error);
}

async function statusEntries(repoRoot: string) {
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, "status", "--porcelain=v1", "--untracked-files=all", "-z"], { maxBuffer: 10 * 1024 * 1024 });
  if (!stdout) return [];
  const rawEntries = stdout.split("\0").filter(Boolean);
  const entries: Array<{ status: string; path: string; sourcePath?: string }> = [];
  for (let index = 0; index < rawEntries.length; index += 1) {
    const entry = rawEntries[index];
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (!filePath) continue;
    if (status.includes("R") || status.includes("C")) {
      const sourcePath = rawEntries[index + 1];
      entries.push({ status, path: filePath, sourcePath });
      index += 1;
    } else {
      entries.push({ status, path: filePath });
    }
  }
  return entries;
}

async function fileFingerprint(repoRoot: string, relativePath: string) {
  const absolutePath = path.join(repoRoot, relativePath);
  try {
    const stat = await fs.lstat(absolutePath);
    if (!stat.isFile()) return { path: relativePath, kind: stat.isDirectory() ? "directory" : "other", size: stat.size, hash: null };
    const content = await fs.readFile(absolutePath);
    return { path: relativePath, kind: "file", size: stat.size, hash: crypto.createHash("sha256").update(content).digest("hex") };
  } catch (error: any) {
    if (error.code === "ENOENT") return { path: relativePath, kind: "missing", size: null, hash: null };
    throw error;
  }
}

async function dirtySnapshot(repoRoot: string, config?: Record<string, any>) {
  const allEntries = await statusEntries(repoRoot);
  const entries = config ? allEntries.filter((entry) => !isGuardianWorktreeStatusPath(repoRoot, config, entry.path)) : allEntries;
  const paths = [...new Set(entries.flatMap((entry) => [entry.path, entry.sourcePath].filter((value): value is string => typeof value === "string" && value.length > 0)))].sort((left, right) => left.localeCompare(right));
  const fingerprints = [];
  for (const filePath of paths) fingerprints.push(await fileFingerprint(repoRoot, filePath));
  return { entries, paths, fingerprints };
}

function createPrimaryToken(preflight: Record<string, unknown>, snapshot: Record<string, unknown>, commitMessage: string) {
  const material = {
    repoRoot: preflight.repoRoot,
    branch: preflight.currentBranch,
    head: preflight.head,
    baseRef: preflight.baseRef,
    baseRefOid: preflight.baseRefOid,
    commitMessage,
    snapshot,
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

async function primaryPreflight(repoRoot: string, cwd: string, config: Record<string, any>, input: Record<string, unknown>) {
  const currentWorktree = await getRepoRoot(cwd);
  const branch = await getCurrentBranch(currentWorktree);
  const baseRef = `${String(config.remote)}/${String(config.baseBranch)}`;
  const preflight: Record<string, unknown> = {
    repoRoot: path.resolve(repoRoot),
    currentWorktree,
    currentBranch: branch,
    baseBranch: config.baseBranch,
    remote: config.remote,
    baseRef,
    baseRefOid: null,
    baseRefFetched: false,
    head: null,
    branchProtected: Array.isArray(config.protectedBranches) && typeof branch === "string" ? config.protectedBranches.includes(branch) : false,
    stashCount: 0,
    dirtyFileCount: 0,
    dirtyFiles: [],
    blockers: [],
  };

  if (!samePath(currentWorktree, repoRoot)) return { ok: false, preflight, result: blocked("primary-main publish requires the primary repository worktree", { currentWorktree, repoRoot }, preflight) };
  if (!branch) return { ok: false, preflight, result: blocked("detached HEAD cannot be published by guardian_done", {}, preflight) };
  if (branch !== config.baseBranch) return { ok: false, preflight, result: blocked("primary-main publish requires the configured base branch", { branch, baseBranch: config.baseBranch }, preflight) };
  if (!preflight.branchProtected) return { ok: false, preflight, result: blocked("primary-main publish lane requires a protected base branch", { branch }, preflight) };

  try {
    await fetchRemote(repoRoot, String(config.remote));
    preflight.baseRefFetched = true;
    preflight.baseRefOid = await getRefCommit(repoRoot, baseRef);
  } catch (error) {
    return { ok: false, preflight, result: blocked("remote base ref could not be fetched or resolved", { baseRef, error: errorMessage(error) }, preflight) };
  }

  const head = await getHeadCommit(repoRoot);
  preflight.head = head;
  if (head !== preflight.baseRefOid) return { ok: false, preflight, result: blocked("primary base branch is not synced to remote; sync before publishing dirty primary work", { head, baseRefOid: preflight.baseRefOid }, preflight) };

  const stashes = await listStashes(repoRoot);
  preflight.stashCount = stashes.length;
  if (stashes.length > 0 && config.allowStashIfUnrelated !== true) return { ok: false, preflight, result: blocked("stash inventory is non-empty", { stashes }, preflight) };

  const snapshot = await dirtySnapshot(repoRoot, config);
  preflight.dirtyFiles = snapshot.paths;
  preflight.dirtyFileCount = snapshot.paths.length;
  if (snapshot.paths.length === 0) return { ok: false, preflight, result: blocked("primary-main publish requires dirty implemented code; use cleanup-only lane instead", {}, preflight) };

  const commitMessage = text(input.commitMessage).trim();
  if (!commitMessage) return { ok: false, preflight, result: blocked("commitMessage is required for primary-main publish", { dirtyFiles: snapshot.paths }, preflight) };

  const confirmToken = createPrimaryToken(preflight, snapshot, commitMessage);
  return { ok: true, preflight, snapshot, commitMessage, confirmToken };
}

async function primaryMainDone(repoRoot: string, cwd: string, config: Record<string, any>, input: Record<string, unknown>) {
  const mode = input.mode ?? "plan";
  const planned = await primaryPreflight(repoRoot, cwd, config, input);
  if (!planned.ok) return planned.result;
  const { preflight, snapshot, commitMessage, confirmToken } = planned;
  const plan = {
    ok: true,
    status: "planned",
    lane: "primary-main-publish",
    confirmToken,
    commitMessage,
    preflight,
    dirtySnapshot: snapshot,
    nextAction: "After explicit user confirmation, apply with confirm=true and the same commitMessage to create a safety ref, commit the token-bound dirty files, push the base branch, fetch, and return a fresh cleanup plan.",
  };
  if (mode === "plan") return plan;
  if (mode !== "apply") return blocked("mode must be plan or apply", { mode }, preflight);
  if (input.confirmToken !== confirmToken) return blocked("plan changed; rerun plan and review the updated dirty files before applying", { tokenMatched: false }, preflight);

  const branch = String(preflight.currentBranch);
  const head = String(preflight.head);
  const safetyRef = await createSafetyRef(repoRoot, { sessionId: input.sessionId ?? "primary-main", branch, commit: head, timestamp: input.timestamp });
  preflight.safetyRef = safetyRef;
  const dirtyPaths = (snapshot as { paths: string[] }).paths;
  try {
    await runGit(repoRoot, ["add", "--", ...dirtyPaths]);
    await runGit(repoRoot, ["commit", "-m", commitMessage]);
  } catch (error) {
    return blocked("commit failed", { safetyRef, error: errorMessage(error) }, preflight);
  }

  const commit = await getHeadCommit(repoRoot);
  try {
    await runGit(repoRoot, ["push", String(config.remote), branch]);
    await fetchRemote(repoRoot, String(config.remote));
  } catch (error) {
    return blocked("push failed after commit; safety ref preserves the pre-commit head", { safetyRef, commit, error: errorMessage(error) }, preflight);
  }

  const proven = await isAncestor(repoRoot, commit, `${String(config.remote)}/${String(config.baseBranch)}`);
  if (!proven) return blocked("published commit is not proven reachable from remote base", { safetyRef, commit }, preflight);
  const cleanupPlan = await guardianFinishWorkflow({ repoRoot, cwd: repoRoot, mode: "plan", config });
  return { ok: true, status: "published", lane: "primary-main-publish", branch, commit, safetyRef, preflight, cleanupPlan };
}

export async function guardianDone(input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const { config } = input.config && typeof input.config === "object" ? { config: input.config as Record<string, any> } : await loadConfig(repoRoot);
  const mode = input.mode ?? "plan";
  if (mode !== "plan" && mode !== "apply") return { ok: false, status: "blocked", reason: "mode must be plan or apply", mode };

  const currentWorktree = await getRepoRoot(cwd);
  const currentBranch = await getCurrentBranch(currentWorktree);
  const baseBranch = String(config.baseBranch);
  const protectedBranches = Array.isArray(config.protectedBranches) ? config.protectedBranches : [];
  const state = await readState(await getGuardianPaths(repoRoot), { repoRoot, config });
  const sessionId = typeof input.sessionId === "string" && input.sessionId.trim().length > 0 ? input.sessionId : null;
  const currentSession = sessionId ? state.sessions?.[sessionId] : null;

  if (currentSession && isActiveSession(currentSession) && typeof currentSession.worktree_path === "string") {
    if (!samePath(currentWorktree, currentSession.worktree_path)) {
      const snapshot = samePath(currentWorktree, repoRoot) ? await dirtySnapshot(repoRoot, config) : { paths: [] };
      if (snapshot.paths.length > 0) {
        return blocked("changes were made outside the active Guardian lane; consolidate them before finishing", {
          lane: "wrong-lane-dirty-work",
          dirtyFiles: snapshot.paths,
          nextAction: "Review the dirty files, then rerun guardian_done after they are moved into the active lane or intentionally published from primary.",
        });
      }
      const result = await guardianFinish({ ...input, repoRoot, cwd: currentSession.worktree_path, sessionId, config });
      return { ...result, lane: "session-finish" };
    }
    const result = await guardianFinish({ ...input, repoRoot, cwd: currentWorktree, sessionId, config });
    return { ...result, lane: "session-finish" };
  }

  if (typeof input.sessionId === "string" && !samePath(currentWorktree, repoRoot)) {
    return blocked("no active Guardian lane is recorded for this session; run guardian_status for recovery details", { lane: "missing-session-lane" });
  }

  if (samePath(currentWorktree, repoRoot) && currentBranch === baseBranch && protectedBranches.includes(baseBranch)) {
    const snapshot = await dirtySnapshot(repoRoot, config);
    if (snapshot.paths.length > 0) return primaryMainDone(repoRoot, currentWorktree, config, input);
    const cleanup = await guardianFinishWorkflow({ ...input, repoRoot, cwd: repoRoot, config });
    return { ...cleanup, lane: "cleanup-only" };
  }

  if (samePath(currentWorktree, repoRoot) && currentBranch && protectedBranches.includes(currentBranch)) {
    return {
      ok: false,
      status: "blocked",
      lane: "primary-rescue-recommended",
      reason: "dirty protected primary work is not on the configured base branch; rescue it to a Guardian worktree before finishing",
      currentBranch,
      baseBranch,
      suggestedCommands: ["guardian_start createWorktree=true", "guardian_status"],
    };
  }

  return {
    ok: false,
    status: "blocked",
    lane: "blocked",
    reason: "guardian_done could not choose a safe finish lane; use guardian_status for evidence or guardian_finish from an owned session worktree",
    currentWorktree,
    currentBranch,
    baseBranch,
  };
}
