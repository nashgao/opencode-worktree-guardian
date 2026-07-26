import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import plugin from "../src/index.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

type LogRecord = Record<string, unknown>;

type LinkedFixture = Readonly<{
  readonly base: string;
  readonly repo: string;
  readonly linked: string;
}>;

function createClient(records: LogRecord[]) {
  return {
    app: {
      async log(event: { readonly body: LogRecord }) {
        records.push(event.body);
      },
    },
  };
}

function isLogRecord(value: unknown): value is LogRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordValue(value: unknown): LogRecord {
  if (!isLogRecord(value)) throw new TypeError("expected hook log record");
  return value;
}

async function writeConfig(repo: string, config: Record<string, unknown>): Promise<void> {
  const configPath = path.join(repo, ".opencode", "worktree-guardian.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config));
}

async function createLinkedFixture(t: test.TestContext): Promise<LinkedFixture> {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const linked = path.join(base, "linked");
  await git(repo, ["worktree", "add", "-b", "guardian/linked", linked]);
  await git(repo, ["config", "extensions.worktreeConfig", "true"]);
  await writeConfig(repo, { commandInterceptionMode: "strict", autoStart: false });
  return { base, repo, linked };
}

async function expectStrictBlock(
  fixture: LinkedFixture,
  command: string,
  workdir = fixture.linked,
): Promise<void> {
  const hooks = await plugin.server({ directory: fixture.repo, worktree: fixture.linked, client: createClient([]) });
  await assert.rejects(
    () => hooks["tool.execute.before"](
      { tool: "bash", sessionID: "ses_effective_config", callID: `call_${command}` },
      { args: { command, workdir } },
    ),
    /Worktree Guardian blocked command/,
  );
}

test("OpenCode strict mode blocks effective linked-worktree transport and alias config through all command contexts", async (t) => {
  const fixture = await createLinkedFixture(t);
  const { stdout: linkedGitDir } = await git(fixture.linked, ["rev-parse", "--absolute-git-dir"]);
  const { stdout: primaryGitDir } = await git(fixture.repo, ["rev-parse", "--absolute-git-dir"]);
  const { stdout: headOid } = await git(fixture.linked, ["rev-parse", "HEAD"]);
  const victim = path.join(fixture.repo, "victim");
  const outside = path.join(fixture.base, "outside");
  const symlinkTarget = path.join(outside, "link-to-repo");
  await fs.writeFile(victim, "victim\n");
  await fs.mkdir(outside);
  await fs.symlink(fixture.repo, symlinkTarget, "dir");

  await t.test("blocks an effective linked-worktree mirror", async (subtest) => {
    await git(fixture.linked, ["config", "--worktree", "--replace-all", "remote.origin.mirror", "true"]);
    subtest.after(() => git(fixture.linked, ["config", "--worktree", "--unset-all", "remote.origin.mirror"]));
    await expectStrictBlock(fixture, "git push origin");
  });
  await t.test("blocks an actual linked-worktree Git alias", async (subtest) => {
    await git(fixture.linked, ["config", "--worktree", "--replace-all", "alias.guardian-nuke", "reset --hard"]);
    subtest.after(() => git(fixture.linked, ["config", "--worktree", "--unset-all", "alias.guardian-nuke"]));
    await expectStrictBlock(fixture, "git guardian-nuke");
  });
  await t.test("blocks a configured linked-worktree force mapping", async (subtest) => {
    await git(fixture.linked, ["config", "--worktree", "--replace-all", "remote.origin.push", "+HEAD:refs/heads/main"]);
    subtest.after(() => git(fixture.linked, ["config", "--worktree", "--unset-all", "remote.origin.push"]));
    await expectStrictBlock(fixture, "git push origin");
  });
  await t.test("blocks a configured linked-worktree deletion mapping", async (subtest) => {
    await git(fixture.linked, ["config", "--worktree", "--replace-all", "remote.origin.push", ":refs/heads/main"]);
    subtest.after(() => git(fixture.linked, ["config", "--worktree", "--unset-all", "remote.origin.push"]));
    await expectStrictBlock(fixture, "git push origin");
  });
  await t.test("blocks effective config reached through git -C", async (subtest) => {
    await git(fixture.linked, ["config", "--worktree", "--replace-all", "remote.origin.mirror", "true"]);
    subtest.after(() => git(fixture.linked, ["config", "--worktree", "--unset-all", "remote.origin.mirror"]));
    await expectStrictBlock(fixture, `git -C ${fixture.linked} push origin`, fixture.repo);
  });
  await t.test("blocks effective config reached through --git-dir and --work-tree", async (subtest) => {
    await git(fixture.linked, ["config", "--worktree", "--replace-all", "remote.origin.mirror", "true"]);
    subtest.after(() => git(fixture.linked, ["config", "--worktree", "--unset-all", "remote.origin.mirror"]));
    await expectStrictBlock(fixture, `git --git-dir=${linkedGitDir} --work-tree=${fixture.linked} push origin`, fixture.repo);
  });
  await t.test("blocks opaque shell execution in the linked-worktree context", async (subtest) => {
    await git(fixture.linked, ["config", "--worktree", "--replace-all", "remote.origin.mirror", "true"]);
    subtest.after(() => git(fixture.linked, ["config", "--worktree", "--unset-all", "remote.origin.mirror"]));
    await expectStrictBlock(fixture, `sh -c ${JSON.stringify(`git -C ${fixture.linked} push origin`)}`, fixture.repo);
  });
  await t.test("blocks a variable-selected Git executable", async () => {
    await expectStrictBlock(fixture, "G=git; $G reset --hard");
  });
  await t.test("blocks a configured alternate protected-source refspec", async (subtest) => {
    await git(fixture.linked, ["config", "--worktree", "--replace-all", "remote.origin.push", "refs/heads/guardian/linked:refs/heads/main"]);
    subtest.after(() => git(fixture.linked, ["config", "--worktree", "--unset-all", "remote.origin.push"]));
    await expectStrictBlock(fixture, "git push origin");
  });
  for (const source of [headOid.slice(0, 12), "HEAD~00", "@~0"]) {
    await t.test(`blocks configured case-sensitive protected-source mapping ${source}`, async (subtest) => {
      await git(fixture.linked, ["config", "--worktree", "--replace-all", "remote.Origin.push", `${source}:refs/heads/main`]);
      subtest.after(() => git(fixture.linked, ["config", "--worktree", "--unset-all", "remote.Origin.push"]));
      await expectStrictBlock(fixture, "git push Origin");
    });
  }
  await t.test("blocks @ as a protected branch push source", async () => {
    await expectStrictBlock(fixture, "git push origin @:refs/heads/main");
  });
  await t.test("blocks HEAD~0 as a protected branch push source", async () => {
    await expectStrictBlock(fixture, "git push origin HEAD~0:refs/heads/main");
  });
  await t.test("blocks the linked Guardian HEAD OID as a protected branch push source", async () => {
    await expectStrictBlock(fixture, `git push origin ${headOid}:refs/heads/main`);
  });
  for (const source of [headOid.slice(0, 12), "HEAD~00", "@~0"]) {
    await t.test(`blocks equivalent Guardian HEAD source ${source} as a protected branch push`, async () => {
      // Given an abbreviated or alternate-zero spelling of the linked Guardian HEAD.
      // When that spelling pushes to main.
      // Then strict interception rejects the equivalent source.
      await expectStrictBlock(fixture, `git push origin ${source}:refs/heads/main`);
    });
  }
  await t.test("blocks a protected primary merge through explicit Git target symlink paths", async () => {
    // Given an explicit Git directory and a symlink spelling of the protected primary worktree.
    // When the linked Guardian branch is merged through that target.
    // Then strict interception uses the actual protected target branch.
    await expectStrictBlock(fixture, `git --git-dir=${primaryGitDir} --work-tree=${symlinkTarget} merge guardian/linked`, fixture.linked);
  });
  await t.test("blocks a victim reached through an outside symlink into the primary repository", async () => {
    await expectStrictBlock(fixture, `rm -rf ${path.join(symlinkTarget, "victim")}`, fixture.linked);
  });
});

test("OpenCode applies the strict policy of a git -C target instead of the audit hook cwd", async (t) => {
  const strictRepo = await createRepoWithOrigin();
  const auditRepo = await createRepoWithOrigin();
  t.after(() => fs.rm(strictRepo.base, { recursive: true, force: true }));
  t.after(() => fs.rm(auditRepo.base, { recursive: true, force: true }));
  await writeConfig(strictRepo.repo, { commandInterceptionMode: "strict", autoStart: false });
  await writeConfig(auditRepo.repo, { commandInterceptionMode: "audit", autoStart: false });
  const hooks = await plugin.server({ directory: auditRepo.repo, worktree: auditRepo.repo, client: createClient([]) });

  await assert.rejects(
    () => hooks["tool.execute.before"](
      { tool: "bash", sessionID: "ses_cross_repo_policy", callID: "call_cross_repo_policy" },
      { args: { command: `git -C ${strictRepo.repo} reset --hard`, workdir: auditRepo.repo } },
    ),
    /Worktree Guardian blocked command/,
  );
});

test("OpenCode blocks compound Git commands when either segment targets a strict repository", async (t) => {
  // Given separate audit and strict repositories.
  const strictRepo = await createRepoWithOrigin();
  const auditRepo = await createRepoWithOrigin();
  t.after(() => fs.rm(strictRepo.base, { recursive: true, force: true }));
  t.after(() => fs.rm(auditRepo.base, { recursive: true, force: true }));
  await writeConfig(strictRepo.repo, { commandInterceptionMode: "strict", autoStart: false });
  await writeConfig(auditRepo.repo, { commandInterceptionMode: "audit", autoStart: false });
  const hooks = await plugin.server({ directory: auditRepo.repo, worktree: auditRepo.repo, client: createClient([]) });

  for (const [order, command] of [
    ["strict-first", `git -C ${strictRepo.repo} reset --hard && git -C ${auditRepo.repo} reset --hard`],
    ["audit-first", `git -C ${auditRepo.repo} reset --hard && git -C ${strictRepo.repo} reset --hard`],
  ]) {
    await t.test(`blocks ${order} compound command`, async () => {
      // When a destructive command targets both repositories in this segment order.
      // Then strict policy blocks the compound command before either segment can run.
      await assert.rejects(
        () => hooks["tool.execute.before"](
          { tool: "bash", sessionID: "ses_compound_context", callID: `call_${command}` },
          { args: { command, workdir: auditRepo.repo } },
        ),
        /Worktree Guardian blocked command/,
      );
    });
  }
});

test("OpenCode audit logs but does not reject the same force-push classification", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await writeConfig(repo, { commandInterceptionMode: "audit", autoStart: false });
  const records: LogRecord[] = [];
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient(records) });

  await assert.doesNotReject(
    () => hooks["tool.execute.before"](
      { tool: "bash", sessionID: "ses_audit", callID: "call_audit" },
      { args: { command: "git push origin +HEAD:refs/heads/main", workdir: repo } },
    ),
  );

  const record = records.find((candidate) => candidate.message === "tool.execute.before");
  assert.ok(record);
  assert.equal(recordValue(record.guard).blocked, true);
  assert.equal(record.auditOnly, true);
});
