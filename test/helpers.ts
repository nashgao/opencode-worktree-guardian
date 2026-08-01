import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { getGuardianPaths, readState, writeStateAtomic } from "../src/state.ts";
import { guardianStart } from "../src/start.ts";
import { isRecordLike } from "../src/types.ts";

export { installFakeGh } from "./delete-fixtures.ts";

const execFileAsync = promisify(execFile);
const safeTempDirectoryName = "opencode-worktree-guardian-tests";
const fallbackTempBases = [
  path.join("/tmp", "opencode"),
  path.join(os.homedir(), ".cache", "opencode", "tmp"),
];

function isSameOrInside(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function safeExternalTempParent() {
  const projectRoot = await fs.realpath(process.cwd());
  const candidates = [os.tmpdir(), ...fallbackTempBases];
  for (const candidate of candidates) {
    try {
      const candidatePath = path.resolve(candidate);
      await fs.mkdir(candidatePath, { recursive: true });
      const realCandidate = await fs.realpath(candidatePath);
      if (isSameOrInside(realCandidate, projectRoot)) continue;
      const parent = path.join(realCandidate, safeTempDirectoryName);
      await fs.mkdir(parent, { recursive: true });
      return fs.realpath(parent);
    } catch {}
  }
  throw new Error("Unable to resolve an external temp directory for Guardian tests");
}

export async function git(cwd: string, args: string[]) {
  const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: 10 * 1024 * 1024 });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function createTempDir(prefix = "guardian-") {
  const parent = await safeExternalTempParent();
  return fs.realpath(await fs.mkdtemp(path.join(parent, prefix)));
}

export async function createRepo() {
  const repo = await createTempDir();
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await git(repo, ["config", "user.email", "guardian@example.test"]);
  await git(repo, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(repo, "README.md"), "initial\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

export async function createRepoWithOrigin() {
  const base = await createTempDir("guardian-origin-");
  const remote = path.join(base, "remote.git");
  const repo = path.join(base, "repo");
  await execFileAsync("git", ["init", "--bare", remote]);
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await git(repo, ["config", "user.email", "guardian@example.test"]);
  await git(repo, ["config", "user.name", "Guardian Test"]);
  await git(repo, ["remote", "add", "origin", remote]);
  await fs.writeFile(path.join(repo, "README.md"), "initial\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["push", "-u", "origin", "main"]);
  return { base, repo, remote };
}

export type AlreadyLandedDirtyFixture = {
  readonly base: string;
  readonly branch: string;
  readonly featureFile: string;
  readonly remote: string;
  readonly repo: string;
  readonly sessionId: string;
  readonly worktree: string;
};

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (isRecordLike(value)) return value;
  throw new TypeError(`${name} must be an object`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(`${name} must be a non-empty string`);
}

export async function makeAlreadyLandedDirtySession(sessionId: string): Promise<AlreadyLandedDirtyFixture> {
  const { base, remote, repo } = await createRepoWithOrigin();
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "done redundant dirty token", createWorktree: true, config: DEFAULT_CONFIG });
  const session = requireRecord(started.session, "started.session");
  const branch = requireString(session.branch, "started.session.branch");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const featureFile = "redundant-dirty-token.txt";
  await fs.writeFile(path.join(worktree, featureFile), "landed content\n", "utf8");
  await git(worktree, ["add", featureFile]);
  await git(worktree, ["commit", "-m", "add redundant dirty token fixture"]);
  await git(repo, ["merge", "--no-ff", branch, "-m", "merge redundant dirty token fixture"]);
  await git(repo, ["push", "origin", "main"]);
  await fs.writeFile(path.join(repo, featureFile), "advanced base content\n", "utf8");
  await git(repo, ["add", featureFile]);
  await git(repo, ["commit", "-m", "advance redundant dirty token base"]);
  await git(repo, ["push", "origin", "main"]);
  await fs.writeFile(path.join(worktree, featureFile), "advanced base content\n", "utf8");
  return { base, branch, featureFile, remote, repo, sessionId, worktree };
}

export async function makeBranchCommit(repo: string, branch = "guardian/test") {
  await git(repo, ["checkout", "-b", branch]);
  const file = path.join(repo, "feature.txt");
  await fs.writeFile(file, `${branch}\n`);
  await git(repo, ["add", "feature.txt"]);
  await git(repo, ["commit", "-m", `add ${branch}`]);
  const { stdout } = await git(repo, ["rev-parse", "HEAD"]);
  return { branch, commit: stdout };
}

export async function seedSession(repo: string, session: Record<string, unknown>, config: Record<string, unknown> = DEFAULT_CONFIG): Promise<void> {
  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config });
  const sessionId = String(session.session_id);
  const previous = state.sessions[sessionId];
  const previousVersion = typeof previous?.state_version === "number" ? previous.state_version : 0;
  const now = new Date().toISOString();
  state.sessions[sessionId] = {
    ...previous,
    ...session,
    state_version: previousVersion + 1,
    created_at: previous?.created_at ?? now,
    updated_at: typeof session.updated_at === "string" ? session.updated_at : now,
  };
  await writeStateAtomic(paths, state);
}

type FilesystemEntry = {
  readonly path: string;
  readonly kind: "directory" | "file" | "missing" | "other" | "symlink";
  readonly value: string | null;
};

export type RescueMutationSurface = {
  readonly branch: string;
  readonly fetchHead: FilesystemEntry;
  readonly files: readonly FilesystemEntry[];
  readonly head: string;
  readonly index: FilesystemEntry;
  readonly indexLock: FilesystemEntry;
  readonly objects: readonly FilesystemEntry[];
  readonly reflogs: readonly FilesystemEntry[];
  readonly refs: readonly FilesystemEntry[];
  readonly state: readonly FilesystemEntry[];
  readonly status: string;
  readonly unreachable: string;
  readonly worktrees: string;
};

async function fileEntry(root: string, absolutePath: string): Promise<FilesystemEntry> {
  const relative = path.relative(root, absolutePath) || ".";
  try {
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) return { path: relative, kind: "symlink", value: await fs.readlink(absolutePath) };
    if (stat.isDirectory()) return { path: relative, kind: "directory", value: null };
    if (stat.isFile()) return { path: relative, kind: "file", value: crypto.createHash("sha256").update(await fs.readFile(absolutePath)).digest("hex") };
    return { path: relative, kind: "other", value: String(stat.mode) };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return { path: relative, kind: "missing", value: null };
    throw error;
  }
}

async function directoryEntries(root: string, excludedChild = ""): Promise<readonly FilesystemEntry[]> {
  const first = await fileEntry(root, root);
  if (first.kind === "missing") return [first];
  const entries: FilesystemEntry[] = [first];
  async function visit(current: string): Promise<void> {
    const stat = await fs.lstat(current);
    if (!stat.isDirectory()) return;
    const children = await fs.readdir(current);
    for (const child of children.sort((left, right) => left.localeCompare(right))) {
      if (current === root && child === excludedChild) continue;
      const childPath = path.join(current, child);
      try {
        entries.push(await fileEntry(root, childPath));
        await visit(childPath);
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }
  await visit(root);
  return entries;
}

export async function rescueMutationSurface(commonRepo: string, observedWorktree = commonRepo): Promise<RescueMutationSurface> {
  const common = (await git(commonRepo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout;
  const index = (await git(observedWorktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout;
  const branch = await git(observedWorktree, ["branch", "--show-current"]);
  const head = await git(observedWorktree, ["rev-parse", "HEAD"]);
  const status = await git(observedWorktree, ["status", "--porcelain=v1", "--ignored", "--untracked-files=all", "-z"]);
  const worktrees = await git(commonRepo, ["worktree", "list", "--porcelain"]);
  const unreachable = await git(commonRepo, ["fsck", "--no-reflogs", "--unreachable", "--no-progress"]);
  const files = await directoryEntries(observedWorktree, ".git");
  const objects = await directoryEntries(path.join(common, "objects"));
  const reflogs = await directoryEntries(path.join(common, "logs"));
  const refs = await directoryEntries(path.join(common, "refs"));
  const state = await directoryEntries(path.join(common, "opencode-guardian"));
  const fetchHead = await fileEntry(common, path.join(common, "FETCH_HEAD"));
  const indexEntry = await fileEntry(common, index);
  const indexLock = await fileEntry(common, `${index}.lock`);
  return {
    branch: branch.stdout,
    fetchHead,
    files,
    head: head.stdout,
    index: indexEntry,
    indexLock,
    objects,
    reflogs,
    refs,
    state,
    status: status.stdout,
    unreachable: unreachable.stdout,
    worktrees: worktrees.stdout,
  };
}
