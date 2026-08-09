import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import {
  assert,
  createMergedBranch,
  createRepoWithOrigin,
  createSafetyRef,
  DEFAULT_CONFIG,
  fs,
  git,
  guardianFinishWorkflow,
  remoteBranchExists,
  test,
  workflowResult,
} from "./workflow-test-support.js";
import { getGuardianPaths, readState, updateState } from "../src/state.ts";
import { createTempDir } from "./helpers.ts";

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function probeValue(output: string, key: string): string {
  const line = output.split("\n").find((candidate) => candidate.startsWith(`${key}=`));
  if (line === undefined) throw new Error(`probe did not return ${key}`);
  return line.slice(key.length + 1);
}

async function recordRemoteReservation(repo: string, branch: string, head: string, safetyRef: string): Promise<void> {
  await updateState(repo, DEFAULT_CONFIG, (state) => ({
    ...state,
    remote_branch_cleanup_reservations: [{
      remote: "origin",
      remote_branch: branch,
      head,
      safety_ref: safetyRef,
      reserved_at: "2026-08-10T00:00:00.000Z",
    }],
  }));
}

test("guardian_finish_workflow stops before remote reservation state or safety-ref mutation when show-ref is indeterminate", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-remote-indeterminate-show-ref";
  await createMergedBranch(repo, branch, "workflow-remote-indeterminate-show-ref.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["branch", "-d", branch]);
  await git(repo, ["fetch", "origin"]);
  const timestamp = "20260809T010101";
  const plan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", timestamp }));
  const safetyRef = String(plan.candidates[0]?.safetyRef);
  const binDir = await createTempDir("guardian-indeterminate-show-ref-");
  const originalPath = process.env.PATH;
  const originalRealPath = process.env.GUARDIAN_REAL_PATH;
  const originalSafetyRef = process.env.GUARDIAN_TEST_SHOW_REF_TARGET;
await fs.writeFile(path.join(binDir, "git"), `#!/bin/sh
set -eu
case "$*" in
  *"show-ref --verify --quiet $GUARDIAN_TEST_SHOW_REF_TARGET"*) exit 2 ;;
esac
PATH="$GUARDIAN_REAL_PATH" exec git "$@"
`, "utf8");
  await fs.chmod(path.join(binDir, "git"), 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.GUARDIAN_REAL_PATH = originalPath ?? "";
  process.env.GUARDIAN_TEST_SHOW_REF_TARGET = safetyRef;
  t.after(async () => {
    restoreEnvironment("PATH", originalPath);
    restoreEnvironment("GUARDIAN_REAL_PATH", originalRealPath);
    restoreEnvironment("GUARDIAN_TEST_SHOW_REF_TARGET", originalSafetyRef);
    await fs.rm(binDir, { recursive: true, force: true });
  });

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken, timestamp }));
  const state = await readState(await getGuardianPaths(repo), { repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(apply.results[0]?.status, "blocked");
  assert.equal(Array.isArray(state.remote_branch_cleanup_reservations) ? state.remote_branch_cleanup_reservations.length : 0, 0);
  await assert.rejects(git(repo, ["rev-parse", "--verify", safetyRef]));
  assert.equal(await remoteBranchExists(repo, branch), true);
});

test("guardian_finish_workflow retires only the shown advanced remote reservation batch at its module-init limit", async () => {
  const fixture = new URL("./fixtures/workflow-remote-reservation-retirement-probe.ts", import.meta.url);
  const child = spawn(process.execPath, ["--import", "tsx", fixture.pathname], {
    cwd: process.cwd(),
    env: { ...process.env, GUARDIAN_MAX_CLEANUP_CANDIDATES: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.stdout === null || child.stderr === null) throw new TypeError("child output must be piped");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const [code, signal] = await once(child, "exit");

  assert.equal(code, 0, stderr);
  assert.equal(signal, null, stderr);
  assert.equal(probeValue(stdout, "total"), "2");
  assert.equal(probeValue(stdout, "shown"), "1");
  assert.equal(probeValue(stdout, "omitted"), "1");
  assert.equal(probeValue(stdout, "applyBatch"), "1");
  assert.equal(probeValue(stdout, "retired"), "1");
  assert.equal(probeValue(stdout, "remaining"), "1");
  assert.equal(probeValue(stdout, "branchesPreserved"), "true");
  assert.equal(probeValue(stdout, "safetyRefsPreserved"), "true");
});

test("guardian_finish_workflow blocks absent reconciliation when an empty-expectation lease sees a recreated remote branch", async (t) => {
  const { base, remote, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/workflow-remote-absent-lease-race";
  const head = await createMergedBranch(repo, branch, "workflow-remote-absent-lease-race.txt");
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["branch", "-d", branch]);
  await git(repo, ["fetch", "origin"]);
  const timestamp = "20260810T010101";
  const initialPlan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", timestamp }));
  const safetyRef = String(initialPlan.candidates[0]?.safetyRef);
  await createSafetyRef(repo, { sessionId: "remote-branch-cleanup", branch: `origin/${branch}`, commit: head, ref: safetyRef });
  await recordRemoteReservation(repo, branch, head, safetyRef);
  await git(repo, ["push", "origin", `:refs/heads/${branch}`]);
  await git(repo, ["fetch", "--prune", "origin"]);
  const reconciliationPlan = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "plan", timestamp }));
  const binDir = await createTempDir("guardian-absent-lease-race-");
  const originalPath = process.env.PATH;
  const originalRealPath = process.env.GUARDIAN_RACE_REAL_PATH;
  const originalRemote = process.env.GUARDIAN_RACE_REMOTE_REPOSITORY;
  const originalBranch = process.env.GUARDIAN_RACE_BRANCH;
  const originalHead = process.env.GUARDIAN_RACE_RECREATED_HEAD;
  await fs.writeFile(path.join(binDir, "git"), `#!/bin/sh
set -eu
if [ "$1" = "-C" ] && [ "$3" = "push" ] && [ "$4" = "origin" ] && [ "$5" = "--force-with-lease=refs/heads/$GUARDIAN_RACE_BRANCH:" ] && [ "$6" = ":refs/heads/$GUARDIAN_RACE_BRANCH" ]; then
  PATH="$GUARDIAN_RACE_REAL_PATH" command git --git-dir "$GUARDIAN_RACE_REMOTE_REPOSITORY" update-ref "refs/heads/$GUARDIAN_RACE_BRANCH" "$GUARDIAN_RACE_RECREATED_HEAD"
fi
PATH="$GUARDIAN_RACE_REAL_PATH" exec git "$@"
`, "utf8");
  await fs.chmod(path.join(binDir, "git"), 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.GUARDIAN_RACE_REAL_PATH = originalPath ?? "";
  process.env.GUARDIAN_RACE_REMOTE_REPOSITORY = remote;
  process.env.GUARDIAN_RACE_BRANCH = branch;
  process.env.GUARDIAN_RACE_RECREATED_HEAD = head;
  t.after(async () => {
    restoreEnvironment("PATH", originalPath);
    restoreEnvironment("GUARDIAN_RACE_REAL_PATH", originalRealPath);
    restoreEnvironment("GUARDIAN_RACE_REMOTE_REPOSITORY", originalRemote);
    restoreEnvironment("GUARDIAN_RACE_BRANCH", originalBranch);
    restoreEnvironment("GUARDIAN_RACE_RECREATED_HEAD", originalHead);
    await fs.rm(binDir, { recursive: true, force: true });
  });

  const apply = workflowResult(await guardianFinishWorkflow({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: reconciliationPlan.confirmToken, timestamp }));
  const state = await readState(await getGuardianPaths(repo), { repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(apply.results[0]?.status, "blocked");
  assert.notEqual(apply.results[0]?.status, "reconciled");
  assert.equal(await remoteBranchExists(repo, branch), true);
  assert.equal((await git(repo, ["rev-parse", "--verify", safetyRef])).stdout, head);
  assert.equal(JSON.stringify(state.remote_branch_cleanup_reservations).includes(branch), true);
});
