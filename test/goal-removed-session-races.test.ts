import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getGuardianPaths, readState, recordSession } from "../src/state.ts";
import { runGuardianTool } from "../src/tools.ts";
import type { RemovedGoalFixture } from "./goal-removed-session-fixtures.ts";
import { closureSnapshot, rejectRemovalPush, removedGoalFixture, requireRecord, requireString } from "./goal-removed-session-fixtures.ts";
import { git } from "./helpers.ts";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const toolsModuleUrl = new URL("../src/tools.ts", import.meta.url).href;
const stateModuleUrl = new URL("../src/state.ts", import.meta.url).href;

async function preparedOwner(fixture: RemovedGoalFixture) {
  const state = await readState(await getGuardianPaths(fixture.repo), { repoRoot: fixture.repo, config: fixture.config });
  const session = requireRecord(state.sessions[fixture.sessionId], "prepared owner");
  const receipt = requireRecord(session.external_goal_completion, "prepared receipt");
  assert.equal(session.status, "active");
  assert.equal(session.started_head_commit, fixture.baseline);
  assert.equal(session.branch, fixture.branch);
  assert.equal(session.worktree_path, fixture.worktree);
  assert.equal(receipt.version, 1);
  assert.equal(receipt.phase, "prepared");
  assert.equal(receipt.session_id, fixture.sessionId);
  assert.equal(receipt.started_head_commit, fixture.baseline);
  assert.equal(receipt.expected_remote_head, fixture.head);
  assert.equal(receipt.landed_base_head, fixture.landedBaseHead);
  const safetyRef = requireString(receipt.safety_ref, "prepared safety ref");
  assert.equal((await git(fixture.repo, ["rev-parse", safetyRef])).stdout, fixture.head);
  assert.equal((await git(fixture.remote, ["rev-parse", `refs/heads/${fixture.branch}`])).stdout, fixture.head);
  assert.deepEqual(state.sessions[fixture.otherId], fixture.otherBefore);
  return { session, receipt, safetyRef };
}

async function prepareByRejectedPush(fixture: RemovedGoalFixture) {
  const hook = await rejectRemovalPush(fixture);
  const plan = requireRecord(await runGuardianTool("guardian_goal", { ...fixture.request, mode: "plan" }), "closure plan");
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const applied = requireRecord(await runGuardianTool("guardian_goal", { ...fixture.request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "closure token") }), "rejected closure");
  assert.equal(applied.ok, false, JSON.stringify(applied));
  assert.notEqual(applied.complete, true, JSON.stringify(applied));
  assert.equal(await fs.readFile(hook.marker, "utf8"), `refs/heads/${fixture.branch}\n`);
  return { ...(await preparedOwner(fixture)), ...hook };
}

test("GC cannot prune an orphan snapshot after a concurrent confirmed Goal durably prepares that session", { skip: process.platform === "win32" }, async (t) => {
  const fixture = await removedGoalFixture(t);
  const hook = await rejectRemovalPush(fixture);
  const gcPlan = requireRecord(await runGuardianTool("guardian_gc", { repoRoot: fixture.repo, cwd: fixture.repo, config: fixture.config, mode: "plan" }), "GC plan");
  assert.equal(gcPlan.ok, true, JSON.stringify(gcPlan));
  assert.equal(gcPlan.status, "planned");
  assert.ok(Array.isArray(gcPlan.candidates) && gcPlan.candidates.some((candidate) => requireRecord(candidate, "GC candidate").session_id === fixture.sessionId));
  const before = await closureSnapshot(fixture);
  const tools = path.join(fixture.base, "gc-race-tools");
  const trigger = path.join(fixture.base, "gc-race-triggered");
  const prepareScript = path.join(fixture.base, "prepare-during-gc.mjs");
  const preparedOutput = path.join(fixture.base, "prepared-during-gc.json");
  const gcOutput = path.join(fixture.base, "gc-race-result.json");
  const { stdout: resolvedGit } = await execFileAsync("/bin/sh", ["-c", "command -v git"], { cwd: projectRoot });
  const realGit = requireString(resolvedGit.trim(), "real Git executable");
  await fs.mkdir(tools);
  await fs.writeFile(prepareScript, `
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { runGuardianTool } from ${JSON.stringify(toolsModuleUrl)};
import { getGuardianPaths, readState } from ${JSON.stringify(stateModuleUrl)};
const request = ${JSON.stringify(fixture.request)};
const plan = await runGuardianTool("guardian_goal", { ...request, mode: "plan" });
assert.equal(plan.ok, true, JSON.stringify(plan));
assert.equal(typeof plan.confirmToken, "string");
const result = await runGuardianTool("guardian_goal", { ...request, mode: "apply", confirm: true, confirmToken: plan.confirmToken });
assert.equal(result.ok, false, JSON.stringify(result));
assert.notEqual(result.complete, true, JSON.stringify(result));
const state = await readState(await getGuardianPaths(request.repoRoot), { repoRoot: request.repoRoot, config: request.config });
const session = state.sessions[request.sessionId];
assert.equal(session?.external_goal_completion?.phase, "prepared");
await fs.writeFile(${JSON.stringify(preparedOutput)}, JSON.stringify({ result, session }));
`, "utf8");
  const wrapper = path.join(tools, "git");
  await fs.writeFile(wrapper, `#!/bin/sh
set -eu
previous=
for argument in "$@"; do
  if [ "$previous" = "worktree" ] && [ "$argument" = "list" ]; then
    if mkdir "$GUARDIAN_RACE_TRIGGER" 2>/dev/null; then
      PATH="$GUARDIAN_RACE_ORIGINAL_PATH" "$GUARDIAN_RACE_NODE" --import tsx "$GUARDIAN_RACE_PREPARE_SCRIPT"
    fi
    break
  fi
  previous="$argument"
done
PATH="$GUARDIAN_RACE_ORIGINAL_PATH" exec "$GUARDIAN_RACE_REAL_GIT" "$@"
`, "utf8");
  await fs.chmod(wrapper, 0o755);
  const gcScript = `
import fs from "node:fs/promises";
import { runGuardianTool } from ${JSON.stringify(toolsModuleUrl)};
const result = await runGuardianTool("guardian_gc", ${JSON.stringify({ repoRoot: fixture.repo, cwd: fixture.repo, config: fixture.config, mode: "apply", confirmDelete: true, confirmToken: requireString(gcPlan.confirmToken, "GC token") })});
await fs.writeFile(${JSON.stringify(gcOutput)}, JSON.stringify(result));
`;
  await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", gcScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PATH: `${tools}${path.delimiter}${process.env.PATH ?? ""}`,
      GUARDIAN_RACE_TRIGGER: trigger,
      GUARDIAN_RACE_ORIGINAL_PATH: process.env.PATH ?? "",
      GUARDIAN_RACE_NODE: process.execPath,
      GUARDIAN_RACE_PREPARE_SCRIPT: prepareScript,
      GUARDIAN_RACE_REAL_GIT: realGit,
    },
    timeout: 45_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal((await fs.stat(trigger)).isDirectory(), true);
  assert.equal(await fs.readFile(hook.marker, "utf8"), `refs/heads/${fixture.branch}\n`);
  const captured = requireRecord(JSON.parse(await fs.readFile(preparedOutput, "utf8")), "concurrent preparation");
  const capturedSession = requireRecord(captured.session, "concurrently prepared session");
  const capturedReceipt = requireRecord(capturedSession.external_goal_completion, "concurrently prepared receipt");
  assert.equal(capturedReceipt.phase, "prepared");
  const gcResult = requireRecord(JSON.parse(await fs.readFile(gcOutput, "utf8")), "GC apply result");
  assert.equal(gcResult.ok, false, JSON.stringify(gcResult));
  const retained = await preparedOwner(fixture);
  assert.deepEqual(retained.receipt, capturedReceipt);
  const atPush = requireRecord(JSON.parse(await fs.readFile(`${hook.marker}.state.json`, "utf8")), "state before rejected deletion");
  const ownerAtPush = requireRecord(requireRecord(atPush.sessions, "sessions before rejected deletion")[fixture.sessionId], "owner before rejected deletion");
  assert.deepEqual(ownerAtPush.external_goal_completion, retained.receipt);
  const after = await closureSnapshot(fixture);
  assert.deepEqual(after.primary, before.primary);
  assert.deepEqual(after.localBranches, before.localBranches);
  assert.deepEqual(after.remoteBranches, before.remoteBranches);
  assert.deepEqual(after.worktrees, before.worktrees);
  assert.deepEqual(after.sessions[fixture.otherId], fixture.otherBefore);
});

test("recordSession cannot replace prepared closure ownership with a stale captured repair record", async (t) => {
  const fixture = await removedGoalFixture(t);
  const paths = await getGuardianPaths(fixture.repo);
  const initial = await readState(paths, { repoRoot: fixture.repo, config: fixture.config });
  const captured = initial.sessions[fixture.sessionId];
  assert.ok(captured);
  const repairBranch = "guardian/stale-captured-repair";
  const repairWorktree = path.join(path.dirname(fixture.worktree), "stale-captured-repair");
  await git(fixture.repo, ["worktree", "add", "-b", repairBranch, repairWorktree, fixture.head]);
  const staleRepair = {
    ...captured,
    branch: repairBranch,
    worktree_path: repairWorktree,
    started_head_commit: fixture.head,
  };
  const prepared = await prepareByRejectedPush(fixture);
  const before = await closureSnapshot(fixture);
  await assert.rejects(() => recordSession(fixture.repo, fixture.config, staleRepair));
  assert.deepEqual(await closureSnapshot(fixture), before);
  const retained = await preparedOwner(fixture);
  assert.deepEqual(retained.receipt, prepared.receipt);
  assert.equal(retained.session.started_head_commit, captured.started_head_commit);
  assert.equal(retained.session.branch, captured.branch);
  assert.equal(retained.session.worktree_path, captured.worktree_path);
  assert.equal((await git(repairWorktree, ["rev-parse", "HEAD"])).stdout, fixture.head);
  assert.equal(await fs.readFile(path.join(repairWorktree, "delivered.txt"), "utf8"), "owned implementation\n");
});

test("prepared closure reserves its source branch against another session during the actual deletion push", { skip: process.platform === "win32" }, async (t) => {
  const fixture = await removedGoalFixture(t);
  const claimantId = "claim-during-prepared-deletion";
  const claimantRoot = path.join(fixture.base, "claimant-managed");
  const claimantConfig = { ...fixture.config, worktreeRoot: claimantRoot };
  const claimantOutput = path.join(fixture.base, "claim-during-push.json");
  const claimantScript = path.join(fixture.base, "claim-during-push.mjs");
  const hooks = path.join(fixture.base, "claim-during-push-hooks");
  const hook = path.join(hooks, "pre-push");
  await fs.mkdir(hooks);
  await fs.writeFile(claimantScript, `
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { runGuardianTool } from ${JSON.stringify(toolsModuleUrl)};
import { getGuardianPaths, readState } from ${JSON.stringify(stateModuleUrl)};
const owner = ${JSON.stringify(fixture.request)};
const state = await readState(await getGuardianPaths(owner.repoRoot), { repoRoot: owner.repoRoot, config: owner.config });
const session = state.sessions[owner.sessionId];
assert.equal(session?.external_goal_completion?.phase, "prepared");
const result = await runGuardianTool("guardian_start", ${JSON.stringify({ repoRoot: fixture.repo, cwd: fixture.repo, config: claimantConfig, sessionId: claimantId, branch: fixture.branch, createWorktree: true, taskName: "claim source during closure" })});
await fs.writeFile(${JSON.stringify(claimantOutput)}, JSON.stringify({ result, prepared: session.external_goal_completion }));
`, "utf8");
  const invokeClaimant = [process.execPath, "--import", import.meta.resolve("tsx"), claimantScript]
    .map((argument) => `'${argument.replaceAll("'", "'\\''")}'`).join(" ");
  await fs.writeFile(hook, `#!/bin/sh
set -eu
while read -r local_ref _local_sha remote_ref _remote_sha; do
  if [ "$local_ref" = "(delete)" ] && [ "$remote_ref" = "refs/heads/${fixture.branch}" ]; then
    ${invokeClaimant}
  fi
done
exit 0
`, "utf8");
  await fs.chmod(hook, 0o755);
  await git(fixture.repo, ["config", "core.hooksPath", hooks]);
  const before = await closureSnapshot(fixture);
  const plan = requireRecord(await runGuardianTool("guardian_goal", { ...fixture.request, mode: "plan" }), "closure plan");
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const applied = requireRecord(await runGuardianTool("guardian_goal", { ...fixture.request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "closure token") }), "closure apply");
  const attempt = requireRecord(JSON.parse(await fs.readFile(claimantOutput, "utf8")), "claimant attempt during deletion");
  const claimant = requireRecord(attempt.result, "claimant start result");
  const prepared = requireRecord(attempt.prepared, "receipt before claimant start");
  assert.equal(prepared.phase, "prepared");
  assert.equal(prepared.session_id, fixture.sessionId);
  assert.equal(claimant.ok, false, JSON.stringify(claimant));
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.complete, true, JSON.stringify(applied));
  assert.deepEqual(applied.scope, { kind: "session", sessionId: fixture.sessionId });
  const after = await closureSnapshot(fixture);
  const owner = requireRecord(after.sessions[fixture.sessionId], "completed owner");
  const receipt = requireRecord(owner.external_goal_completion, "completed receipt");
  assert.equal(owner.started_head_commit, fixture.baseline);
  assert.equal(owner.branch, fixture.branch);
  assert.equal(owner.worktree_path, fixture.worktree);
  assert.equal(owner.status, "deleted");
  assert.equal(receipt.phase, "complete");
  assert.equal(receipt.safety_ref, prepared.safety_ref);
  assert.equal((await git(fixture.repo, ["rev-parse", requireString(receipt.safety_ref, "completion safety ref")])).stdout, fixture.head);
  assert.equal(after.sessions[claimantId], undefined);
  assert.deepEqual(after.sessions[fixture.otherId], fixture.otherBefore);
  assert.deepEqual(after.primary, before.primary);
  assert.deepEqual(after.localBranches, before.localBranches);
  assert.deepEqual(after.worktrees, before.worktrees);
  assert.equal((await git(fixture.repo, ["ls-remote", "--heads", "origin", fixture.branch])).stdout, "");
  assert.equal((await git(fixture.remote, ["rev-parse", "refs/heads/main"])).stdout, fixture.landedBaseHead);
  assert.equal((await git(fixture.remote, ["rev-parse", `refs/heads/${fixture.otherBranch}`])).stdout, fixture.landedBaseHead);
  const claimantEntries = await fs.readdir(claimantRoot, { recursive: true }).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  assert.equal(claimantEntries.some((entry) => path.basename(entry) === ".git"), false);
});

test("completion readback rechecks local absence after the real final remote observation", { skip: process.platform === "win32" }, async (t) => {
  const fixture = await removedGoalFixture(t);
  const plan = requireRecord(await runGuardianTool("guardian_goal", { ...fixture.request, mode: "plan" }), "closure plan");
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const applied = requireRecord(await runGuardianTool("guardian_goal", { ...fixture.request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "closure token") }), "closure apply");
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.complete, true, JSON.stringify(applied));
  const before = await closureSnapshot(fixture);
  const tools = path.join(fixture.base, "readback-race-tools");
  const trigger = path.join(fixture.base, "readback-race-triggered");
  const readbackOutput = path.join(fixture.base, "readback-race-result.json");
  const { stdout: resolvedGit } = await execFileAsync("/bin/sh", ["-c", "command -v git"], { cwd: projectRoot });
  const realGit = requireString(resolvedGit.trim(), "real Git executable");
  await fs.mkdir(tools);
  const wrapper = path.join(tools, "git");
  await fs.writeFile(wrapper, `#!/bin/sh
set -eu
is_remote_observation=false
is_owned_branch=false
for argument in "$@"; do
  if [ "$argument" = "ls-remote" ]; then is_remote_observation=true; fi
  if [ "$argument" = "$GUARDIAN_RACE_BRANCH" ] || [ "$argument" = "refs/heads/$GUARDIAN_RACE_BRANCH" ]; then is_owned_branch=true; fi
done
if [ "$is_remote_observation" = true ] && [ "$is_owned_branch" = true ]; then
  set +e
  PATH="$GUARDIAN_RACE_ORIGINAL_PATH" "$GUARDIAN_RACE_REAL_GIT" "$@"
  observation_status=$?
  set -e
  if [ "$observation_status" -eq 0 ] && mkdir "$GUARDIAN_RACE_TRIGGER" 2>/dev/null; then
    PATH="$GUARDIAN_RACE_ORIGINAL_PATH" "$GUARDIAN_RACE_REAL_GIT" -C "$GUARDIAN_RACE_REPO" branch "$GUARDIAN_RACE_BRANCH" "$GUARDIAN_RACE_NEW_HEAD"
  fi
  exit "$observation_status"
fi
PATH="$GUARDIAN_RACE_ORIGINAL_PATH" exec "$GUARDIAN_RACE_REAL_GIT" "$@"
`, "utf8");
  await fs.chmod(wrapper, 0o755);
  const readbackScript = `
import fs from "node:fs/promises";
import { runGuardianTool } from ${JSON.stringify(toolsModuleUrl)};
const result = await runGuardianTool("guardian_goal", ${JSON.stringify({ ...fixture.request, mode: "plan" })});
await fs.writeFile(${JSON.stringify(readbackOutput)}, JSON.stringify(result));
`;
  await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", readbackScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PATH: `${tools}${path.delimiter}${process.env.PATH ?? ""}`,
      GUARDIAN_RACE_TRIGGER: trigger,
      GUARDIAN_RACE_ORIGINAL_PATH: process.env.PATH ?? "",
      GUARDIAN_RACE_REAL_GIT: realGit,
      GUARDIAN_RACE_REPO: fixture.repo,
      GUARDIAN_RACE_BRANCH: fixture.branch,
      GUARDIAN_RACE_NEW_HEAD: fixture.baseline,
    },
    timeout: 45_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal((await fs.stat(trigger)).isDirectory(), true);
  const readback = requireRecord(JSON.parse(await fs.readFile(readbackOutput, "utf8")), "raced completion readback");
  assert.equal(readback.ok, false, JSON.stringify(readback));
  assert.notEqual(readback.complete, true, JSON.stringify(readback));
  assert.equal((await git(fixture.repo, ["rev-parse", `refs/heads/${fixture.branch}`])).stdout, fixture.baseline);
  const after = await closureSnapshot(fixture);
  assert.deepEqual(after.sessions, before.sessions);
  assert.deepEqual(after.primary, before.primary);
  assert.deepEqual(after.remoteBranches, before.remoteBranches);
  assert.deepEqual(after.safetyRefs, before.safetyRefs);
  assert.deepEqual(after.worktrees, before.worktrees);
});

test("recordSession cannot claim a prepared source branch for a new session at a different managed path", async (t) => {
  const fixture = await removedGoalFixture(t);
  const initial = await readState(await getGuardianPaths(fixture.repo), { repoRoot: fixture.repo, config: fixture.config });
  const captured = initial.sessions[fixture.sessionId];
  assert.ok(captured);
  assert.equal(captured.external_goal_completion, undefined);
  const claimantId = "stale-new-session-branch-claim";
  const claimantPath = path.join(path.dirname(fixture.worktree), "stale-new-session-branch-claim");
  const staleClaim = {
    ...captured,
    session_id: claimantId,
    worktree_path: claimantPath,
  };
  const prepared = await prepareByRejectedPush(fixture);
  const before = await closureSnapshot(fixture);
  await assert.rejects(() => recordSession(fixture.repo, fixture.config, staleClaim));
  const after = await closureSnapshot(fixture);
  assert.deepEqual(after, before);
  assert.equal(after.sessions[claimantId], undefined);
  const retained = await preparedOwner(fixture);
  assert.deepEqual(retained.receipt, prepared.receipt);
  assert.equal(retained.session.started_head_commit, captured.started_head_commit);
  assert.equal(retained.session.branch, captured.branch);
  assert.equal(retained.session.worktree_path, captured.worktree_path);
});

test("rejecting a reserved-branch claim does not recreate its prepared owner's absent worktree root", async (t) => {
  const fixture = await removedGoalFixture(t);
  const prepared = await prepareByRejectedPush(fixture);
  await assert.rejects(() => fs.lstat(fixture.worktree), { code: "ENOENT" });
  const before = await closureSnapshot(fixture);
  const paths = await getGuardianPaths(fixture.repo);
  const stateBefore = await readState(paths, { repoRoot: fixture.repo, config: fixture.config });
  const claimantId = "claim-reserved-branch-with-owner-root";
  const claimantConfig = { ...fixture.config, worktreeRoot: fixture.worktree };
  const claimant = requireRecord(await runGuardianTool("guardian_start", {
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    config: claimantConfig,
    sessionId: claimantId,
    branch: fixture.branch,
    createWorktree: true,
    taskName: "claim prepared branch with owner root",
  }), "reserved branch claimant");
  assert.equal(claimant.ok, false, JSON.stringify(claimant));
  await assert.rejects(() => fs.lstat(fixture.worktree), { code: "ENOENT" });
  const afterClaim = await closureSnapshot(fixture);
  assert.deepEqual(afterClaim, before);
  assert.deepEqual(await readState(paths, { repoRoot: fixture.repo, config: fixture.config }), stateBefore);
  assert.equal(afterClaim.sessions[claimantId], undefined);
  await fs.rm(prepared.hook);
  const retryPlan = requireRecord(await runGuardianTool("guardian_goal", { ...fixture.request, mode: "plan" }), "exact-proof retry plan");
  assert.equal(retryPlan.ok, true, JSON.stringify(retryPlan));
  const retried = requireRecord(await runGuardianTool("guardian_goal", {
    ...fixture.request,
    mode: "apply",
    confirm: true,
    confirmToken: requireString(retryPlan.confirmToken, "retry token"),
  }), "exact-proof retry");
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(retried.complete, true, JSON.stringify(retried));
  assert.deepEqual(retried.scope, { kind: "session", sessionId: fixture.sessionId });
  const afterRetry = await closureSnapshot(fixture);
  const owner = requireRecord(afterRetry.sessions[fixture.sessionId], "retried owner");
  const receipt = requireRecord(owner.external_goal_completion, "retried receipt");
  assert.equal(owner.status, "deleted");
  assert.equal(owner.started_head_commit, fixture.baseline);
  assert.equal(owner.branch, fixture.branch);
  assert.equal(owner.worktree_path, fixture.worktree);
  assert.equal(receipt.phase, "complete");
  assert.equal(receipt.safety_ref, prepared.safetyRef);
  assert.equal(receipt.prepared_at, prepared.receipt.prepared_at);
  await assert.rejects(() => fs.lstat(fixture.worktree), { code: "ENOENT" });
  assert.deepEqual(afterRetry.primary, before.primary);
  assert.deepEqual(afterRetry.localBranches, before.localBranches);
  assert.deepEqual(afterRetry.worktrees, before.worktrees);
  assert.deepEqual(afterRetry.safetyRefs, before.safetyRefs);
  assert.deepEqual(afterRetry.sessions[fixture.otherId], fixture.otherBefore);
  assert.equal(afterRetry.sessions[claimantId], undefined);
  assert.equal((await git(fixture.repo, ["ls-remote", "--heads", "origin", fixture.branch])).stdout, "");
  assert.equal((await git(fixture.remote, ["rev-parse", "refs/heads/main"])).stdout, fixture.landedBaseHead);
  assert.equal((await git(fixture.remote, ["rev-parse", `refs/heads/${fixture.otherBranch}`])).stdout, fixture.landedBaseHead);
});

test("a fresh branch cannot create a worktree anywhere under a prepared owner's absent path", async (t) => {
  const fixture = await removedGoalFixture(t);
  const prepared = await prepareByRejectedPush(fixture);
  await assert.rejects(() => fs.lstat(fixture.worktree), { code: "ENOENT" });
  const before = await closureSnapshot(fixture);
  const paths = await getGuardianPaths(fixture.repo);
  const stateBefore = await readState(paths, { repoRoot: fixture.repo, config: fixture.config });
  const claimantId = "claim-prepared-path-subtree";
  const claimantConfig = { ...fixture.config, worktreeRoot: path.join(fixture.worktree, "..nested-root") };
  const claimant = requireRecord(await runGuardianTool("guardian_start", {
    repoRoot: fixture.repo,
    cwd: fixture.repo,
    config: claimantConfig,
    sessionId: claimantId,
    branch: "guardian/fresh-prepared-subtree-claim",
    createWorktree: true,
    taskName: "claim beneath prepared owner path",
  }), "prepared subtree claimant");
  assert.equal(claimant.ok, false, JSON.stringify(claimant));
  await assert.rejects(() => fs.lstat(fixture.worktree), { code: "ENOENT" });
  const after = await closureSnapshot(fixture);
  assert.deepEqual(after, before);
  assert.deepEqual(await readState(paths, { repoRoot: fixture.repo, config: fixture.config }), stateBefore);
  assert.equal(after.sessions[claimantId], undefined);
  const retained = await preparedOwner(fixture);
  assert.deepEqual(retained.receipt, prepared.receipt);
});
