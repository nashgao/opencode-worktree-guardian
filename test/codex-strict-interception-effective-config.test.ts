import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CONFIG_PATH } from "../src/config.ts";
import { createRepoWithOrigin, createTempDir, git } from "./helpers.ts";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const codexHookPath = path.join(projectRoot, "codex", "hooks", "guardian-hook.ts");

type HookResult = Readonly<{ readonly stdout: string; readonly stderr: string }>;

type HookPayload = Readonly<{
  readonly hook_event_name: "PreToolUse";
  readonly session_id: string;
  readonly cwd: string;
  readonly tool_name: "Bash";
  readonly tool_input: Readonly<{ readonly command: string }>;
}>;

async function runPreToolUse(payload: HookPayload): Promise<HookResult> {
  const env = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  delete env.NODE_COMPILE_CACHE;
  delete env.OPENCODE_WORKTREE_GUARDIAN_COVERAGE_RUN;
  const child = spawn(process.execPath, [codexHookPath, "hook", "pre-tool-use"], {
    cwd: payload.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout.push(chunk));
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));
  child.stdin.end(`${JSON.stringify(payload)}\n`);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0, stderr.join(""));
  return { stdout: stdout.join(""), stderr: stderr.join("") };
}

async function writeConfig(repo: string, config: unknown): Promise<void> {
  const configPath = path.join(repo, CONFIG_PATH);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config));
}

function payload(cwd: string, command: string): HookPayload {
  return {
    hook_event_name: "PreToolUse",
    session_id: "ses_codex_effective_config",
    cwd,
    tool_name: "Bash",
    tool_input: { command },
  };
}

function assertBlocked(result: HookResult): void {
  assert.match(result.stdout, /"decision":"block"/);
  assert.match(result.stdout, /Worktree Guardian blocked command/);
}

test("Codex stdin hook blocks linked-worktree effective config and contextual command bypasses in strict mode", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const linked = path.join(base, "linked");
  await git(repo, ["worktree", "add", "-b", "guardian/linked", linked]);
  await git(repo, ["config", "extensions.worktreeConfig", "true"]);
  await writeConfig(repo, { commandInterceptionMode: "strict", autoStart: false });

  const { stdout: linkedGitDir } = await git(linked, ["rev-parse", "--absolute-git-dir"]);
  const { stdout: primaryGitDir } = await git(repo, ["rev-parse", "--absolute-git-dir"]);
  const { stdout: headOid } = await git(linked, ["rev-parse", "HEAD"]);
  const outside = path.join(base, "outside");
  const primaryLink = path.join(outside, "primary-link");
  await fs.mkdir(outside);
  await fs.symlink(repo, primaryLink, "dir");
  await t.test("blocks an effective linked-worktree mirror", async (subtest) => {
    await git(linked, ["config", "--worktree", "--replace-all", "remote.origin.mirror", "true"]);
    subtest.after(() => git(linked, ["config", "--worktree", "--unset-all", "remote.origin.mirror"]));
    assertBlocked(await runPreToolUse(payload(linked, "git push origin")));
  });
  await t.test("blocks an actual linked-worktree Git alias", async (subtest) => {
    await git(linked, ["config", "--worktree", "--replace-all", "alias.guardian-nuke", "reset --hard"]);
    subtest.after(() => git(linked, ["config", "--worktree", "--unset-all", "alias.guardian-nuke"]));
    assertBlocked(await runPreToolUse(payload(linked, "git guardian-nuke")));
  });
  await t.test("blocks a configured linked-worktree force mapping", async (subtest) => {
    await git(linked, ["config", "--worktree", "--replace-all", "remote.origin.push", "+HEAD:refs/heads/main"]);
    subtest.after(() => git(linked, ["config", "--worktree", "--unset-all", "remote.origin.push"]));
    assertBlocked(await runPreToolUse(payload(linked, "git push origin")));
  });
  await t.test("blocks a configured linked-worktree deletion mapping", async (subtest) => {
    await git(linked, ["config", "--worktree", "--replace-all", "remote.origin.push", ":refs/heads/main"]);
    subtest.after(() => git(linked, ["config", "--worktree", "--unset-all", "remote.origin.push"]));
    assertBlocked(await runPreToolUse(payload(linked, "git push origin")));
  });
  await t.test("blocks effective config reached through git -C", async (subtest) => {
    await git(linked, ["config", "--worktree", "--replace-all", "remote.origin.mirror", "true"]);
    subtest.after(() => git(linked, ["config", "--worktree", "--unset-all", "remote.origin.mirror"]));
    assertBlocked(await runPreToolUse(payload(repo, `git -C ${linked} push origin`)));
  });
  await t.test("blocks effective config reached through --git-dir and --work-tree", async (subtest) => {
    await git(linked, ["config", "--worktree", "--replace-all", "remote.origin.mirror", "true"]);
    subtest.after(() => git(linked, ["config", "--worktree", "--unset-all", "remote.origin.mirror"]));
    assertBlocked(await runPreToolUse(payload(repo, `git --git-dir=${linkedGitDir} --work-tree=${linked} push origin`)));
  });
  await t.test("blocks opaque shell execution in the linked-worktree context", async (subtest) => {
    await git(linked, ["config", "--worktree", "--replace-all", "remote.origin.mirror", "true"]);
    subtest.after(() => git(linked, ["config", "--worktree", "--unset-all", "remote.origin.mirror"]));
    assertBlocked(await runPreToolUse(payload(repo, `sh -c ${JSON.stringify(`git -C ${linked} push origin`)}`)));
  });
  await t.test("blocks a variable-selected Git executable", async () => {
    assertBlocked(await runPreToolUse(payload(linked, "G=git; $G reset --hard")));
  });
  await t.test("blocks a configured alternate protected-source refspec", async (subtest) => {
    await git(linked, ["config", "--worktree", "--replace-all", "remote.origin.push", "refs/heads/guardian/linked:refs/heads/main"]);
    subtest.after(() => git(linked, ["config", "--worktree", "--unset-all", "remote.origin.push"]));
    assertBlocked(await runPreToolUse(payload(linked, "git push origin")));
  });
  for (const source of [headOid.slice(0, 12), "HEAD~00", "@~0"]) {
    await t.test(`blocks configured case-sensitive protected-source mapping ${source}`, async (subtest) => {
      await git(linked, ["config", "--worktree", "--replace-all", "remote.Origin.push", `${source}:refs/heads/main`]);
      subtest.after(() => git(linked, ["config", "--worktree", "--unset-all", "remote.Origin.push"]));
      assertBlocked(await runPreToolUse(payload(linked, "git push Origin")));
    });
  }
  await t.test("blocks @ as a protected branch push source", async () => {
    assertBlocked(await runPreToolUse(payload(linked, "git push origin @:refs/heads/main")));
  });
  await t.test("blocks HEAD~0 as a protected branch push source", async () => {
    assertBlocked(await runPreToolUse(payload(linked, "git push origin HEAD~0:refs/heads/main")));
  });
  await t.test("blocks the linked Guardian HEAD OID as a protected branch push source", async () => {
    assertBlocked(await runPreToolUse(payload(linked, `git push origin ${headOid}:refs/heads/main`)));
  });
  for (const source of [headOid.slice(0, 12), "HEAD~00", "@~0"]) {
    await t.test(`blocks equivalent Guardian HEAD source ${source} as a protected branch push`, async () => {
      // Given an abbreviated or alternate-zero spelling of the linked Guardian HEAD.
      // When that spelling pushes to main.
      // Then the Codex hook rejects the equivalent source.
      assertBlocked(await runPreToolUse(payload(linked, `git push origin ${source}:refs/heads/main`)));
    });
  }
  await t.test("blocks a protected primary merge through explicit Git target symlink paths", async () => {
    // Given an explicit Git directory and a symlink spelling of the protected primary worktree.
    // When the linked Guardian branch is merged through that target.
    // Then the Codex hook uses the actual protected target branch.
    assertBlocked(await runPreToolUse(payload(linked, `git --git-dir=${primaryGitDir} --work-tree=${primaryLink} merge guardian/linked`)));
  });
});

test("Codex applies the strict policy of a git -C target instead of the audit payload cwd", async (t) => {
  const strictRepo = await createRepoWithOrigin();
  const auditRepo = await createRepoWithOrigin();
  t.after(() => fs.rm(strictRepo.base, { recursive: true, force: true }));
  t.after(() => fs.rm(auditRepo.base, { recursive: true, force: true }));
  await writeConfig(strictRepo.repo, { commandInterceptionMode: "strict", autoStart: false });
  await writeConfig(auditRepo.repo, { commandInterceptionMode: "audit", autoStart: false });

  assertBlocked(await runPreToolUse(payload(auditRepo.repo, `git -C ${strictRepo.repo} reset --hard`)));
});

test("Codex blocks compound Git commands when either segment targets a strict repository", async (t) => {
  // Given separate audit and strict repositories.
  const strictRepo = await createRepoWithOrigin();
  const auditRepo = await createRepoWithOrigin();
  t.after(() => fs.rm(strictRepo.base, { recursive: true, force: true }));
  t.after(() => fs.rm(auditRepo.base, { recursive: true, force: true }));
  await writeConfig(strictRepo.repo, { commandInterceptionMode: "strict", autoStart: false });
  await writeConfig(auditRepo.repo, { commandInterceptionMode: "audit", autoStart: false });

  for (const [order, command] of [
    ["strict-first", `git -C ${strictRepo.repo} reset --hard && git -C ${auditRepo.repo} reset --hard`],
    ["audit-first", `git -C ${auditRepo.repo} reset --hard && git -C ${strictRepo.repo} reset --hard`],
  ]) {
    await t.test(`blocks ${order} compound command`, async () => {
      // When a destructive command targets both repositories in this segment order.
      // Then strict policy blocks the compound command before either segment can run.
      assertBlocked(await runPreToolUse(payload(auditRepo.repo, command)));
    });
  }
});

test("Codex audit from a non-Git directory emits no blocking JSON", async (t) => {
  const directory = await createTempDir("codex-non-git-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const result = await runPreToolUse(payload(directory, "git reset --hard HEAD~1"));

  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("Codex still blocks invalid configuration inside a Git repository", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await writeConfig(repo, "strict");

  assertBlocked(await runPreToolUse(payload(repo, "git reset --hard HEAD~1")));
});
