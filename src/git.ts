import { runGit, tryGit } from "./git-process.ts";

export { getDirtyFiles, getIgnoredFiles, getStatusPorcelain, listStashes, listWorktrees, promoteGitArtifactSandboxTree, readEffectiveGitConfig, runGit, runGitNullSeparated, runGitReadOnly, runGitWithInput, snapshotWorktreeDirtCommit, tryGit, tryGitReadOnly, withGitArtifactSandbox, withGitArtifactSandboxFromIndex, runGitInArtifactSandbox, runGitNullSeparatedInArtifactSandbox } from "./git-process.ts";
export type { GitArtifactSandbox, GitReadTarget, GitStashEntry, SnapshotWorktreeDirtOptions, TryGitResult } from "./git-process.ts";

export type GitRefEntry = { readonly name: string; readonly commit: string; readonly date: string; readonly subject: string };
export type GitBranchEntry = { readonly name: string; readonly commit: string };
export type GitRemoteBranchEntry = { readonly remote: string; readonly branch: string; readonly ref: string; readonly commit: string };
export type GitCommitEntry = { readonly commit: string; readonly subject: string };
export type GitRecoveryCandidates = { readonly reflog: readonly (GitCommitEntry & { readonly selector: string })[]; readonly unreachable: readonly string[] };
type CreateSafetyRefOptions = { readonly sessionId?: unknown; readonly branch?: unknown; readonly commit?: string; readonly timestamp?: unknown; readonly ref?: string };

const refDisallowedCharacters = /[\u0000-\u0020\u007f~^:?*\[\\]/;

class InvalidGitCommandInputError extends Error {
  constructor(kind: "remote" | "ref") {
    super(`Invalid Git ${kind}`);
    this.name = "InvalidGitCommandInputError";
  }
}

function isValidGitRef(value: string): boolean {
  if (value === "HEAD" || /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value)) return true;
  if (value.length === 0 || value === "@" || value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".") || value.includes("..") || value.includes("@{") || refDisallowedCharacters.test(value)) return false;
  return value.split("/").every((component) => component.length > 0 && !component.startsWith(".") && !component.endsWith(".lock"));
}

function remoteNameFromConfigKey(key: string): string | null {
  if (!key.startsWith("remote.")) return null;
  const finalSeparator = key.lastIndexOf(".");
  const variable = key.slice(finalSeparator + 1);
  if (finalSeparator <= "remote.".length || (variable !== "url" && variable !== "pushurl")) return null;
  return key.slice("remote.".length, finalSeparator);
}

async function configuredRemoteNames(repoRoot: string): Promise<ReadonlySet<string>> {
  const result = await tryGit(repoRoot, ["config", "--includes", "--null", "--name-only", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"]);
  if (!result.ok) {
    if (result.error.gitExitCode === 1 && !result.stderr) return new Set();
    throw result.error;
  }
  return new Set(result.stdout.split("\0").flatMap((key) => {
    const remote = remoteNameFromConfigKey(key);
    return remote ? [remote] : [];
  }));
}

export async function validateConfiguredRemote(repoRoot: string, remote: string): Promise<void> {
  if (!isValidGitRef(remote)) throw new InvalidGitCommandInputError("remote");
  if (!(await configuredRemoteNames(repoRoot)).has(remote)) throw new InvalidGitCommandInputError("remote");
}

export function validateGitRef(ref: string): void {
  if (!isValidGitRef(ref)) throw new InvalidGitCommandInputError("ref");
}

export function remoteTrackingRef(remote: string, branch: string): string {
  validateGitRef(remote);
  validateGitRef(branch);
  return `refs/remotes/${remote}/${branch}`;
}

export async function getRepoRoot(cwd: string) {
  return (await runGit(cwd, ["rev-parse", "--show-toplevel"])).stdout;
}

export async function getCommonGitDir(repoRoot: string) {
  return (await runGit(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout;
}

export async function getCurrentBranch(repoRoot: string) {
  const result = await tryGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return result.ok ? result.stdout : null;
}

export async function getSymbolicRefTarget(repoRoot: string, ref: string): Promise<string | null> {
  validateGitRef(ref);
  const result = await tryGit(repoRoot, ["symbolic-ref", "--quiet", "--no-recurse", ref]);
  if (result.ok) return result.stdout;
  if (result.error.gitExitCode === 1 && !result.error.gitSignal) return null;
  throw result.error;
}

export async function getBranchUpstream(repoRoot: string, branch: string) {
  validateGitRef(branch);
  const result = await tryGit(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`]);
  return result.ok && result.stdout ? result.stdout : null;
}

export async function getHeadCommit(repoRoot: string) {
  return (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
}

export async function getBranchCommit(repoRoot: string, branch: string) {
  validateGitRef(branch);
  return (await runGit(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`])).stdout;
}

export async function getRefCommit(repoRoot: string, ref: string) {
  validateGitRef(ref);
  return (await runGit(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout;
}

export async function getRefCommitOrNull(repoRoot: string, ref: string): Promise<string | null> {
  validateGitRef(ref);
  const exists = await tryGit(repoRoot, ["show-ref", "--verify", "--quiet", ref]);
  if (!exists.ok) {
    if (exists.error.gitExitCode === 1 && !exists.error.gitSignal) return null;
    throw exists.error;
  }
  return getRefCommit(repoRoot, ref);
}

export async function getDirectRefCommitOrNull(repoRoot: string, ref: string): Promise<string | null> {
  validateGitRef(ref);
  if (await getSymbolicRefTarget(repoRoot, ref) !== null) return null;
  const direct = await tryGit(repoRoot, ["rev-parse", "--verify", ref]);
  if (!direct.ok) {
    if (direct.error.gitExitCode === 1 && !direct.error.gitSignal) return null;
    throw direct.error;
  }
  const type = await tryGit(repoRoot, ["cat-file", "-t", direct.stdout]);
  return type.ok && type.stdout === "commit" ? direct.stdout : null;
}

function safeRefSegment(value: unknown) {
  const segment = String(value ?? "")
    .replace(/^refs\//, "")
    .replace(/\.\.+/g, ".")
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
  return segment.length > 0 ? segment : "unknown";
}

function defaultRefTimestamp() {
  return new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
}

function safeRefTimestamp(timestamp: unknown) {
  if (timestamp instanceof Date) return defaultRefTimestampFromDate(timestamp);
  const stamp = safeRefSegment(timestamp);
  return stamp === "unknown" ? defaultRefTimestamp() : stamp;
}

function defaultRefTimestampFromDate(timestamp: Date) {
  return timestamp.toISOString().replace(/[-:.]/g, "").slice(0, 15);
}

export function buildSafetyRef(sessionId: string, branch: string, timestamp: unknown = new Date()) {
  const stamp = safeRefTimestamp(timestamp);
  return `refs/opencode-guardian/${safeRefSegment(sessionId)}/${safeRefSegment(branch)}/${stamp}`;
}

export function buildPreservedRef(sessionId: string, branch: string, timestamp: unknown = new Date()) {
  const stamp = safeRefTimestamp(timestamp);
  return `refs/opencode-guardian/preserved/${safeRefSegment(sessionId)}/${safeRefSegment(branch)}/${stamp}`;
}

async function nullObjectId(repoRoot: string): Promise<string> {
  const objectFormat = (await runGit(repoRoot, ["rev-parse", "--show-object-format"])).stdout;
  switch (objectFormat) {
    case "sha1": return "0".repeat(40);
    case "sha256": return "0".repeat(64);
    default: throw new Error(`Unsupported Git object format: ${objectFormat}`);
  }
}

export async function createRef(repoRoot: string, refName: string, commit = "HEAD") {
  validateGitRef(refName);
  validateGitRef(commit);
  await runGit(repoRoot, ["update-ref", "--no-deref", refName, commit, await nullObjectId(repoRoot)]);
  return refName;
}

export async function createSafetyRef(repoRoot: string, { sessionId, branch, commit = "HEAD", timestamp, ref: explicitRef }: CreateSafetyRefOptions = {}) {
  const ref = explicitRef ?? buildSafetyRef(String(sessionId ?? ""), String(branch ?? ""), timestamp);
  validateGitRef(ref);
  validateGitRef(commit);
  await runGit(repoRoot, ["update-ref", "--no-deref", ref, commit, await nullObjectId(repoRoot)]);
  return ref;
}

export async function createOrReuseSafetyRef(repoRoot: string, options: CreateSafetyRefOptions = {}) {
  const commit = await getRefCommit(repoRoot, options.commit ?? "HEAD");
  const ref = options.ref ?? buildSafetyRef(String(options.sessionId ?? ""), String(options.branch ?? ""), options.timestamp);
  validateGitRef(ref);
  try {
    return await createSafetyRef(repoRoot, { ...options, commit, ref });
  } catch (error) {
    const symbolicTarget = await getSymbolicRefTarget(repoRoot, ref);
    const existing = await tryGit(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
    if (symbolicTarget === null && existing.ok && existing.stdout === commit) return ref;
    throw error;
  }
}

export async function listRefs(repoRoot: string, prefix: string): Promise<GitRefEntry[]> {
  validateGitRef(prefix);
  const result = await tryGit(repoRoot, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(committerdate:iso8601)%00%(subject)", prefix]);
  if (!result.ok || !result.stdout) return [];
  return result.stdout.split("\n").map((line: string) => {
    const [name, commit, date, subject] = line.split("\0");
    return { name, commit, date, subject };
  });
}

export async function isAncestor(repoRoot: string, commit: string, ref: string) {
  validateGitRef(commit);
  validateGitRef(ref);
  const result = await tryGit(repoRoot, ["merge-base", "--is-ancestor", commit, ref]);
  return result.ok;
}

export async function listUnmergedCommits(repoRoot: string, head: string, baseAuthorityRef: string): Promise<GitCommitEntry[]> {
  validateGitRef(head);
  validateGitRef(baseAuthorityRef);
  const result = await runGit(repoRoot, ["log", "--format=%H%x00%s", `${baseAuthorityRef}..${head}`]);
  if (!result.stdout) return [];
  return result.stdout.split("\n").map((line: string) => {
    const [commit, subject] = line.split("\0");
    return { commit, subject };
  });
}

export async function pushBranchWithLease(repoRoot: string, remote: string, branch: string, approvedOid: string, expectedRemoteOid: string | null) {
  await validateConfiguredRemote(repoRoot, remote);
  validateGitRef(branch);
  validateGitRef(approvedOid);
  if (expectedRemoteOid) validateGitRef(expectedRemoteOid);
  const ref = `refs/heads/${branch}`;
  await runGit(repoRoot, ["push", remote, `--force-with-lease=${ref}:${expectedRemoteOid ?? ""}`, `${approvedOid}:${ref}`]);
}

export async function pushBranchNormally(repoRoot: string, remote: string, branch: string, approvedOid: string) {
  await validateConfiguredRemote(repoRoot, remote);
  validateGitRef(branch);
  validateGitRef(approvedOid);
  const ref = `refs/heads/${branch}`;
  await runGit(repoRoot, ["push", remote, `${approvedOid}:${ref}`]);
  await runGit(repoRoot, ["branch", "--set-upstream-to", remoteTrackingRef(remote, branch), branch]);
}

export async function fetchRemote(repoRoot: string, remote: string) {
  await validateConfiguredRemote(repoRoot, remote);
  await runGit(repoRoot, ["fetch", "--no-prune", remote]);
}

export async function fetchRemotePrune(repoRoot: string, remote: string) {
  await validateConfiguredRemote(repoRoot, remote);
  await runGit(repoRoot, ["fetch", "--prune", remote]);
}

export async function removeWorktree(repoRoot: string, worktreePath: string) {
  await runGit(repoRoot, ["worktree", "remove", worktreePath]);
}

export async function deleteBranch(repoRoot: string, branch: string) {
  validateGitRef(branch);
  await runGit(repoRoot, ["branch", "-d", "--", branch]);
}

export async function deleteBranchAtHead(repoRoot: string, branch: string, expectedHead: string) {
  validateGitRef(branch);
  validateGitRef(expectedHead);
  const ref = `refs/heads/${branch}`;
  await runGit(repoRoot, ["update-ref", "--no-deref", "-d", ref, expectedHead]);
}

export async function deleteRemoteBranch(repoRoot: string, remote: string, branch: string, expectedHead: string) {
  await validateConfiguredRemote(repoRoot, remote);
  validateGitRef(branch);
  validateGitRef(expectedHead);
  const ref = `refs/heads/${branch}`;
  await runGit(repoRoot, ["push", remote, `--force-with-lease=${ref}:${expectedHead}`, `:${ref}`]);
  await fetchRemotePrune(repoRoot, remote);
}

export async function deleteAbsentRemoteBranchAtExpectedAbsence(repoRoot: string, remote: string, branch: string) {
  await validateConfiguredRemote(repoRoot, remote);
  validateGitRef(branch);
  const ref = `refs/heads/${branch}`;
  await runGit(repoRoot, ["push", remote, `--force-with-lease=${ref}:`, `:${ref}`]);
  await fetchRemotePrune(repoRoot, remote);
}

export async function listRemoteBranches(repoRoot: string, remote: string): Promise<GitRemoteBranchEntry[]> {
  await validateConfiguredRemote(repoRoot, remote);
  const result = await tryGit(repoRoot, ["for-each-ref", "--format=%(refname:short)%00%(objectname)", `refs/remotes/${remote}`]);
  if (!result.ok || !result.stdout) return [];
  return result.stdout.split("\n").flatMap((line: string) => {
    const [ref, commit] = line.split("\0");
    if (!ref || !commit || ref === remote || ref === `${remote}/HEAD`) return [];
    const prefix = `${remote}/`;
    if (!ref.startsWith(prefix)) return [];
    return [{ remote, branch: ref.slice(prefix.length), ref, commit }];
  });
}

export async function listBranches(repoRoot: string): Promise<GitBranchEntry[]> {
  const result = await tryGit(repoRoot, ["for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads"]);
  if (!result.ok || !result.stdout) return [];
  return result.stdout.split("\n").map((line: string) => {
    const [name, commit] = line.split("\0");
    return { name, commit };
  });
}

export async function listRecoveryCandidates(repoRoot: string): Promise<GitRecoveryCandidates> {
  const reflog = await tryGit(repoRoot, ["reflog", "--format=%H%x00%gd%x00%gs", "-n", "25"]);
  const unreachable = await tryGit(repoRoot, ["fsck", "--no-reflogs", "--unreachable"]);
  return {
    reflog: reflog.ok && reflog.stdout ? reflog.stdout.split("\n").map((line: string) => {
      const [commit, selector, subject] = line.split("\0");
      return { commit, selector, subject };
    }) : [],
    unreachable: unreachable.stdout ? unreachable.stdout.split("\n").filter(Boolean) : [],
  };
}
