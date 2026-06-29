import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import plugin from "../src/index.ts";
import { getGuardianPaths, readState, recordSession } from "../src/state.ts";
import type { GuardianSession } from "../src/types.ts";
import { createRepoWithOrigin, git, seedSession } from "./helpers.ts";

type LooseRecord = Record<string, unknown>;

function isLooseRecord(value: unknown): value is LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordValue(value: unknown): LooseRecord {
  if (!isLooseRecord(value)) throw new TypeError("expected record");
  return value;
}

function createClient(records: Array<LooseRecord>) {
  return {
    app: {
      async log(event: { readonly body: LooseRecord }) {
        records.push(event.body);
      },
    },
  };
}

function requireSession(session: GuardianSession | undefined): GuardianSession {
  assert.ok(session);
  return session;
}

function findSession(sessions: readonly GuardianSession[], sessionId: string): GuardianSession {
  return requireSession(sessions.find((session) => session.session_id === sessionId));
}

async function enableLazyAutoStart(repo: string) {
  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({ autoStartMode: "lazy" }));
  await git(repo, ["add", ".opencode/worktree-guardian.json"]);
  await git(repo, ["commit", "-m", "enable lazy guardian auto start"]);
}

test("tool.execute.before routes mutating commands to the default auto-start owned worktree", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionID = "ses_auto_start_block_mutation";
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });

  await hooks["experimental.chat.system.transform"](
    { sessionID, taskName: "block root mutation" },
    { system: [] },
  );
  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });
  assert.notEqual(state.sessions[sessionID].worktree_path, repo);

  const output: { args: { command: string; workdir?: string; cwd?: string } } = { args: { command: "touch repo-root-mutation.txt" } };

  await hooks["tool.execute.before"]({ tool: "bash", sessionID, callID: "call_root_mutation" }, output);

  assert.equal(output.args.workdir, state.sessions[sessionID].worktree_path);
  assert.equal(output.args.cwd, state.sessions[sessionID].worktree_path);
});

test("default auto-start repairs poisoned primary ownership before routing mutating commands", async (t) => {
  const { git } = await import("./helpers.ts");
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionID = "ses_auto_start_repair_poisoned";
  const { stdout: commit } = await git(repo, ["rev-parse", "HEAD"]);
  await seedSession(repo, {
    session_id: sessionID,
    status: "active",
    branch: "main",
    worktree_path: repo,
    base_ref: "origin/main",
    head_commit: commit,
    safety_refs: [],
  });
  const records: Array<LooseRecord> = [];
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient(records) });

  await hooks["experimental.chat.system.transform"](
    { sessionID, taskName: "repair poisoned" },
    { system: [] },
  );

  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });
  const session = requireSession(state.sessions[sessionID]);
  assert.notEqual(session.worktree_path, repo);
  assert.match(String(session.branch), /^guardian\//);
  assert.equal(recordValue(records[0].invisibleStart).repaired, true);

  const output: { args: { command: string; workdir?: string; cwd?: string } } = { args: { command: "touch repaired.txt" } };
  await hooks["tool.execute.before"]({ tool: "bash", sessionID, callID: "call_repaired_poisoned" }, output);

  assert.equal(output.args.workdir, session.worktree_path);
  assert.equal(output.args.cwd, session.worktree_path);
});

test("tool.execute.before allows read-only commands after default auto-start leaves host at repo root", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionID = "ses_auto_start_allow_readonly";
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });

  await hooks["experimental.chat.system.transform"](
    { sessionID, taskName: "allow readonly root context" },
    { system: [] },
  );

  await assert.doesNotReject(() => hooks["tool.execute.before"](
    { tool: "bash", sessionID, callID: "call_root_readonly" },
    { args: { command: "git status --short" } },
  ));
});

test("tool.execute.before allows normal git when stale guardian state cannot route", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionID = "ses_stale_normal_git";
  const hooks = await plugin.server({ directory: repo, worktree: repo, client: createClient([]) });
  const missingWorktree = `${repo}/.worktrees/opencode-worktree-guardian/missing-normal-git`;
  const { stdout: head } = await git(repo, ["rev-parse", "HEAD"]);
  await recordSession(repo, DEFAULT_CONFIG, {
    session_id: sessionID,
    status: "active",
    branch: "guardian/missing-normal-git",
    worktree_path: missingWorktree,
    base_ref: "origin/main",
    head_commit: head,
    safety_refs: [],
  });

  for (const command of ["git add README.md", "git commit -m noop", "git fetch --prune origin", "git push origin main"]) {
    await assert.doesNotReject(() => hooks["tool.execute.before"](
      { tool: "bash", sessionID, callID: `call_${command.replace(/\W+/g, "_")}` },
      { args: { command } },
    ), command);
  }

  await assert.rejects(
    () => hooks["tool.execute.before"](
      { tool: "bash", sessionID, callID: "call_stale_destructive" },
      { args: { command: "git reset --hard" } },
    ),
    /Worktree Guardian blocked command/,
  );
});


test("/guardian slash commands rewrite to native tool instructions", async () => {
  const hooks = await plugin.server({ directory: "/repo", worktree: "/repo/.worktrees/example" });
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "/guardian status", sessionID: "ses_123", arguments: [] }, output);
  assert.deepEqual(output.parts, [{ type: "text", text: "Use the guardian_status native tool." }]);

  const deleteOutput = { parts: [] };
  await hooks["command.execute.before"]({ command: "/guardian delete-worktree", sessionID: "ses_123", arguments: [] }, deleteOutput);
  assert.deepEqual(deleteOutput.parts, [{ type: "text", text: "Use the guardian_delete_worktree native tool. Run mode=plan first. Dirty targets block by default; use allowRedundantDirtyPaths=true only in direct plan/apply when Guardian proves each dirty path already matches the fetched base tree and reports dirtySnapshotRef. Stale local Guardian branch cleanup requires an exact branch or terminal sessionId plus deleteBranch=true and Guardian ownership proof from terminal state or safety refs. Intentional unmerged local abandonment requires deleteBranch=true plus abandonUnmerged=true in both plan and apply after inspecting unmerged commit evidence." }]);

  const deletePathsOutput = { parts: [] };
  await hooks["command.execute.before"]({ command: "/guardian delete-paths src/old.ts", sessionID: "ses_123", arguments: [] }, deletePathsOutput);
  assert.deepEqual(deletePathsOutput.parts, [{ type: "text", text: "Use the guardian_delete_paths native tool. Run mode=plan first with exact paths, inspect target status and blockers, get explicit user confirmation, then apply with confirmDelete=true. Tracked source deletion requires allowTracked=true; directory deletion requires allowRecursive=true. User arguments: src/old.ts" }]);

  const doneOutput: { parts: Array<{ readonly type: string; readonly text: string }> } = { parts: [] };
  await hooks["command.execute.before"]({ command: "/guardian done", sessionID: "ses_123", arguments: [] }, doneOutput);
  assert.equal(doneOutput.parts.length, 1);
  const donePrompt = doneOutput.parts[0]?.text ?? "";
  assert.match(donePrompt, /guardian_done/);
  assert.match(donePrompt, /mode=plan/);
  assert.match(donePrompt, /selectedTarget/);
  assert.match(donePrompt, /from any cwd/);
  assert.match(donePrompt, /exactly one dirty implementation target/);
  assert.match(donePrompt, /needs-selection/);
  assert.match(donePrompt, /primary=true/);
  assert.match(donePrompt, /sessionId=\.\.\./);
  assert.match(donePrompt, /branch=\.\.\./);
  assert.match(donePrompt, /commitMessage/);
  assert.match(donePrompt, /allowAdminBypass=true/);
});
