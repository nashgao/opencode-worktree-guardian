import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { configuredRemoteAuthority, resolveRemoteAuthority } from "../src/git-authority.ts";
import { classifyGuardCommand, classifyNormalAgentGitCommand } from "../src/guards.ts";
import { guardianStart } from "../src/tools.ts";
import type { GuardOptions } from "../src/types.ts";
import { guardianFinishWorkflow } from "../src/workflow.ts";
import { createRepoWithOrigin, createTempDir, git } from "./helpers.ts";

const execFileAsync = promisify(execFile);

const currentHeadOid = "0123456789012345678901234567890123456789";
const guardianBranchOptions = {
  protectedBranches: ["main"],
  branchPrefix: "guardian/",
  currentBranch: "guardian/source-identity",
  inspection: {
    state: "available",
    aliases: [],
    transportConfigs: [],
    currentHead: currentHeadOid,
  },
} satisfies GuardOptions;

function assertBlocked(command: string): void {
  assert.equal(classifyGuardCommand(command, guardianBranchOptions).blocked, true, command);
  assert.equal(classifyNormalAgentGitCommand(command, guardianBranchOptions).allowed, false, command);
}

for (const source of ["@", "HEAD~0", "HEAD^0", "HEAD~00", "@~0", currentHeadOid, currentHeadOid.slice(0, 12)]) {
  test(`blocks a protected push from Guardian head spelling ${source}`, () => {
    // Given a Guardian branch HEAD expressed by an equivalent revision spelling.
    // When that spelling is pushed to a protected branch.
    // Then both guard paths reject the bypass.
    assertBlocked(`git push origin ${source}:refs/heads/main`);
  });
}

test("permits a Guardian head push to an ordinary feature destination", () => {
  const command = `git push origin ${currentHeadOid}:refs/heads/feature`;

  assert.equal(classifyGuardCommand(command, guardianBranchOptions).blocked, false, command);
  assert.equal(classifyNormalAgentGitCommand(command, guardianBranchOptions).allowed, true, command);
});

test("land-clean planning respects effective global signing and hooks policy", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = await createTempDir("guardian-global-git-config-");
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; });
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "global-policy", taskName: "global policy", createWorktree: true, config: DEFAULT_CONFIG });
  const request = { repoRoot: repo, cwd: started.session.worktree_path, sessionId: "global-policy", mode: "plan", commitMessage: "add feature", config: DEFAULT_CONFIG };
  await fs.writeFile(path.join(request.cwd, "feature.txt"), "feature\n");
  await git(request.cwd, ["config", "--global", "commit.gpgSign", "true"]);
  const signing = await guardianDone(request);
  await git(request.cwd, ["config", "--global", "--unset", "commit.gpgSign"]);
  const hooks = path.join(home, "hooks");
  await fs.mkdir(hooks, { recursive: true });
  await fs.writeFile(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 0\n");
  await fs.chmod(path.join(hooks, "pre-commit"), 0o755);
  await git(request.cwd, ["config", "--global", "core.hooksPath", hooks]);
  const hook = await guardianDone(request);
  assert.match(String(signing.reason), /signing policy/);
  assert.match(String(hook.reason), /commit hook/);
});

test("land-clean planning blocks when the configured signing policy is malformed", async (t) => {
  // Given a disposable session whose effective signing configuration Git cannot parse.
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "malformed-signing-policy", taskName: "malformed signing policy", createWorktree: true, config: DEFAULT_CONFIG });
  const request = { repoRoot: repo, cwd: started.session.worktree_path, sessionId: "malformed-signing-policy", mode: "plan" as const, commitMessage: "add feature", config: DEFAULT_CONFIG };
  await fs.writeFile(path.join(request.cwd, "feature.txt"), "feature\n");
  await git(request.cwd, ["config", "commit.gpgSign", "malformed"]);

  // When Guardian plans a land-and-clean operation through its public surface.
  const plan = await guardianDone(request);

  // Then it fails closed rather than treating the unreadable policy as absent.
  assert.equal(plan.ok, false, JSON.stringify(plan));
  assert.equal(plan.status, "blocked", JSON.stringify(plan));
  assert.match(String(plan.reason), /commit policy could not be resolved/i);
});

test("land-clean planning blocks configured clean filters before they execute", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, ".gitattributes"), "*.txt filter=guardian-test\n");
  await git(repo, ["add", ".gitattributes"]);
  await git(repo, ["commit", "-m", "configure attributes"]);
  await git(repo, ["push", "origin", "main"]);
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "filter-policy", taskName: "filter policy", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  await fs.writeFile(path.join(worktree, "feature.txt"), "feature\n");
  const marker = path.join(base, "filter-ran");
  const filter = path.join(base, "clean-filter.sh");
  await fs.writeFile(filter, `#!/bin/sh\ncat\n: > ${JSON.stringify(marker)}\n`);
  await fs.chmod(filter, 0o755);
  await git(worktree, ["config", "filter.guardian-test.clean", filter]);

  const plan = await guardianDone({ repoRoot: repo, cwd: worktree, sessionId: "filter-policy", mode: "plan", commitMessage: "add feature", config: DEFAULT_CONFIG });

  assert.equal(plan.ok, false, JSON.stringify(plan));
  assert.match(String(plan.reason), /clean filter/);
  await assert.rejects(fs.access(marker));
});

test("land-clean planning blocks commit hooks and every Git truthy signing spelling", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "commit-policy", taskName: "commit policy", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  await fs.writeFile(path.join(worktree, "feature.txt"), "feature\n");
  const hooksPath = path.resolve(worktree, (await git(worktree, ["rev-parse", "--git-path", "hooks"])).stdout);
  await fs.mkdir(hooksPath, { recursive: true });
  const hookPath = path.join(hooksPath, "pre-commit");
  await fs.writeFile(hookPath, "#!/bin/sh\nexit 0\n");
  await fs.chmod(hookPath, 0o755);
  const request = { repoRoot: repo, cwd: worktree, sessionId: "commit-policy", mode: "plan", commitMessage: "add feature", config: DEFAULT_CONFIG };

  const hookPlan = await guardianDone(request);
  await fs.rm(hookPath);
  assert.equal(hookPlan.ok, false, JSON.stringify(hookPlan));
  assert.match(String(hookPlan.reason), /commit hook/);
  for (const signingValue of ["true", "yes", "on", "1"]) {
    await git(worktree, ["config", "commit.gpgSign", signingValue]);
    const signingPlan = await guardianDone(request);
    assert.equal(signingPlan.ok, false, JSON.stringify(signingPlan));
    assert.match(String(signingPlan.reason), /signing policy/);
  }
});

test("configured authority preserves a slash remote and nested branch", () => {
  const authority = configuredRemoteAuthority({ remote: "trusted/team", baseBranch: "release/nested", trustedUpstreamRemotes: ["trusted/team"] });

  assert.deepEqual(authority, {
    remote: "trusted/team",
    branch: "release/nested",
    displayRef: "trusted/team/release/nested",
    authorityRef: "refs/remotes/trusted/team/release/nested",
  });
});

test("configured authority preserves reserved-prefix remote identities", () => {
  for (const remote of ["remotes/origin", "refs/remotes/origin"]) {
    const authority = configuredRemoteAuthority({ remote, baseBranch: "release/nested", trustedUpstreamRemotes: [remote] });

    assert.deepEqual(authority, {
      remote,
      branch: "release/nested",
      displayRef: `${remote}/release/nested`,
      authorityRef: `refs/remotes/${remote}/release/nested`,
    });
  }
});

test("remote authority resolves raw and singly-qualified reserved-prefix remotes", () => {
  const cases = [
    { remote: "remotes/origin", raw: "remotes/origin/release/nested", qualified: "refs/remotes/remotes/origin/release/nested" },
    { remote: "refs/remotes/origin", raw: "refs/remotes/origin/release/nested", qualified: "remotes/refs/remotes/origin/release/nested" },
  ];

  for (const candidate of cases) {
    const config = { remote: candidate.remote, trustedUpstreamRemotes: [candidate.remote] };
    const expected = {
      remote: candidate.remote,
      branch: "release/nested",
      displayRef: `${candidate.remote}/release/nested`,
      authorityRef: `refs/remotes/${candidate.remote}/release/nested`,
    };

    assert.deepEqual(resolveRemoteAuthority(candidate.raw, config), expected);
    assert.deepEqual(resolveRemoteAuthority(candidate.qualified, config), expected);
  }
});

test("remote authority rejects distinct trusted interpretations", () => {
  assert.throws(
    () => resolveRemoteAuthority("remotes/origin/main", { remote: "origin", trustedUpstreamRemotes: ["remotes/origin"] }),
    /Ambiguous upstream remote authority/,
  );
  assert.throws(
    () => resolveRemoteAuthority("refs/remotes/origin/main", { remote: "origin", trustedUpstreamRemotes: ["refs/remotes/origin"] }),
    /Ambiguous upstream remote authority/,
  );
});

test("remote authority rejects invalid branch syntax with a stable Git ref error", () => {
  const invalidBranches = [
    "--malformed-base",
    "",
    "/leading",
    "trailing/",
    "double//slash",
    "double..dot",
    "space branch",
    "tab\tbranch",
    "line\nbreak",
    "nul\0byte",
    "reflog@{entry",
    ".hidden",
    "nested/.hidden",
    "trailing.",
    "lock.lock",
    "nested/lock.lock",
  ];

  for (const branch of invalidBranches) {
    assert.throws(() => resolveRemoteAuthority(`origin/${branch}`, { remote: "origin" }), /Git ref/i);
  }
});

test("remote authority preserves normal nested branches", () => {
  assert.deepEqual(resolveRemoteAuthority("origin/feature/nested", { remote: "origin" }), {
    remote: "origin",
    branch: "feature/nested",
    displayRef: "origin/feature/nested",
    authorityRef: "refs/remotes/origin/feature/nested",
  });
});

type FetchMarkerOptions = {
  readonly marker: string;
  readonly upstream?: string;
};

async function withFetchMarker<T>(options: FetchMarkerOptions, action: () => Promise<T>): Promise<T> {
  const tools = await createTempDir("guardian-fetch-marker-");
  const realGit = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
  const upstreamResponse = options.upstream === undefined
    ? ""
    : `if [ "$1" = "-C" ] && [ "$3" = "rev-parse" ] && [ "$4" = "--abbrev-ref" ] && [ "$5" = "--symbolic-full-name" ] && [ "$6" = "main@{upstream}" ]; then printf '%s\\n' ${JSON.stringify(options.upstream)}; exit 0; fi\n`;
  await fs.writeFile(path.join(tools, "git"), `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = fetch ]; then : > ${JSON.stringify(options.marker)}; fi\ndone\n${upstreamResponse}exec ${JSON.stringify(realGit)} "$@"\n`);
  await fs.chmod(path.join(tools, "git"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${tools}${path.delimiter}${originalPath ?? ""}`;
  try {
    return await action();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await fs.rm(tools, { recursive: true, force: true });
  }
}

test("workflow rejects an ambiguous tracked upstream before fetch", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const marker = path.join(base, "fetch-ran");
  const config = { ...DEFAULT_CONFIG, trustedUpstreamRemotes: ["remotes/origin"] };

  await assert.rejects(
    () => withFetchMarker({ marker, upstream: "remotes/origin/main" }, () => guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", config })),
    /Ambiguous upstream remote authority/,
  );
  await assert.rejects(fs.access(marker));
});
