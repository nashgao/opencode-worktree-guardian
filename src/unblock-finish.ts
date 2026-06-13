import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, normalizeConfig } from "./config.ts";
import { createSafetyRef, getCurrentBranch, getHeadCommit, getRepoRoot, runGit } from "./git.ts";
import { getGuardianPaths, readState, recordSession } from "./state.ts";
import type { GuardianSession, MutableRecord } from "./types.ts";
import { isRecordLike } from "./types.ts";
import { resolveCurrentUnblockTarget, resolveExplicitUnblockTarget, resolveStateUnblockTarget, validateUnblockTarget } from "./unblock-finish-target.ts";
import type { ResolvedUnblockTarget } from "./unblock-finish-target.ts";
import { recoverySessionId } from "./worktree-recovery.ts";

type LooseRecord = MutableRecord;

type StatusEntry = {
  index: string;
  worktree: string;
  path: string;
  sourcePath: string | null;
  hash: string | null;
  symlink: boolean;
  classification: "review-artifact" | "other";
};

type UnblockStateInput = {
  readonly sessions?: Record<string, GuardianSession>;
};
export type GuardianUnblockFinishResult = MutableRecord & {
  readonly action?: string;
  readonly committedPaths?: readonly string[];
  readonly confirmToken?: string;
  readonly otherDirtyPaths?: readonly string[];
  readonly preflight: MutableRecord & {
    readonly branch?: string | null;
    readonly otherDirtyPaths?: readonly string[];
    readonly reviewArtifactPaths?: readonly string[];
    readonly sessionRecorded?: boolean;
    readonly targetSource?: string | null;
    readonly worktreePath?: string | null;
  };
  readonly reason?: string;
  readonly safetyRef?: string;
};

const REVIEW_ARTIFACT_PATTERN = /^\.milestones\/reviews\/[^/]*impl-rating-\d{8}\.(md|txt)$/;

function sha256(value: string | Buffer) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function blocked(reason: string, details: LooseRecord, preflight: LooseRecord) {
  const previousBlockers = Array.isArray(preflight.blockers) ? preflight.blockers.filter((blocker): blocker is string => typeof blocker === "string") : [];
  const blockers = [...previousBlockers, reason];
  preflight.blockers = blockers;
  return { ok: false, status: "blocked", reason, ...details, preflight: { ...preflight, blockers } };
}

function relativeGitPath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
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

function createConfirmToken(preflight: LooseRecord) {
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

function preflightBlockers(preflight: LooseRecord): string[] {
  return Array.isArray(preflight.blockers) ? preflight.blockers.filter((blocker): blocker is string => typeof blocker === "string") : [];
}

function isUnblockStateInput(value: unknown): value is UnblockStateInput {
  return isRecordLike(value) && (value.sessions === undefined || isRecordLike(value.sessions));
}

async function preflightFor(input: LooseRecord) {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.repoRoot === "string" ? input.repoRoot : process.cwd();
  const repoRoot = typeof input.repoRoot === "string" ? input.repoRoot : await getRepoRoot(cwd);
  const { config } = isRecordLike(input.config) ? { config: normalizeConfig(input.config) } : await loadConfig(repoRoot);
  let sessionId = typeof input.sessionId === "string" ? input.sessionId : null;
  const preflight: LooseRecord = {
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
  const state = isUnblockStateInput(input.state) ? input.state : await readState(await getGuardianPaths(repoRoot), { repoRoot, config });
  const session = sessionId ? state.sessions?.[sessionId] ?? null : null;
  preflight.sessionRecorded = Boolean(session);
  let target: ResolvedUnblockTarget | null = null;
  if (session?.worktree_path) {
    const resolved = await resolveStateUnblockTarget(repoRoot, session.worktree_path, typeof session.branch === "string" ? session.branch : null);
    target = resolved.target;
    if (resolved.reason) return { preflight, config, session, entries: [], reviewEntries: [], otherEntries: [], reason: resolved.reason };
  } else {
    const resolved = await resolveExplicitUnblockTarget(repoRoot, input);
    const hasExplicitTarget = typeof input.worktreePath === "string" && input.worktreePath.length > 0 || typeof input.branch === "string" && input.branch.length > 0;
    const fallback = resolved.target || hasExplicitTarget ? resolved : await resolveCurrentUnblockTarget(repoRoot, cwd);
    target = fallback.target;
    if (fallback.reason) return { preflight, config, session, entries: [], reviewEntries: [], otherEntries: [], reason: fallback.reason };
  }
  if (!target) return { preflight, config, session, entries: [], reviewEntries: [], otherEntries: [], reason: "current session is not recorded in guardian state" };
  const invalidTargetReason = validateUnblockTarget(repoRoot, config, target);
  if (invalidTargetReason) return { preflight, config, session, entries: [], reviewEntries: [], otherEntries: [], reason: invalidTargetReason };
  preflight.worktreePath = target.worktreePath;
  preflight.targetSource = target.targetSource;
  if (!await fs.access(target.worktreePath).then(() => true, () => false)) return { preflight, config, session, entries: [], reviewEntries: [], otherEntries: [], reason: "recorded worktree is missing" };

  const branch = await getCurrentBranch(target.worktreePath);
  if (!branch) return { preflight, config, session, entries: [], reviewEntries: [], otherEntries: [], reason: "target worktree is detached" };
  const head = await getHeadCommit(target.worktreePath);
  sessionId = sessionId ?? recoverySessionId(branch, head);
  preflight.sessionId = sessionId;
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

export async function guardianUnblockFinish(input: LooseRecord = {}): Promise<GuardianUnblockFinishResult> {
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
      preflight: { ...preflight, blockers: preflightBlockers(preflight) },
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
    preflight: { ...preflight, blockers: preflightBlockers(preflight) },
  };
}
