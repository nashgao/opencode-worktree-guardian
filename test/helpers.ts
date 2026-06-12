import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

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

export async function makeBranchCommit(repo: string, branch = "guardian/test") {
  await git(repo, ["checkout", "-b", branch]);
  const file = path.join(repo, "feature.txt");
  await fs.writeFile(file, `${branch}\n`);
  await git(repo, ["add", "feature.txt"]);
  await git(repo, ["commit", "-m", `add ${branch}`]);
  const { stdout } = await git(repo, ["rev-parse", "HEAD"]);
  return { branch, commit: stdout };
}
