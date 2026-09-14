import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CONFIG_PATH, DEFAULT_CONFIG } from "../src/config.ts";
import plugin from "../src/index.ts";
import { guardianDeleteRemoteBranch } from "../src/delete-remote-branch.ts";
import { buildSafetyRef, createSafetyRef } from "../src/git.ts";
import { getGuardianPaths, readState } from "../src/state.ts";
import { reserveRemoteBranchCleanupSafetyRef } from "../src/state-remote-branch-reservation.ts";
import { createToolContext, runTool } from "./plugin-contract-helpers.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

async function createRemoteBranch(repo: string, branch: string): Promise<string> {
  await git(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, `${branch.replaceAll("/", "-")}.txt`), `${branch}\n`);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", `add ${branch}`]);
  const { stdout: head } = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["checkout", "main"]);
  await git(repo, ["branch", "-D", branch]);
  await git(repo, ["fetch", "origin"]);
  return head;
}

async function remoteBranchExists(repo: string, branch: string): Promise<boolean> {
  return (await git(repo, ["ls-remote", "--heads", "origin", branch])).stdout.length > 0;
}

async function writeGuardianConfig(repo: string, config: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, CONFIG_PATH), `${JSON.stringify(config)}\n`);
}

function hasReservation(state: Record<string, unknown>, safetyRef: string): boolean {
  const reservations = state.remote_branch_cleanup_reservations;
  return Array.isArray(reservations) && reservations.some((entry) => entry !== null
    && typeof entry === "object"
    && "safety_ref" in entry
    && entry.safety_ref === safetyRef);
}

test("guardian_delete_remote_branch deletes only an explicitly approved nonancestor branch through the native tool", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/explicit-squash-equivalent";
  const head = await createRemoteBranch(repo, branch);
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context, metadataCalls } = createToolContext();
  context.directory = repo;
  context.worktree = repo;

  const plan = await runTool(hooks.tool.guardian_delete_remote_branch.execute, {
    repoRoot: repo,
    cwd: repo,
    mode: "plan",
    remote: "origin",
    remoteBranch: branch,
    expectedRemoteHead: head,
    allowNonAncestorRemoteDeletion: true,
  }, context);

  assert.equal(plan.title, "guardian_delete_remote_branch");
  assert.equal(plan.metadata.status, "planned");
  assert.equal(plan.metadata.preflight.remoteBranch, branch);
  assert.equal(plan.metadata.preflight.expectedRemoteHead, head);
  assert.equal(typeof plan.metadata.confirmToken, "string");
  assert.deepEqual(metadataCalls, [{ title: "guardian_delete_remote_branch" }]);

  const apply = await runTool(hooks.tool.guardian_delete_remote_branch.execute, {
    repoRoot: repo,
    cwd: repo,
    mode: "apply",
    confirm: true,
    confirmToken: plan.metadata.confirmToken,
    remote: "origin",
    remoteBranch: branch,
    expectedRemoteHead: head,
    allowNonAncestorRemoteDeletion: true,
  }, context);

  assert.equal(apply.metadata.status, "deleted");
  assert.equal(apply.metadata.remoteBranchDeleted, true);
  assert.equal(await remoteBranchExists(repo, branch), false);
  assert.equal((await git(repo, ["rev-parse", String(apply.metadata.safetyRef)])).stdout, head);
});

test("guardian_delete_remote_branch denies nonancestor deletion without its explicit override", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/default-nonancestor-denial";
  const head = await createRemoteBranch(repo, branch);

  const plan = await guardianDeleteRemoteBranch({
    repoRoot: repo,
    cwd: repo,
    mode: "plan",
    remote: "origin",
    remoteBranch: branch,
    expectedRemoteHead: head,
  });

  assert.equal(plan.status, "blocked");
  assert.match(String(plan.reason), /allowNonAncestorRemoteDeletion=true/);
  assert.equal(await remoteBranchExists(repo, branch), true);
});

test("guardian_delete_remote_branch protects configured and base branches", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const { stdout: head } = await git(repo, ["rev-parse", "origin/main"]);

  const plan = await guardianDeleteRemoteBranch({
    repoRoot: repo,
    cwd: repo,
    mode: "plan",
    remote: "origin",
    remoteBranch: "main",
    expectedRemoteHead: head,
    allowNonAncestorRemoteDeletion: true,
  });

  assert.equal(plan.status, "blocked");
  assert.match(String(plan.reason), /protected/);
  assert.equal(await remoteBranchExists(repo, "main"), true);
});

test("guardian_delete_remote_branch rejects stale tokens before creating a safety ref", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/stale-remote-delete-token";
  const head = await createRemoteBranch(repo, branch);
  const plan = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "plan", remote: "origin", remoteBranch: branch, expectedRemoteHead: head, allowNonAncestorRemoteDeletion: true });

  const apply = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: "stale", remote: "origin", remoteBranch: branch, expectedRemoteHead: head, allowNonAncestorRemoteDeletion: true });

  assert.equal(plan.status, "planned");
  assert.equal(apply.status, "blocked");
  assert.match(String(apply.reason), /confirm token mismatch/);
  assert.equal(await remoteBranchExists(repo, branch), true);
});

test("guardian_delete_remote_branch rejects a changed remote head with its expected-head lease still intact", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/changed-remote-delete-head";
  const head = await createRemoteBranch(repo, branch);
  const plan = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "plan", remote: "origin", remoteBranch: branch, expectedRemoteHead: head, allowNonAncestorRemoteDeletion: true });
  await git(repo, ["checkout", "-b", branch, head]);
  await fs.writeFile(path.join(repo, "changed-remote-delete-head-later.txt"), "later\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "advance remote branch"]);
  await git(repo, ["push", "origin", branch]);
  await git(repo, ["checkout", "main"]);
  await git(repo, ["branch", "-D", branch]);

  const apply = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken, remote: "origin", remoteBranch: branch, expectedRemoteHead: head, allowNonAncestorRemoteDeletion: true });

  assert.equal(apply.status, "blocked");
  assert.match(String(apply.reason), /no longer matches expectedRemoteHead/);
  assert.equal(await remoteBranchExists(repo, branch), true);
});

test("guardian_delete_remote_branch preserves the remote branch when durable safety-ref creation fails", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/remote-delete-safety-ref-failure";
  const head = await createRemoteBranch(repo, branch);
  const timestamp = "20260914T120000";
  const plan = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "plan", remote: "origin", remoteBranch: branch, expectedRemoteHead: head, allowNonAncestorRemoteDeletion: true, timestamp });
  const otherHead = (await git(repo, ["commit-tree", `${head}^{tree}`, "-p", head, "-m", "different safety ref target"])).stdout;
  const safetyRef = buildSafetyRef("remote-branch-cleanup", `origin/${branch}`, timestamp);
  await createSafetyRef(repo, { sessionId: "remote-branch-cleanup", branch: `origin/${branch}`, commit: otherHead, ref: safetyRef });

  const apply = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken, remote: "origin", remoteBranch: branch, expectedRemoteHead: head, allowNonAncestorRemoteDeletion: true, timestamp });

  assert.equal(apply.status, "blocked");
  assert.equal(await remoteBranchExists(repo, branch), true);
  assert.equal((await git(repo, ["rev-parse", safetyRef])).stdout, otherHead);
});

test("guardian_delete_remote_branch always uses repo-local authority and protects configured and rescue branches", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const protectedBranch = "release/configured-protected";
  const protectedHead = await createRemoteBranch(repo, protectedBranch);
  const rescueBranch = "rescue/retained-evidence";
  const rescueHead = await createRemoteBranch(repo, rescueBranch);
  await writeGuardianConfig(repo, { protectedBranches: [protectedBranch] });

  const injectedConfig = { ...DEFAULT_CONFIG, remote: "attacker", protectedBranches: [] };
  const configuredProtected = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "plan", remote: "origin", remoteBranch: protectedBranch, expectedRemoteHead: protectedHead, allowNonAncestorRemoteDeletion: true, config: injectedConfig });
  const rescue = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "plan", remote: "origin", remoteBranch: rescueBranch, expectedRemoteHead: rescueHead, allowNonAncestorRemoteDeletion: true, config: injectedConfig });
  const wrongRemote = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "plan", remote: "attacker", remoteBranch: protectedBranch, expectedRemoteHead: protectedHead, allowNonAncestorRemoteDeletion: true, config: injectedConfig });

  assert.match(String(configuredProtected.reason), /protected/);
  assert.match(String(rescue.reason), /protected or reserved/);
  assert.match(String(wrongRemote.reason), /resolved Guardian remote authority/);
  assert.equal(await remoteBranchExists(repo, protectedBranch), true);
  assert.equal(await remoteBranchExists(repo, rescueBranch), true);
});

test("guardian_delete_remote_branch deletes only the exact target and leaves sibling branches untouched", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/exact-target";
  const sibling = "guardian/untouched-sibling";
  const head = await createRemoteBranch(repo, branch);
  await createRemoteBranch(repo, sibling);
  const plan = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "plan", remote: "origin", remoteBranch: branch, expectedRemoteHead: head, allowNonAncestorRemoteDeletion: true });
  const apply = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken, remote: "origin", remoteBranch: branch, expectedRemoteHead: head, allowNonAncestorRemoteDeletion: true });

  assert.equal(apply.status, "deleted");
  assert.equal(await remoteBranchExists(repo, branch), false);
  assert.equal(await remoteBranchExists(repo, sibling), true);
});

test("guardian_delete_remote_branch preserves an advanced remote branch when its push lease loses immediately before push", async (t) => {
  const { base, remote, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/lease-race";
  const head = await createRemoteBranch(repo, branch);
  await git(repo, ["checkout", "-b", branch, head]);
  await fs.writeFile(path.join(repo, "lease-race-later.txt"), "later\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "advance lease race branch"]);
  const advancedHead = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  await git(repo, ["push", "origin", `${advancedHead}:refs/heads/guardian/lease-race-object`]);
  await git(repo, ["push", "origin", ":refs/heads/guardian/lease-race-object"]);
  await git(repo, ["checkout", "main"]);
  await git(repo, ["branch", "-D", branch]);
  const plan = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "plan", remote: "origin", remoteBranch: branch, expectedRemoteHead: head, allowNonAncestorRemoteDeletion: true });
  const binDir = path.join(base, "git-lease-race-bin");
  await fs.mkdir(binDir);
  const originalPath = process.env.PATH;
  const originalRemote = process.env.GUARDIAN_RACE_REMOTE_REPOSITORY;
  const originalBranch = process.env.GUARDIAN_RACE_BRANCH;
  const originalHead = process.env.GUARDIAN_RACE_RECREATED_HEAD;
  await fs.writeFile(path.join(binDir, "git"), `#!/bin/sh
set -eu
if [ "$1" = "-C" ] && [ "$3" = "push" ] && [ "$4" = "origin" ]; then
  PATH="$GUARDIAN_RACE_REAL_PATH" command git --git-dir "$GUARDIAN_RACE_REMOTE_REPOSITORY" update-ref "refs/heads/$GUARDIAN_RACE_BRANCH" "$GUARDIAN_RACE_RECREATED_HEAD"
fi
PATH="$GUARDIAN_RACE_REAL_PATH" exec git "$@"
`);
  await fs.chmod(path.join(binDir, "git"), 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.GUARDIAN_RACE_REAL_PATH = originalPath ?? "";
  process.env.GUARDIAN_RACE_REMOTE_REPOSITORY = remote;
  process.env.GUARDIAN_RACE_BRANCH = branch;
  process.env.GUARDIAN_RACE_EXPECTED_HEAD = head;
  process.env.GUARDIAN_RACE_RECREATED_HEAD = advancedHead;
  t.after(async () => {
    process.env.PATH = originalPath;
    process.env.GUARDIAN_RACE_REMOTE_REPOSITORY = originalRemote;
    process.env.GUARDIAN_RACE_BRANCH = originalBranch;
    process.env.GUARDIAN_RACE_RECREATED_HEAD = originalHead;
    delete process.env.GUARDIAN_RACE_EXPECTED_HEAD;
  });

  const apply = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken, remote: "origin", remoteBranch: branch, expectedRemoteHead: head, allowNonAncestorRemoteDeletion: true });

  assert.equal(apply.status, "blocked");
  assert.equal((await git(repo, ["ls-remote", "--heads", "origin", branch])).stdout.split("\t")[0], advancedHead);
});

test("remote cleanup safety-ref reservation reuses one exact durable reservation under concurrent calls", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const head = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  const input = { repoRoot: repo, config: DEFAULT_CONFIG, remote: "origin", remoteBranch: "guardian/concurrent-reservation", head, safetyRef: buildSafetyRef("remote-branch-cleanup", "origin/guardian/concurrent-reservation", head) };
  const reservations = await Promise.all([reserveRemoteBranchCleanupSafetyRef(input), reserveRemoteBranchCleanupSafetyRef(input)]);
  const state = await readState(await getGuardianPaths(repo), { repoRoot: repo, config: DEFAULT_CONFIG });

  assert.deepEqual(reservations.map((entry) => entry.reservation.safety_ref), [input.safetyRef, input.safetyRef]);
  assert.equal(Array.isArray(state.remote_branch_cleanup_reservations) && state.remote_branch_cleanup_reservations.filter((entry) => entry.remote_branch === input.remoteBranch).length, 1);
  assert.equal((await git(repo, ["rev-parse", input.safetyRef])).stdout, head);
});

test("guardian_delete_remote_branch reports post-push fetch failure as indeterminate and reconciles only its durable reservation", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/post-push-fetch-failure";
  const head = await createRemoteBranch(repo, branch);
  const timestamp = "20260914T131313";
  const plan = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "plan", remote: "origin", remoteBranch: branch, expectedRemoteHead: head, allowNonAncestorRemoteDeletion: true, timestamp });
  const binDir = path.join(base, "git-post-push-fetch-failure-bin");
  const marker = path.join(binDir, "push-completed");
  await fs.mkdir(binDir);
  const originalPath = process.env.PATH;
  await fs.writeFile(path.join(binDir, "git"), `#!/bin/sh
set -eu
if [ "$1" = "-C" ] && [ "$3" = "push" ] && [ "$4" = "origin" ]; then
  : > "$GUARDIAN_POST_PUSH_MARKER"
fi
if [ -f "$GUARDIAN_POST_PUSH_MARKER" ] && [ "$1" = "-C" ] && [ "$3" = "fetch" ] && [ "$4" = "--prune" ] && [ "$5" = "origin" ]; then
  exit 91
fi
PATH="$GUARDIAN_POST_PUSH_REAL_PATH" exec git "$@"
`);
  await fs.chmod(path.join(binDir, "git"), 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.GUARDIAN_POST_PUSH_MARKER = marker;
  process.env.GUARDIAN_POST_PUSH_REAL_PATH = originalPath ?? "";
  t.after(() => {
    process.env.PATH = originalPath;
    delete process.env.GUARDIAN_POST_PUSH_MARKER;
    delete process.env.GUARDIAN_POST_PUSH_REAL_PATH;
  });

  const indeterminate = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken, remote: "origin", remoteBranch: branch, expectedRemoteHead: head, allowNonAncestorRemoteDeletion: true, timestamp });
  const safetyRef = buildSafetyRef("remote-branch-cleanup", `origin/${branch}`, timestamp);
  const retained = await readState(await getGuardianPaths(repo), { repoRoot: repo, config: DEFAULT_CONFIG });
  process.env.PATH = originalPath;

  assert.equal(indeterminate.status, "indeterminate");
  assert.equal(indeterminate.remoteBranchDeleted, null);
  assert.equal(await remoteBranchExists(repo, branch), false);
  assert.equal(hasReservation(retained, safetyRef), true);
  const retryPlan = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "plan", remote: "origin", remoteBranch: branch, expectedRemoteHead: head, allowNonAncestorRemoteDeletion: true, timestamp });
  const retry = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: retryPlan.confirmToken, remote: "origin", remoteBranch: branch, expectedRemoteHead: head, allowNonAncestorRemoteDeletion: true, timestamp });

  assert.equal(retryPlan.status, "planned");
  assert.equal(retry.status, "reconciled");
  assert.equal(hasReservation(await readState(await getGuardianPaths(repo), { repoRoot: repo, config: DEFAULT_CONFIG }), safetyRef), false);
});

test("guardian_delete_remote_branch reports post-push state failure and reconciles after persistence recovery", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/post-push-state-failure";
  const head = await createRemoteBranch(repo, branch);
  const timestamp = "20260914T141414";
  const plan = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "plan", remote: "origin", remoteBranch: branch, expectedRemoteHead: head, allowNonAncestorRemoteDeletion: true, timestamp });
  const guardianPaths = await getGuardianPaths(repo);
  const binDir = path.join(base, "git-post-push-state-failure-bin");
  const marker = path.join(binDir, "push-completed");
  await fs.mkdir(binDir);
  const originalPath = process.env.PATH;
  await fs.writeFile(path.join(binDir, "git"), `#!/bin/sh
set -eu
if [ "$1" = "-C" ] && [ "$3" = "push" ] && [ "$4" = "origin" ]; then
  : > "$GUARDIAN_POST_PUSH_MARKER"
fi
if [ -f "$GUARDIAN_POST_PUSH_MARKER" ] && [ "$1" = "-C" ] && [ "$3" = "fetch" ] && [ "$4" = "--prune" ] && [ "$5" = "origin" ]; then
  rm -f "$GUARDIAN_POST_PUSH_EVENTS"
  ln -s "$GUARDIAN_POST_PUSH_EVENTS.missing" "$GUARDIAN_POST_PUSH_EVENTS"
fi
PATH="$GUARDIAN_POST_PUSH_REAL_PATH" exec git "$@"
`);
  await fs.chmod(path.join(binDir, "git"), 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.GUARDIAN_POST_PUSH_MARKER = marker;
  process.env.GUARDIAN_POST_PUSH_EVENTS = guardianPaths.eventsPath;
  process.env.GUARDIAN_POST_PUSH_REAL_PATH = originalPath ?? "";
  t.after(() => {
    process.env.PATH = originalPath;
    delete process.env.GUARDIAN_POST_PUSH_MARKER;
    delete process.env.GUARDIAN_POST_PUSH_EVENTS;
    delete process.env.GUARDIAN_POST_PUSH_REAL_PATH;
  });

  const pending = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken, remote: "origin", remoteBranch: branch, expectedRemoteHead: head, allowNonAncestorRemoteDeletion: true, timestamp });
  const safetyRef = buildSafetyRef("remote-branch-cleanup", `origin/${branch}`, timestamp);
  const retained = await readState(await getGuardianPaths(repo), { repoRoot: repo, config: DEFAULT_CONFIG });
  process.env.PATH = originalPath;
  await fs.unlink(guardianPaths.eventsPath);

  assert.equal(pending.status, "deleted-pending-reconciliation");
  assert.equal(pending.remoteBranchDeleted, true);
  assert.equal(await remoteBranchExists(repo, branch), false);
  assert.equal(hasReservation(retained, safetyRef), true);
  const retryPlan = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "plan", remote: "origin", remoteBranch: branch, expectedRemoteHead: head, allowNonAncestorRemoteDeletion: true, timestamp });
  const retry = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: retryPlan.confirmToken, remote: "origin", remoteBranch: branch, expectedRemoteHead: head, allowNonAncestorRemoteDeletion: true, timestamp });

  assert.equal(retry.status, "reconciled");
  assert.equal(hasReservation(await readState(await getGuardianPaths(repo), { repoRoot: repo, config: DEFAULT_CONFIG }), safetyRef), false);
});

test("guardian_delete_remote_branch preserves ambiguous recovery when the leased push completes but its wrapper exits nonzero", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const branch = "guardian/push-completed-wrapper-failure";
  const head = await createRemoteBranch(repo, branch);
  const timestamp = "20260914T151515";
  const plan = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "plan", remote: "origin", remoteBranch: branch, expectedRemoteHead: head, allowNonAncestorRemoteDeletion: true, timestamp });
  const binDir = path.join(base, "git-push-completed-wrapper-failure-bin");
  await fs.mkdir(binDir);
  const originalPath = process.env.PATH;
  await fs.writeFile(path.join(binDir, "git"), `#!/bin/sh
set -eu
if [ "$1" = "-C" ] && [ "$3" = "push" ] && [ "$4" = "origin" ]; then
  PATH="$GUARDIAN_WRAPPER_REAL_PATH" command git "$@"
  exit 91
fi
PATH="$GUARDIAN_WRAPPER_REAL_PATH" exec git "$@"
`);
  await fs.chmod(path.join(binDir, "git"), 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.GUARDIAN_WRAPPER_REAL_PATH = originalPath ?? "";
  t.after(() => {
    process.env.PATH = originalPath;
    delete process.env.GUARDIAN_WRAPPER_REAL_PATH;
  });

  const indeterminate = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: plan.confirmToken, remote: "origin", remoteBranch: branch, expectedRemoteHead: head, allowNonAncestorRemoteDeletion: true, timestamp });
  const safetyRef = buildSafetyRef("remote-branch-cleanup", `origin/${branch}`, timestamp);
  const retained = await readState(await getGuardianPaths(repo), { repoRoot: repo, config: DEFAULT_CONFIG });
  process.env.PATH = originalPath;

  assert.equal(indeterminate.status, "indeterminate");
  assert.equal(indeterminate.remoteBranchDeleted, null);
  assert.equal(indeterminate.recoveryRequired, true);
  assert.equal(await remoteBranchExists(repo, branch), false);
  assert.equal(hasReservation(retained, safetyRef), true);
  const retryPlan = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "plan", remote: "origin", remoteBranch: branch, expectedRemoteHead: head, allowNonAncestorRemoteDeletion: true, timestamp });
  const retry = await guardianDeleteRemoteBranch({ repoRoot: repo, cwd: repo, mode: "apply", confirm: true, confirmToken: retryPlan.confirmToken, remote: "origin", remoteBranch: branch, expectedRemoteHead: head, allowNonAncestorRemoteDeletion: true, timestamp });

  assert.equal(retry.status, "reconciled");
  assert.equal(hasReservation(await readState(await getGuardianPaths(repo), { repoRoot: repo, config: DEFAULT_CONFIG }), safetyRef), false);
});
