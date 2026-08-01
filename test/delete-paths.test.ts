import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDeleteWorktree } from "../src/delete-worktree.ts";
import { guardianDeletePaths } from "../src/delete-paths.ts";
import { guardianHygiene, scanWorkspaceHygiene } from "../src/hygiene.ts";
import { guardianStart } from "../src/start.ts";
import type { GuardianConfig } from "../src/types.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepo, createRepoWithOrigin, git } from "./helpers.ts";
import { branchExists, createGuardianWorktree, deleteWorktree, guardianStatus, worktreePaths } from "./delete-fixtures.js";

async function exists(candidate: string) {
  return fs.access(candidate).then(() => true, () => false);
}

function records(value: unknown) {
  if (!Array.isArray(value)) {
    throw new TypeError("expected records array");
  }
  const result: Record<string, unknown>[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      throw new TypeError("expected record entry");
    }
    result.push(entry);
  }
  return result;
}

function hasFatalBlocker(recordsValue: unknown, pathValue: string, reasonPattern: RegExp) {
  return records(recordsValue).some((blocker) => blocker.path === pathValue && blocker.fatal === true && reasonPattern.test(String(blocker.reason)));
}

async function shadowOriginMain(repo: string, commit: string): Promise<void> {
  await git(repo, ["update-ref", "refs/heads/origin/main", commit]);
}

test("guardian_delete_paths requires allowTracked before deleting tracked source", async () => {
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  await fs.writeFile(path.join(repo, "src", "old.ts"), "export const old = true;\n");
  await git(repo, ["add", "src/old.ts"]);
  await git(repo, ["commit", "-m", "add tracked source"]);

  const blocked = await guardianDeletePaths({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", paths: ["src/old.ts"] });
  assert.equal(blocked.ok, false);
  assert.match(String(blocked.reason), /fatal blockers/);
  assert.match(String((blocked.blockers as Array<Record<string, unknown>>)[0].reason), /allowTracked=true/);

  const plan = await guardianDeletePaths({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", paths: ["src/old.ts"], allowTracked: true });
  const apply = await guardianDeletePaths({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "apply", paths: ["src/old.ts"], allowTracked: true, confirmDelete: true, confirmToken: plan.confirmToken });
  const status = await git(repo, ["status", "--short"]);

  assert.equal(plan.status, "planned");
  assert.equal(apply.status, "deleted");
  assert.equal(await exists(path.join(repo, "src", "old.ts")), false);
  assert.match(status.stdout, /D src\/old\.ts/);
});

test("guardian_delete_paths requires allowRecursive before deleting directories", async () => {
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, "src", "legacy"), { recursive: true });
  await fs.writeFile(path.join(repo, "src", "legacy", "index.ts"), "export const legacy = true;\n");
  await git(repo, ["add", "src/legacy/index.ts"]);
  await git(repo, ["commit", "-m", "add legacy directory"]);

  const blocked = await guardianDeletePaths({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", paths: ["src/legacy"], allowTracked: true });
  assert.equal(blocked.ok, false);
  assert.match(String((blocked.blockers as Array<Record<string, unknown>>)[0].reason), /allowRecursive=true/);

  const plan = await guardianDeletePaths({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", paths: ["src/legacy"], allowTracked: true, allowRecursive: true });
  const apply = await guardianDeletePaths({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "apply", paths: ["src/legacy"], allowTracked: true, allowRecursive: true, confirmDelete: true, confirmToken: plan.confirmToken });

  assert.equal(apply.status, "deleted");
  assert.equal(await exists(path.join(repo, "src", "legacy")), false);
});

test("guardian_delete_paths deletes exact untracked and ignored artifacts without allowTracked", async () => {
  const repo = await createRepo();
  await fs.writeFile(path.join(repo, ".gitignore"), "*.tmp\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore tmp artifacts"]);
  await fs.writeFile(path.join(repo, "artifact.tmp"), "tmp\n");
  await fs.writeFile(path.join(repo, "scratch.log"), "scratch\n");

  const plan = await guardianDeletePaths({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", paths: ["artifact.tmp", "scratch.log"] });
  const targets = plan.targets as Array<Record<string, unknown>>;
  const apply = await guardianDeletePaths({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "apply", paths: ["artifact.tmp", "scratch.log"], confirmDelete: true, confirmToken: plan.confirmToken });

  assert.equal(plan.status, "planned");
  assert.deepEqual(targets.map((target) => [target.path, target.status]), [["artifact.tmp", "ignored"], ["scratch.log", "untracked"]]);
  assert.equal(apply.status, "deleted");
  assert.equal(await exists(path.join(repo, "artifact.tmp")), false);
  assert.equal(await exists(path.join(repo, "scratch.log")), false);
});

test("guardian_delete_paths can plan exact reviewable handoff paths blocked by hygiene cleanup", async () => {
  const repo = await createRepo();
  await fs.writeFile(path.join(repo, ".gitignore"), "*.log\nlogs/\nnode_modules/\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "add reviewable and protected ignores"]);
  await fs.writeFile(path.join(repo, "plain.log"), "reviewable file\n");
  await fs.mkdir(path.join(repo, "logs"), { recursive: true });
  await fs.writeFile(path.join(repo, "logs", "run.log"), "reviewable directory\n");
  await fs.mkdir(path.join(repo, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(repo, "node_modules", "pkg", "index.js"), "protected dependency\n");

  const scan = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });
  const protectedExclusion = records(scan.exclusions).find((entry) => entry.path === "node_modules");
  const hygieneFile = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", cleanupPaths: ["plain.log"] });
  const hygieneDirectory = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", cleanupPaths: ["logs"] });

  assert.equal(protectedExclusion?.suggestedDeletePathCommand, undefined);
  assert.equal(hygieneFile.status, "blocked");
  assert.equal(hasFatalBlocker(hygieneFile.blockers, "plain.log", /not a current guardian_hygiene finding/), true);
  assert.equal(hygieneDirectory.status, "blocked");
  assert.equal(hasFatalBlocker(hygieneDirectory.blockers, "logs", /not a current guardian_hygiene finding/), true);

  const filePlan = await guardianDeletePaths({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", paths: ["plain.log"] });
  const directoryBlocked = await guardianDeletePaths({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", paths: ["logs"] });
  const directoryPlan = await guardianDeletePaths({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", paths: ["logs"], allowRecursive: true });
  const protectedBlocked = await guardianDeletePaths({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", paths: ["node_modules"], allowRecursive: true });

  assert.equal(filePlan.status, "planned");
  assert.deepEqual(records(filePlan.targets).map((target) => [target.path, target.kind, target.status]), [["plain.log", "file", "ignored"]]);
  assert.equal(directoryBlocked.status, "blocked");
  assert.equal(hasFatalBlocker(directoryBlocked.blockers, "logs", /allowRecursive=true/), true);
  assert.equal(directoryPlan.status, "planned");
  assert.deepEqual(records(directoryPlan.targets).map((target) => [target.path, target.kind, target.status]), [["logs", "directory", "ignored"]]);
  assert.equal(protectedBlocked.status, "blocked");
  assert.equal(hasFatalBlocker(protectedBlocked.blockers, "node_modules", /protected node_modules/), true);
});

test("guardian_delete_paths blocks configured protected paths", async () => {
  const repo = await createRepo();
  const config = { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths, ".agent-state"] };
  await fs.mkdir(path.join(repo, ".agent-state", "logs"), { recursive: true });
  await fs.writeFile(path.join(repo, ".agent-state", "logs", "run.jsonl"), "state\n");

  const blocked = await guardianDeletePaths({
    repoRoot: repo,
    config,
    mode: "plan",
    paths: [".agent-state/logs"],
    allowRecursive: true,
  });

  assert.equal(blocked.status, "blocked");
  assert.equal(hasFatalBlocker(blocked.blockers, ".agent-state/logs", /configured protected path \.agent-state/), true);
});

test("guardian_delete_paths lets repo config replace template protected paths", async () => {
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.writeFile(path.join(repo, ".opencode", "worktree-guardian.json"), JSON.stringify({ protectedPaths: ["keep-me"] }));
  await fs.mkdir(path.join(repo, "keep-me"), { recursive: true });
  await fs.writeFile(path.join(repo, "keep-me", "important.txt"), "important\n");
  await fs.mkdir(path.join(repo, ".codegraph"), { recursive: true });
  await fs.writeFile(path.join(repo, ".codegraph", "index.sqlite"), "cache\n");
  await fs.mkdir(path.join(repo, ".beads"), { recursive: true });
  await fs.writeFile(path.join(repo, ".beads", "state.json"), "state\n");

  const blocked = await guardianDeletePaths({
    repoRoot: repo,
    mode: "plan",
    paths: ["keep-me", ".codegraph", ".beads"],
    allowRecursive: true,
  });

  assert.equal(blocked.status, "blocked");
  assert.deepEqual(records(blocked.targets).map((target) => target.path), [".codegraph"]);
  assert.equal(hasFatalBlocker(blocked.blockers, "keep-me", /configured protected path keep-me/), true);
  assert.equal(hasFatalBlocker(blocked.blockers, ".codegraph", /configured protected path \.codegraph/), false);
  assert.equal(hasFatalBlocker(blocked.blockers, ".beads", /protected path \.beads/), true);
});

test("guardian_delete_paths blocks stale tokens after path content changes", async () => {
  const repo = await createRepo();
  await fs.writeFile(path.join(repo, "scratch.txt"), "original\n");

  const plan = await guardianDeletePaths({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", paths: ["scratch.txt"] });
  await fs.writeFile(path.join(repo, "scratch.txt"), "changed\n");
  const apply = await guardianDeletePaths({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "apply", paths: ["scratch.txt"], confirmDelete: true, confirmToken: plan.confirmToken });

  assert.equal(plan.status, "planned");
  assert.equal(apply.status, "blocked");
  assert.match(String(apply.reason), /confirm token mismatch/);
  assert.equal(await exists(path.join(repo, "scratch.txt")), true);
});

test("guardian_delete_paths blocks repo control paths, dependencies, worktree roots, and symlink roots", async () => {
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, ".worktrees", path.basename(repo)), { recursive: true });
  await fs.mkdir(path.join(repo, "node_modules", "pkg"), { recursive: true });
  await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });
  await fs.mkdir(path.join(repo, ".codegraph"), { recursive: true });
  await fs.writeFile(path.join(repo, "target.txt"), "target\n");
  await fs.symlink("target.txt", path.join(repo, "link.txt"));

  const blocked = await guardianDeletePaths({
    repoRoot: repo,
    cwd: repo,
    config: DEFAULT_CONFIG,
    mode: "plan",
    paths: [".", ".git", ".opencode", ".codegraph", ".worktrees", "node_modules", "link.txt"],
    allowRecursive: true,
  });
  const reasons = (blocked.blockers as Array<Record<string, unknown>>).map((blocker) => String(blocker.reason)).sort();

  assert.equal(blocked.status, "blocked");
  assert.equal(reasons.some((reason) => /repository root/.test(reason)), true);
  assert.equal(reasons.some((reason) => /git metadata/.test(reason)), true);
  assert.equal(hasFatalBlocker(blocked.blockers, ".opencode", /configured protected path \.opencode/), true);
  assert.equal(hasFatalBlocker(blocked.blockers, ".codegraph", /configured protected path \.codegraph/), true);
  assert.equal(hasFatalBlocker(blocked.blockers, ".worktrees", /configured protected path \.worktrees/), true);
  assert.equal(reasons.some((reason) => /configured Guardian worktree root/.test(reason)), true);
  assert.equal(reasons.some((reason) => /protected node_modules/.test(reason)), true);
  assert.equal(reasons.some((reason) => /symlink delete roots/.test(reason)), true);
});

test("hygiene cleanup blocks an explicit approved parent containing an excluded category finding", async () => {
  const repo = await createRepo();
  const parent = "research-category-parent";
  await fs.mkdir(path.join(repo, parent, "librarian-child"), { recursive: true });
  await fs.writeFile(path.join(repo, parent, "marker.txt"), "artifact\n");
  await fs.writeFile(path.join(repo, parent, "librarian-child", "marker.txt"), "artifact\n");

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", cleanupPaths: [parent], allowCategories: ["suspicious"] });

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.deepEqual(records(plan.targets).map((target) => target.path), []);
  assert.equal(records(plan.blockers).some((blocker) => blocker.path === parent && blocker.category === "known-cleanable" && blocker.fatal === true && /not allowed/.test(String(blocker.reason))), true);
  assert.equal(await exists(path.join(repo, parent)), true);
});

test("direct deletion blocks overlapping trusted remote namespaces before ancestry evaluation", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "authority-overlap-delete", taskName: "authority overlap delete", createWorktree: true, config: DEFAULT_CONFIG });
  assert.equal(started.ok, true, JSON.stringify(started));
  const config = { ...DEFAULT_CONFIG, trustedUpstreamRemotes: ["origin/main"] } satisfies GuardianConfig;

  const result = await guardianDeleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "authority-overlap-delete", deleteBranch: true, config });
  const preflight = isRecordLike(result.preflight) ? result.preflight : {};

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(String(result.error), /remote namespaces overlap/);
  assert.equal(preflight.ancestryRef, null);
});

test("direct delete ancestry ignores a local origin/main shadow", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "authority-delete", taskName: "authority delete", createWorktree: true, config: DEFAULT_CONFIG });
  assert.equal(started.ok, true, JSON.stringify(started));
  await fs.writeFile(path.join(started.session.worktree_path, "unmerged.txt"), "unmerged\n");
  await git(started.session.worktree_path, ["add", "unmerged.txt"]);
  await git(started.session.worktree_path, ["commit", "-m", "unmerged delete authority"]);
  const head = (await git(started.session.worktree_path, ["rev-parse", "HEAD"])).stdout;
  await shadowOriginMain(repo, head);

  const result = await guardianDeleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "authority-delete", deleteBranch: true, config: DEFAULT_CONFIG });
  const preflight = isRecordLike(result.preflight) ? result.preflight : {};

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(preflight.ancestryProven, false);
  assert.match(String(result.reason), /not proven reachable/);
});

test("deleteBranch=true requires ancestry proof before any removal", async () => {
  const { base, repo } = await createRepoWithOrigin();
  test.after(() => fs.rm(base, { recursive: true, force: true }));
  const start = await createGuardianWorktree(repo, "ses_delete_unmerged", "delete unmerged", "guardian/delete-unmerged");
  await fs.writeFile(path.join(start.session.worktree_path, "feature.txt"), "unmerged\n");
  await git(start.session.worktree_path, ["add", "feature.txt"]);
  await git(start.session.worktree_path, ["commit", "-m", "unmerged feature"]);

  const result = await deleteWorktree({ repoRoot: repo, cwd: repo, mode: "plan", sessionId: "ses_delete_unmerged", deleteBranch: true, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.match(result.reason, /not proven reachable/);
  assert.equal((await worktreePaths(repo)).includes(start.session.worktree_path), true);
  assert.equal(await branchExists(repo, "guardian/delete-unmerged"), true);
  assert.equal((await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG })).safetyRefs.length, 0);
});
