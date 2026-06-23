import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { getGuardianPaths, readState, writeStateAtomic } from "../src/state.ts";

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

type TestLifecycle = {
  readonly after: (callback: () => void) => void;
};

type FakeGhOptions = {
  readonly repo: string;
  readonly branch: string;
  readonly head?: string;
  readonly dynamicHead?: boolean;
  readonly existingPr?: boolean;
  readonly mergeFails?: boolean;
  readonly expectAdmin?: boolean;
};

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

export async function installFakeGh(t: TestLifecycle, options: FakeGhOptions) {
  const binDir = await createTempDir("guardian-fake-gh-");
  const stateDir = await createTempDir("guardian-fake-gh-state-");
  const ghPath = path.join(binDir, "gh");
  const logPath = path.join(stateDir, "gh.log");
  const createdPath = path.join(stateDir, "pr-created");
  const url = "https://github.example/acme/widget/pull/1";
  const script = `#!/bin/sh
set -eu
pr_head() {
  if [ "\${GUARDIAN_TEST_DYNAMIC_HEAD:-0}" = "1" ]; then
    git -C "$GUARDIAN_TEST_REPO" rev-parse "$GUARDIAN_TEST_BRANCH"
  else
    printf '%s\\n' "$GUARDIAN_TEST_HEAD"
  fi
}
pr_list_json() {
  printf '[{"number":1,"url":"%s","headRefName":"%s","headRefOid":"%s"}]\\n' "$GUARDIAN_TEST_PR_URL" "$GUARDIAN_TEST_BRANCH" "$(pr_head)"
}
pr_view_json() {
  printf '{"number":1,"url":"%s","headRefName":"%s","headRefOid":"%s"}\\n' "$GUARDIAN_TEST_PR_URL" "$GUARDIAN_TEST_BRANCH" "$(pr_head)"
}
printf '%s\\n' "$*" >> "$GUARDIAN_TEST_GH_LOG"
if [ "$1" = "pr" ] && [ "\${2:-}" = "list" ]; then
  if [ -f "$GUARDIAN_TEST_PR_CREATED" ]; then
    pr_list_json
  else
    printf '[]\\n'
  fi
elif [ "$1" = "pr" ] && [ "\${2:-}" = "create" ]; then
  : > "$GUARDIAN_TEST_PR_CREATED"
  printf '%s\\n' "$GUARDIAN_TEST_PR_URL"
elif [ "$1" = "pr" ] && [ "\${2:-}" = "view" ]; then
  pr_view_json
elif [ "$1" = "pr" ] && [ "\${2:-}" = "merge" ]; then
  has_admin=0
  for arg in "$@"; do
    if [ "$arg" = "--admin" ]; then has_admin=1; fi
  done
  if [ "\${GUARDIAN_TEST_EXPECT_ADMIN:-0}" = "1" ] && [ "$has_admin" != "1" ]; then
    echo "admin bypass was expected" >&2
    exit 8
  fi
  if [ "\${GUARDIAN_TEST_EXPECT_ADMIN:-0}" != "1" ] && [ "$has_admin" = "1" ]; then
    echo "admin bypass was not expected" >&2
    exit 9
  fi
  if [ "\${GUARDIAN_TEST_MERGE_FAILS:-0}" = "1" ]; then
    echo "review required" >&2
    exit 4
  fi
  git -C "$GUARDIAN_TEST_REPO" checkout main >/dev/null
  git -C "$GUARDIAN_TEST_REPO" merge --ff-only "$GUARDIAN_TEST_BRANCH" >/dev/null
  git -C "$GUARDIAN_TEST_REPO" push origin main >/dev/null
else
  echo "unexpected gh invocation: $*" >&2
  exit 2
fi
`;
  await fs.writeFile(ghPath, script, "utf8");
  await fs.chmod(ghPath, 0o755);
  if (options.existingPr === true) await fs.writeFile(createdPath, "", "utf8");

  const originalEnv = {
    PATH: process.env.PATH,
    GUARDIAN_TEST_REPO: process.env.GUARDIAN_TEST_REPO,
    GUARDIAN_TEST_BRANCH: process.env.GUARDIAN_TEST_BRANCH,
    GUARDIAN_TEST_HEAD: process.env.GUARDIAN_TEST_HEAD,
    GUARDIAN_TEST_DYNAMIC_HEAD: process.env.GUARDIAN_TEST_DYNAMIC_HEAD,
    GUARDIAN_TEST_GH_LOG: process.env.GUARDIAN_TEST_GH_LOG,
    GUARDIAN_TEST_PR_CREATED: process.env.GUARDIAN_TEST_PR_CREATED,
    GUARDIAN_TEST_PR_URL: process.env.GUARDIAN_TEST_PR_URL,
    GUARDIAN_TEST_MERGE_FAILS: process.env.GUARDIAN_TEST_MERGE_FAILS,
    GUARDIAN_TEST_EXPECT_ADMIN: process.env.GUARDIAN_TEST_EXPECT_ADMIN,
  };
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.GUARDIAN_TEST_REPO = options.repo;
  process.env.GUARDIAN_TEST_BRANCH = options.branch;
  process.env.GUARDIAN_TEST_HEAD = options.head ?? "";
  process.env.GUARDIAN_TEST_DYNAMIC_HEAD = options.dynamicHead === true ? "1" : "0";
  process.env.GUARDIAN_TEST_GH_LOG = logPath;
  process.env.GUARDIAN_TEST_PR_CREATED = createdPath;
  process.env.GUARDIAN_TEST_PR_URL = url;
  process.env.GUARDIAN_TEST_MERGE_FAILS = options.mergeFails === true ? "1" : "0";
  process.env.GUARDIAN_TEST_EXPECT_ADMIN = options.expectAdmin === true ? "1" : "0";
  t.after(() => {
    for (const [key, value] of Object.entries(originalEnv)) restoreEnv(key, value);
  });

  return { logPath, url };
}

// Relies on land-clean invoking `pr create -> view -> merge` sequentially per session: create
// records its --head branch to a file that view/merge replay. Merges use --no-ff so independent
// session branches can all land on main.
export async function installMultiBranchFakeGh(t: TestLifecycle, options: { readonly repo: string }) {
  const binDir = await createTempDir("guardian-multi-gh-");
  const stateDir = await createTempDir("guardian-multi-gh-state-");
  const ghPath = path.join(binDir, "gh");
  const logPath = path.join(stateDir, "gh.log");
  const currentPath = path.join(stateDir, "current-branch");
  const script = `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$GUARDIAN_TEST_GH_LOG"
sub="\${2:-}"
head_branch=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--head" ]; then head_branch="$arg"; fi
  prev="$arg"
done
if [ "$1" = "pr" ] && [ "$sub" = "list" ]; then
  printf '[]\\n'
elif [ "$1" = "pr" ] && [ "$sub" = "create" ]; then
  printf '%s\\n' "$head_branch" > "$GUARDIAN_TEST_CURRENT_BRANCH"
  printf 'https://github.example/acme/widget/pull/%s\\n' "$head_branch"
elif [ "$1" = "pr" ] && [ "$sub" = "view" ]; then
  branch="$(cat "$GUARDIAN_TEST_CURRENT_BRANCH")"
  oid="$(git -C "$GUARDIAN_TEST_REPO" rev-parse "$branch")"
  printf '{"number":1,"url":"https://github.example/acme/widget/pull/%s","headRefName":"%s","headRefOid":"%s"}\\n' "$branch" "$branch" "$oid"
elif [ "$1" = "pr" ] && [ "$sub" = "merge" ]; then
  branch="$(cat "$GUARDIAN_TEST_CURRENT_BRANCH")"
  git -C "$GUARDIAN_TEST_REPO" checkout main >/dev/null 2>&1
  git -C "$GUARDIAN_TEST_REPO" merge --no-ff "$branch" -m "merge $branch" >/dev/null 2>&1
  git -C "$GUARDIAN_TEST_REPO" push origin main >/dev/null 2>&1
else
  echo "unexpected gh invocation: $*" >&2
  exit 2
fi
`;
  await fs.writeFile(ghPath, script, "utf8");
  await fs.chmod(ghPath, 0o755);
  const originalEnv = {
    PATH: process.env.PATH,
    GUARDIAN_TEST_REPO: process.env.GUARDIAN_TEST_REPO,
    GUARDIAN_TEST_GH_LOG: process.env.GUARDIAN_TEST_GH_LOG,
    GUARDIAN_TEST_CURRENT_BRANCH: process.env.GUARDIAN_TEST_CURRENT_BRANCH,
  };
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.GUARDIAN_TEST_REPO = options.repo;
  process.env.GUARDIAN_TEST_GH_LOG = logPath;
  process.env.GUARDIAN_TEST_CURRENT_BRANCH = currentPath;
  t.after(() => {
    for (const [key, value] of Object.entries(originalEnv)) restoreEnv(key, value);
  });
  return { logPath };
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
