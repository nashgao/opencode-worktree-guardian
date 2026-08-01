import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDone } from "../src/done.ts";
import { guardianStart } from "../src/start.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

test("land-clean planning permits a present disabled commit hook", async (t) => {
  // Given a dirty Guardian session with a non-executable commit hook.
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "disabled-hook-policy", taskName: "disabled hook policy", createWorktree: true, config: DEFAULT_CONFIG });
  const request = { repoRoot: repo, cwd: started.session.worktree_path, sessionId: "disabled-hook-policy", mode: "plan" as const, commitMessage: "add feature", config: DEFAULT_CONFIG };
  await fs.writeFile(path.join(request.cwd, "feature.txt"), "feature\n");
  const hooksPath = path.join(base, "disabled-hooks");
  await fs.mkdir(hooksPath);
  await fs.writeFile(path.join(hooksPath, "pre-commit"), "#!/bin/sh\nexit 0\n");
  await fs.chmod(path.join(hooksPath, "pre-commit"), 0o644);
  await git(request.cwd, ["config", "extensions.worktreeConfig", "true"]);
  await git(request.cwd, ["config", "--worktree", "core.hooksPath", hooksPath]);

  // When Guardian plans completion through its public surface.
  const plan = await guardianDone(request);

  // Then the disabled hook does not block plumbing commit planning.
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.status, "planned", JSON.stringify(plan));
});

test("land-clean planning ignores a directory named like a commit hook", async (t) => {
  // Given a dirty Guardian session whose hooks path contains a pre-commit directory.
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "hook-directory-policy", taskName: "hook directory policy", createWorktree: true, config: DEFAULT_CONFIG });
  const request = { repoRoot: repo, cwd: started.session.worktree_path, sessionId: "hook-directory-policy", mode: "plan" as const, commitMessage: "add feature", config: DEFAULT_CONFIG };
  await fs.writeFile(path.join(request.cwd, "feature.txt"), "feature\n");
  const hooksPath = path.join(base, "directory-hooks");
  await fs.mkdir(path.join(hooksPath, "pre-commit"), { recursive: true });
  await git(request.cwd, ["config", "extensions.worktreeConfig", "true"]);
  await git(request.cwd, ["config", "--worktree", "core.hooksPath", hooksPath]);

  // When Guardian plans completion through its public surface.
  const plan = await guardianDone(request);

  // Then a directory that Git cannot execute as a hook is ignored.
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.status, "planned", JSON.stringify(plan));
});

test("land-clean planning blocks when the configured hooks path cannot be inspected", async (t) => {
  // Given a dirty Guardian session whose effective hooks path is a regular file.
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "unreadable-hooks-policy", taskName: "unreadable hooks policy", createWorktree: true, config: DEFAULT_CONFIG });
  const request = { repoRoot: repo, cwd: started.session.worktree_path, sessionId: "unreadable-hooks-policy", mode: "plan" as const, commitMessage: "add feature", config: DEFAULT_CONFIG };
  await fs.writeFile(path.join(request.cwd, "feature.txt"), "feature\n");
  const hooksPath = path.join(base, "not-a-hooks-directory");
  await fs.writeFile(hooksPath, "not a directory\n");
  await git(request.cwd, ["config", "extensions.worktreeConfig", "true"]);
  await git(request.cwd, ["config", "--worktree", "core.hooksPath", hooksPath]);

  // When Guardian plans completion through its public surface.
  const plan = await guardianDone(request);

  // Then ENOTDIR while inspecting hooks fails closed as an unresolved commit policy.
  assert.equal(plan.ok, false, JSON.stringify(plan));
  assert.equal(plan.status, "blocked", JSON.stringify(plan));
  assert.match(String(plan.reason), /commit policy could not be resolved/i);
});
