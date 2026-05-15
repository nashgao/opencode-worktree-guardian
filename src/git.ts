import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runGit(repoPath: string, args: string[], options: Record<string, any> = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", repoPath, ...args], {
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error: any) {
    error.gitArgs = args;
    error.gitStdout = error.stdout?.trim?.() ?? "";
    error.gitStderr = error.stderr?.trim?.() ?? "";
    throw error;
  }
}

export async function tryGit(repoPath: string, args: string[]) {
  try {
    return { ok: true, ...(await runGit(repoPath, args)) };
  } catch (error) {
    return { ok: false, error, stdout: error.gitStdout ?? "", stderr: error.gitStderr ?? "" };
  }
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

export async function getHeadCommit(repoRoot: string) {
  return (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
}

export async function getStatusPorcelain(repoRoot: string) {
  return (await runGit(repoRoot, ["status", "--porcelain"])).stdout;
}

export async function getDirtyFiles(repoRoot: string) {
  const status = await getStatusPorcelain(repoRoot);
  if (!status) return [];
  return status.split("\n").map((line) => line.slice(3)).filter(Boolean);
}

export async function listStashes(repoRoot: string) {
  const result = await tryGit(repoRoot, ["stash", "list", "--format=%gd%x00%H%x00%gs"]);
  if (!result.ok || !result.stdout) return [];
  return result.stdout.split("\n").map((line: string) => {
    const [name, commit, message] = line.split("\0");
    return { name, commit, message };
  });
}

export async function listWorktrees(repoRoot: string) {
  const { stdout } = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!stdout) return [];
  const entries = [];
  let current = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (current && line === "detached") {
      current.detached = true;
    } else if (current && line === "bare") {
      current.bare = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

function safeRefSegment(value: unknown) {
  return String(value)
    .replace(/^refs\//, "")
    .replace(/\.\.+/g, ".")
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
}

export function buildSafetyRef(sessionId: string, branch: string, timestamp: Date | string = new Date()) {
  const stamp = timestamp instanceof Date ? timestamp.toISOString().replace(/[-:.]/g, "").slice(0, 15) : String(timestamp);
  return `refs/opencode-guardian/${safeRefSegment(sessionId)}/${safeRefSegment(branch)}/${stamp}`;
}

export function buildPreservedRef(sessionId: string, branch: string, timestamp: Date | string = new Date()) {
  const stamp = timestamp instanceof Date ? timestamp.toISOString().replace(/[-:.]/g, "").slice(0, 15) : String(timestamp);
  return `refs/opencode-guardian/preserved/${safeRefSegment(sessionId)}/${safeRefSegment(branch)}/${stamp}`;
}

export async function createRef(repoRoot: string, refName: string, commit = "HEAD") {
  await runGit(repoRoot, ["update-ref", refName, commit]);
  return refName;
}

export async function createSafetyRef(repoRoot: string, { sessionId, branch, commit = "HEAD", timestamp }: Record<string, any> = {}) {
  const ref = buildSafetyRef(sessionId, branch, timestamp);
  await createRef(repoRoot, ref, commit);
  return ref;
}

export async function listRefs(repoRoot: string, prefix: string) {
  const result = await tryGit(repoRoot, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(committerdate:iso8601)%00%(subject)", prefix]);
  if (!result.ok || !result.stdout) return [];
  return result.stdout.split("\n").map((line: string) => {
    const [name, commit, date, subject] = line.split("\0");
    return { name, commit, date, subject };
  });
}

export async function isAncestor(repoRoot: string, commit: string, ref: string) {
  const result = await tryGit(repoRoot, ["merge-base", "--is-ancestor", commit, ref]);
  return result.ok;
}

export async function pushBranch(repoRoot: string, remote: string, branch: string) {
  await runGit(repoRoot, ["push", "-u", remote, branch]);
}

export async function fetchRemote(repoRoot: string, remote: string) {
  await runGit(repoRoot, ["fetch", remote]);
}

export async function listBranches(repoRoot: string) {
  const result = await tryGit(repoRoot, ["for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads"]);
  if (!result.ok || !result.stdout) return [];
  return result.stdout.split("\n").map((line: string) => {
    const [name, commit] = line.split("\0");
    return { name, commit };
  });
}

export async function listRecoveryCandidates(repoRoot: string) {
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
