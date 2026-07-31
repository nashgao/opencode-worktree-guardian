import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { guardianFinish } from "../src/finish.ts";
import { classifyGuardCommand } from "../src/guards.ts";
import { recordSession } from "../src/state.ts";
import { guardianStart } from "../src/start.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepoWithOrigin, createTempDir, git } from "./helpers.ts";
import { installFakeGh } from "./delete-fixtures.ts";

const protectedBranchOptions = {
  protectedBranches: ["main", "master"],
  branchPrefix: "guardian/",
  currentBranch: "main",
};

function requireRecord(value: unknown, name: string): Record<string, unknown> { if (isRecordLike(value)) return value; throw new TypeError(`${name} must be an object`); }
function requireString(value: unknown, name: string): string { if (typeof value === "string" && value.length > 0) return value; throw new TypeError(`${name} must be a non-empty string`); }

test("blocks Guardian protected branch bypasses when branch context is available", () => {
  for (const command of [
    "git push origin HEAD:main",
    "git push origin guardian/foo:main",
    "git push origin guardian/foo:refs/heads/main",
    "git push origin refs/heads/guardian/foo:refs/heads/main",
    "git push origin 'guardian/foo:main'",
    "git push origin \"HEAD:main\"",
    "git push --repo origin HEAD:main",
    "git push -o ci.skip origin HEAD:main",
    "git push --push-option ci.skip origin HEAD:main",
    "git push --atomic --porcelain -u origin HEAD:main",
    "git push --set-upstream origin guardian/foo:main",
    "git push origin +guardian/foo:main",
    "git push origin +HEAD:main",
    "git merge guardian/foo",
    "git merge refs/heads/guardian/foo",
    "git push origin HEAD:ma{in,ster}",
    "git push origin HEAD:$TARGET",
    "git push origin :ma{in,ster}",
    "git merge $TARGET",
    "git push origin HEAD:$(printf main)",
    "git merge $(printf guardian/foo)",
  ]) {
    const result = classifyGuardCommand(command, protectedBranchOptions);
    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /guardian_finish|dynamic shell command substitution/);
  }
});

test("blocks recorded descriptive Guardian branches from protected branch bypasses", () => {
  const options = {
    protectedBranches: ["main"],
    branchPrefix: "guardian/",
    guardianBranches: ["feature/source-facts-hardening"],
    currentBranch: "main",
  };
  for (const command of [
    "git push origin feature/source-facts-hardening:main",
    "git push origin refs/heads/feature/source-facts-hardening:refs/heads/main",
    "git merge feature/source-facts-hardening",
  ]) {
    const result = classifyGuardCommand(command, options);
    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /guardian_finish/);
  }
});

test("blocks git -C merges into protected worktree paths", () => {
  const options = {
    cwd: "/tmp",
    protectedBranches: ["main"],
    branchPrefix: "guardian/",
    guardianBranches: ["feature/source-facts-hardening"],
    currentBranch: "feature/local-context",
    protectedBranchWorktreePaths: ["/repo"],
  };

  const result = classifyGuardCommand("git -C /repo merge feature/source-facts-hardening", options);

  assert.equal(result.blocked, true);
  assert.match(String(result.reason), /guardian_finish/);
});

test("blocks env -C merges into protected worktree paths", () => {
  const options = {
    cwd: "/tmp",
    protectedBranches: ["main"],
    branchPrefix: "guardian/",
    guardianBranches: ["feature/source-facts-hardening"],
    currentBranch: "feature/local-context",
    protectedBranchWorktreePaths: ["/repo"],
  };

  for (const command of [
    "env -C /repo git merge feature/source-facts-hardening",
    "env -iC /repo git merge feature/source-facts-hardening",
    "env -S\"-iC /repo git merge feature/source-facts-hardening\"",
    "FOO=1 env -C /repo git merge feature/source-facts-hardening",
    "env -C /repo env -C sub git merge feature/source-facts-hardening",
    "bash -c 'env -C /repo env -C sub git merge feature/source-facts-hardening'",
  ]) {
    const result = classifyGuardCommand(command, options);
    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /guardian_finish/);
  }
});

test("blocks git -C merges inside protected worktree paths", () => {
  const options = {
    cwd: "/tmp",
    protectedBranches: ["main"],
    branchPrefix: "guardian/",
    guardianBranches: ["feature/source-facts-hardening"],
    currentBranch: "feature/local-context",
    protectedBranchWorktreePaths: ["/repo"],
  };

  for (const command of [
    "git -C /repo/subdir merge feature/source-facts-hardening",
    "git -C /repo -C . merge feature/source-facts-hardening",
    "git -C /repo -C subdir merge feature/source-facts-hardening",
  ]) {
    const result = classifyGuardCommand(command, options);
    assert.equal(result.blocked, true, command);
    assert.match(String(result.reason), /guardian_finish/);
  }
});

test("merge-to-base rejects an option-shaped session branch before Git merge", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  const config = { ...DEFAULT_CONFIG, finishMode: "merge-to-base" as const };
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_bad_merge_branch", taskName: "bad merge branch", createWorktree: true, config });
  const tools = await createTempDir("guardian-merge-branch-marker-"); const marker = path.join(tools, "merge.marker"); const fakeGit = path.join(tools, "git"); const originalPath = process.env.PATH; const originalRealPath = process.env.GUARDIAN_REAL_PATH;
  t.after(async () => fs.rm(base, { recursive: true, force: true })); t.after(async () => fs.rm(tools, { recursive: true, force: true })); t.after(() => { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; if (originalRealPath === undefined) delete process.env.GUARDIAN_REAL_PATH; else process.env.GUARDIAN_REAL_PATH = originalRealPath; });
  await recordSession(repo, config, { ...started.session, branch: "--malformed-branch" }, { event: { type: "test", session_id: "ses_bad_merge_branch" } });
  await fs.writeFile(fakeGit, '#!/bin/sh\nif [ "$3" = merge ]; then : > "$GUARDIAN_MERGE_MARKER"; exit 94; fi\nPATH="$GUARDIAN_REAL_PATH" exec git "$@"\n'); await fs.chmod(fakeGit, 0o755); process.env.PATH = `${tools}${path.delimiter}${originalPath ?? ""}`; process.env.GUARDIAN_REAL_PATH = originalPath ?? ""; process.env.GUARDIAN_MERGE_MARKER = marker;
  const result = await guardianFinish({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: "ses_bad_merge_branch", config, allowMergeToBase: true });
  assert.equal(result.ok, false); await assert.rejects(fs.access(marker));
});

test("merge-to-base rejects an option-shaped configured base before Git checkout", async (t) => {
  const { base, repo } = await createRepoWithOrigin(); const safeConfig = { ...DEFAULT_CONFIG, finishMode: "merge-to-base" as const }; const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_bad_base_branch", taskName: "bad base branch", createWorktree: true, config: safeConfig }); const tools = await createTempDir("guardian-checkout-base-marker-"); const marker = path.join(tools, "checkout.marker"); const fakeGit = path.join(tools, "git"); const originalPath = process.env.PATH; const originalRealPath = process.env.GUARDIAN_REAL_PATH;
  t.after(async () => fs.rm(base, { recursive: true, force: true })); t.after(async () => fs.rm(tools, { recursive: true, force: true })); t.after(() => { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; if (originalRealPath === undefined) delete process.env.GUARDIAN_REAL_PATH; else process.env.GUARDIAN_REAL_PATH = originalRealPath; }); await git(repo, ["update-ref", "refs/heads/--malformed-base", "HEAD"]); await fs.writeFile(fakeGit, '#!/bin/sh\nif [ "$3" = checkout ]; then : > "$GUARDIAN_CHECKOUT_MARKER"; exit 95; fi\nPATH="$GUARDIAN_REAL_PATH" exec git "$@"\n'); await fs.chmod(fakeGit, 0o755); process.env.PATH = `${tools}${path.delimiter}${originalPath ?? ""}`; process.env.GUARDIAN_REAL_PATH = originalPath ?? ""; process.env.GUARDIAN_CHECKOUT_MARKER = marker;
  await assert.rejects(guardianFinish({ repoRoot: repo, cwd: started.session.worktree_path, sessionId: "ses_bad_base_branch", config: { ...safeConfig, baseBranch: "--malformed-base" }, allowMergeToBase: true }), /Git ref/i); await assert.rejects(fs.access(marker));
});

test("guardian_done blocks an effective reference-transaction hook before creating a safety ref", async (t) => {
  const { base, repo } = await createRepoWithOrigin(); t.after(() => fs.rm(base, { recursive: true, force: true })); const sessionId = "land-clean-approved-tree-session"; const commitMessage = "fix: commit approved tree only"; const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "commit approved tree", createWorktree: true, config: DEFAULT_CONFIG }); const session = requireRecord(started.session, "started.session"); const worktree = requireString(session.worktree_path, "started.session.worktree_path"); const branch = requireString(session.branch, "started.session.branch"); await fs.writeFile(path.join(worktree, "approved.txt"), "approved\n", "utf8"); const hooksPath = path.join(worktree, ".guardian-hooks"); await git(worktree, ["config", "core.hooksPath", hooksPath]); await fs.mkdir(hooksPath, { recursive: true }); const hookPath = path.join(hooksPath, "reference-transaction"); await fs.writeFile(hookPath, `#!/bin/sh\nwhile read -r old new ref; do if [ "$1" = "committed" ] && [ "$ref" = ${JSON.stringify(`refs/heads/${branch}`)} ]; then printf 'post-token\\n' > ${JSON.stringify(path.join(worktree, "post-token.txt"))}; fi; done\n`, "utf8"); await fs.chmod(hookPath, 0o755); const fakeGh = await installFakeGh(t, { repo, branch, dynamicHead: true }); const request = { repoRoot: repo, cwd: worktree, sessionId, commitMessage, timestamp: "2026-07-27T00:00:00.000Z", config: DEFAULT_CONFIG }; const branchBefore = (await git(worktree, ["rev-parse", branch])).stdout; const remoteMainBefore = (await git(repo, ["rev-parse", "origin/main"])).stdout; const remoteBranchBefore = (await git(repo, ["ls-remote", "--heads", "origin", branch])).stdout; const safetyRefsBefore = (await git(repo, ["for-each-ref", "--format=%(refname)", "refs/opencode-guardian"])).stdout;
  const result = await guardianDone({ ...request, mode: "plan" });
  assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.status, "blocked", JSON.stringify(result)); assert.match(JSON.stringify(result), /reference-transaction/i); await assert.rejects(fs.access(path.join(worktree, "post-token.txt"))); assert.equal((await git(worktree, ["rev-parse", branch])).stdout, branchBefore); assert.equal((await git(repo, ["rev-parse", "origin/main"])).stdout, remoteMainBefore); assert.equal((await git(repo, ["ls-remote", "--heads", "origin", branch])).stdout, remoteBranchBefore); assert.equal((await git(repo, ["for-each-ref", "--format=%(refname)", "refs/opencode-guardian"])).stdout, safetyRefsBefore); assert.equal(await fs.access(fakeGh.logPath).then(() => true, () => false), false); await fs.access(worktree); await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
});

test("guardian_done blocks a different-target planned safety-ref collision without mutating the session transaction", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "land-clean-mismatched-safety-ref";
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "mismatched safety ref", createWorktree: true, config: DEFAULT_CONFIG });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");
  await fs.writeFile(path.join(worktree, "feature.txt"), "planned\n", "utf8");
  const fakeGh = await installFakeGh(t, { repo, branch, dynamicHead: true });
  const request = { repoRoot: repo, cwd: worktree, sessionId, commitMessage: "feat: collision must block", timestamp: "2026-07-29T01:00:00.000Z", config: DEFAULT_CONFIG };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");
  const safetyRef = requireString(plan.safetyRef, "plan.safetyRef");
  const expectedHead = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  const otherHead = (await git(repo, ["commit-tree", `${expectedHead}^{tree}`, "-p", expectedHead, "-m", "different safety target"])).stdout;
  await git(repo, ["update-ref", safetyRef, otherHead]);
  const statusBefore = (await git(worktree, ["status", "--porcelain=v1"])).stdout;
  const remoteMainBefore = (await git(repo, ["rev-parse", "origin/main"])).stdout;

  // When
  const result = await guardianDone({ ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") });

  // Then
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.match(requireString(result.error, "result.error"), /planned safety ref/i);
  assert.equal((await git(repo, ["rev-parse", safetyRef])).stdout, otherHead);
  assert.equal((await git(worktree, ["rev-parse", "HEAD"])).stdout, expectedHead);
  assert.equal((await git(worktree, ["status", "--porcelain=v1"])).stdout, statusBefore);
  assert.equal((await git(repo, ["rev-parse", "origin/main"])).stdout, remoteMainBefore);
  assert.equal((await git(repo, ["ls-remote", "--heads", "origin", branch])).stdout, "");
  assert.equal(await fs.access(fakeGh.logPath).then(() => true, () => false), false);
});

test("guardian_done blocks a same-name safety ref created after validation and before its create-only write", async (t) => {
  // Given
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionId = "land-clean-safety-ref-create-race";
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: "safety ref create race", createWorktree: true, config: DEFAULT_CONFIG });
  const session = requireRecord(started.session, "started.session");
  const worktree = requireString(session.worktree_path, "started.session.worktree_path");
  const branch = requireString(session.branch, "started.session.branch");
  await fs.writeFile(path.join(worktree, "feature.txt"), "planned\n", "utf8");
  const fakeGh = await installFakeGh(t, { repo, branch, dynamicHead: true });
  const request = { repoRoot: repo, cwd: worktree, sessionId, commitMessage: "feat: race must block", timestamp: "2026-07-29T02:00:00.000Z", config: DEFAULT_CONFIG };
  const plan = requireRecord(await guardianDone({ ...request, mode: "plan" }), "plan");
  const safetyRef = requireString(plan.safetyRef, "plan.safetyRef");
  const expectedHead = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  const otherHead = (await git(repo, ["commit-tree", `${expectedHead}^{tree}`, "-p", expectedHead, "-m", "racing safety target"])).stdout;
  const remoteMainBefore = (await git(repo, ["rev-parse", "origin/main"])).stdout;

  // When
  const result = await guardianDone(
    { ...request, mode: "apply", confirm: true, confirmToken: requireString(plan.confirmToken, "plan.confirmToken") },
    { commitTransactionHooks: { afterSafetyRefValidated: async () => { await git(repo, ["update-ref", safetyRef, otherHead]); } } },
  );

  // Then
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.equal((await git(repo, ["rev-parse", safetyRef])).stdout, otherHead);
  assert.equal((await git(worktree, ["rev-parse", "HEAD"])).stdout, expectedHead);
  assert.equal((await git(repo, ["rev-parse", "origin/main"])).stdout, remoteMainBefore);
  assert.equal((await git(repo, ["ls-remote", "--heads", "origin", branch])).stdout, "");
  assert.equal(await fs.access(fakeGh.logPath).then(() => true, () => false), false);
});
