import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expandWorktreeRoot, loadConfig } from "./config.ts";
import { createSafetyRef, getCurrentBranch, getHeadCommit, getRepoRoot, listWorktrees, runGit } from "./git.ts";
import { getGuardianPaths, readState, recordSession } from "./state.ts";

type StatusEntry = {
  index: string;
  worktree: string;
  path: string;
  sourcePath: string | null;
  hash: string | null;
  symlink: boolean;
  classification: "review-artifact" | "other";
};

type ResolvedTarget = {
  worktreePath: string;
  branch: string | null;
  targetSource: "state" | "branch" | "worktreePath";
};

const REVIEW_ARTIFACT_PATTERN = /^\.milestones\/reviews\/[^/]*impl-rating-\d{8}\.(md|txt)$/;

function sha256(value: string | Buffer) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function blocked(reason: string, details: Record<string, unknown>, preflight: Record<string, unknown>) {
  preflight.blockers = [...((preflight.blockers as string[] | undefined) ?? []), reason];
  return { ok: false, status: "blocked", reason, ...details, preflight: { ...preflight, blockers: [...(preflight.blockers as string[])] } };
}

function relativeGitPath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function samePath(left: string, right: string) {
  return path.resolve(left) === path.resolve(right);
}

function sameOrInside(candidate: string, root: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function contentHash(repoRoot: string, entryPath: string) {
  try {
    return sha256(await fs.readFile(path.join(repoRoot, entryPath)));
  } catch {
    return null;
  }
}

async function isSymlink(repoRoot: string, entryPath: string) {
  try {
    return (await fs.lstat(path.join(repoRoot, entryPath))).isSymbolicLink();
  } catch {
    return false;
  }
}

async function statusEntries(worktreePath: string): Promise<StatusEntry[]> {
  const { stdout } = await runGit(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!stdout) return [];
  const entries: StatusEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const index = line[0] ?? " ";
    const worktree = line[1] ?? " ";
    const rawPath = relativeGitPath(line.slice(3));
    const [sourcePath, entryPath] = rawPath.includes(" -> ")
      ? [relativeGitPath(rawPath.split(" -> ")[0] ?? rawPath), relativeGitPath(rawPath.split(" -> ").at(-1) ?? rawPath)]
      : [null, rawPath];
    const symlink = await isSymlink(worktreePath, entryPath);
    entries.push({
      index,
      worktree,
      path: entryPath,
      sourcePath,
      hash: await contentHash(worktreePath, entryPath),
      symlink,
      classification: !sourcePath && !symlink && REVIEW_ARTIFACT_PATTERN.test(entryPath) ? "review-artifact" : "other",
    });
  }
  return entries;
}

function createConfirmToken(preflight: Record<string, unknown>) {
  const material = {
    repoRoot: preflight.repoRoot,
    sessionId: preflight.sessionId,
    targetSource: preflight.targetSource,
    sessionRecorded: preflight.sessionRecorded,
    worktreePath: preflight.worktreePath,
    branch: preflight.branch,
    head: preflight.head,
    action: preflight.action,
    entries: preflight.entries,
  };
  return sha256(JSON.stringify(material));
}

function defaultCommitMessage(entries: StatusEntry[]) {
  if (entries.length === 1) {
    const base = path.basename(entries[0].path).replace(/-?impl-rating-\d{8}\.(md|txt)$/i, "").replace(/[-_]+/g, " ").trim();
    if (base) return `docs: add ${base} implementation rating`;
  }
  return "docs: add implementation review artifacts";
}

async function resolveListedWorktree(repoRoot: string, predicate: (worktree: any) => boolean, targetSource: ResolvedTarget["targetSource"], missingReason: string, multipleReason: string, expectedBranch?: string | null): Promise<{ target: ResolvedTarget | null; reason: string | null }> {
  const matches = (await listWorktrees(repoRoot)).filter(predicate);
  if (matches.length !== 1) return { target: null, reason: matches.length > 1 ? multipleReason : missingReason };
  const match = matches[0];
  if (match.detached || !match.branch) return { target: null, reason: "target worktree is detached" };
  if (expectedBranch && match.branch !== expectedBranch) return { target: null, reason: "recorded branch does not match checked-out worktree branch" };
  return { target: { worktreePath: match.path, branch: match.branch, targetSource }, reason: null };
}

async function resolveExplicitTarget(repoRoot: string, input: Record<string, unknown>): Promise<{ target: ResolvedTarget | null; reason: string | null }> {
  const explicitWorktreePath = typeof input.worktreePath === "string" && input.worktreePath.length > 0 ? input.worktreePath : null;
  const explicitBranch = typeof input.branch === "string" && input.branch.length > 0 ? input.branch : null;
  if (!explicitWorktreePath && !explicitBranch) return { target: null, reason: "current session is not recorded in guardian state" };

  if (explicitWorktreePath) {
    const resolved = path.resolve(repoRoot, explicitWorktreePath);
    return resolveListedWorktree(repoRoot, (worktree: any) => samePath(worktree.path, resolved), "worktreePath", "worktreePath is not checked out in git worktree list", "worktreePath matches multiple git worktrees", explicitBranch);
  }

  return resolveListedWorktree(repoRoot, (worktree: any) => worktree.branch === explicitBranch, "branch", "branch is not checked out in git worktree list", "branch matches multiple git worktrees");
}

function validateResolvedTarget(repoRoot: string, config: Record<string, unknown>, target: ResolvedTarget) {
  if (samePath(target.worktreePath, repoRoot)) return "target worktree is the primary repository worktree";
  if (!target.branch) return "target worktree is detached";
  const protectedBranches = Array.isArray(config.protectedBranches) ? config.protectedBranches : [];
  if (protectedBranches.includes(target.branch)) return "target branch is protected";
  if (target.targetSource !== "state") {
    const configuredRoot = typeof config.worktreeRoot === "string" ? config.worktreeRoot : ".worktrees/$REPO";
    const worktreeRoot = path.resolve(repoRoot, expandWorktreeRoot(configuredRoot, repoRoot));
    if (!sameOrInside(target.worktreePath, worktreeRoot)) return "explicit target is outside Guardian worktree root";
  }
  return null;
}

async function preflightFor(input: Record<string, unknown>) {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const { config } = input.config && typeof input.config === "object" ? { config: input.config as Record<string, unknown> } : await loadConfig(repoRoot);
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : null;
  const preflight: Record<string, unknown> = {
    repoRoot: path.resolve(repoRoot),
    mode: input.mode,
    action: typeof input.action === "string" ? input.action : "commit-review-artifacts",
    sessionId,
    sessionRecorded: false,
    targetSource: null,
    worktreePath: null,
    branch: null,
    head: null,
    entries: [],
    reviewArtifactPaths: [],
    otherDirtyPaths: [],
    blockers: [],
  };
  if (!sessionId) return { preflight, config, session: null, entries: [], reviewEntries: [], otherEntries: [], reason: "sessionId is required" };

  const state = input.state && typeof input.state === "object" ? input.state as { sessions?: Record<string, any> } : await readState(await getGuardianPaths(repoRoot), { repoRoot, config });
  const session = state.sessions?.[sessionId] ?? null;
  preflight.sessionRecorded = Boolean(session);
  let target: ResolvedTarget | null = null;
  if (session?.worktree_path) {
    const resolved = await resolveListedWorktree(
      repoRoot,
      (worktree: any) => samePath(worktree.path, session.worktree_path),
      "state",
      "recorded worktree is not checked out in git worktree list",
      "recorded worktree path matches multiple git worktrees",
      typeof session.branch === "string" ? session.branch : null,
    );
    target = resolved.target;
    if (resolved.reason) return { preflight, config, session, entries: [], reviewEntries: [], otherEntries: [], reason: resolved.reason };
  } else {
    const resolved = await resolveExplicitTarget(repoRoot, input);
    target = resolved.target;
    if (resolved.reason) return { preflight, config, session, entries: [], reviewEntries: [], otherEntries: [], reason: resolved.reason };
  }
  if (!target) return { preflight, config, session, entries: [], reviewEntries: [], otherEntries: [], reason: "current session is not recorded in guardian state" };
  const invalidTargetReason = validateResolvedTarget(repoRoot, config, target);
  if (invalidTargetReason) return { preflight, config, session, entries: [], reviewEntries: [], otherEntries: [], reason: invalidTargetReason };
  preflight.worktreePath = target.worktreePath;
  preflight.targetSource = target.targetSource;
  if (!await fs.access(target.worktreePath).then(() => true, () => false)) return { preflight, config, session, entries: [], reviewEntries: [], otherEntries: [], reason: "recorded worktree is missing" };

  const branch = await getCurrentBranch(target.worktreePath);
  const head = await getHeadCommit(target.worktreePath);
  const entries = await statusEntries(target.worktreePath);
  const reviewEntries = entries.filter((entry) => entry.classification === "review-artifact" && entry.index !== "D" && entry.worktree !== "D");
  const otherEntries = entries.filter((entry) => !reviewEntries.includes(entry));
  preflight.branch = branch;
  preflight.head = head;
  preflight.entries = entries;
  preflight.reviewArtifactPaths = reviewEntries.map((entry) => entry.path);
  preflight.otherDirtyPaths = otherEntries.map((entry) => entry.path);
  return { preflight, config, session, entries, reviewEntries, otherEntries, reason: null };
}

export async function guardianUnblockFinish(input: Record<string, unknown> = {}) {
  const mode = input.mode;
  const action = typeof input.action === "string" ? input.action : "commit-review-artifacts";
  const { preflight, config, session, entries, reviewEntries, otherEntries, reason } = await preflightFor({ ...input, action });
  if (mode !== "plan" && mode !== "apply") return blocked("mode must be plan or apply", { mode }, preflight);
  if (action !== "commit-review-artifacts") return blocked("unsupported unblock action", { action }, preflight);
  if (reason) return blocked(reason, {}, preflight);
  if (entries.length === 0) return blocked("worktree is already clean", {}, preflight);
  if (reviewEntries.length === 0) return blocked("no committable review artifacts found", {}, preflight);
  if (otherEntries.length > 0) return blocked("dirty files include non-review artifacts", { otherDirtyPaths: otherEntries.map((entry: StatusEntry) => entry.path) }, preflight);

  const confirmToken = createConfirmToken(preflight);
  if (mode === "plan") {
    return {
      ok: true,
      status: "planned",
      action,
      confirmToken,
      commitMessage: defaultCommitMessage(reviewEntries),
      preflight: { ...preflight, blockers: [...(preflight.blockers as string[])] },
      suggestedCommand: "guardian_unblock_finish mode=apply action=commit-review-artifacts confirmToken=<token>",
    };
  }

  if (input.confirmToken !== confirmToken) return blocked("confirm token does not match current unblock plan", {}, preflight);
  const worktreePath = String(preflight.worktreePath);
  const branch = String(preflight.branch);
  const head = String(preflight.head);
  const sessionId = String(preflight.sessionId);
  const safetyRef = await createSafetyRef(worktreePath, { sessionId, branch, commit: head, timestamp: input.timestamp });
  const paths = reviewEntries.map((entry: StatusEntry) => entry.path);
  await runGit(worktreePath, ["add", "--", ...paths]);
  const commitMessage = typeof input.commitMessage === "string" && input.commitMessage.trim() ? input.commitMessage.trim() : defaultCommitMessage(reviewEntries);
  await runGit(worktreePath, ["commit", "-m", commitMessage, "--", ...paths]);
  const newHead = await getHeadCommit(worktreePath);
  await recordSession(String(preflight.repoRoot), config, {
    ...(session ?? {}),
    session_id: sessionId,
    status: session?.status ?? "active",
    branch,
    worktree_path: worktreePath,
    base_ref: session?.base_ref ?? `${config.remote}/${config.baseBranch}`,
    head_commit: newHead,
    safety_refs: [...(session?.safety_refs ?? []), safetyRef],
  }, { event: { type: "guardian_unblock_finish", session_id: sessionId, ref: safetyRef, action, paths } });
  return {
    ok: true,
    status: "applied",
    action,
    committedPaths: paths,
    commit: newHead,
    commitMessage,
    safetyRef,
    preflight: { ...preflight, blockers: [...(preflight.blockers as string[])] },
  };
}
