import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDeletePaths } from "../src/delete-paths.ts";
import { createRepo, git } from "./helpers.ts";

async function exists(candidate: string) {
  return fs.access(candidate).then(() => true, () => false);
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
  await fs.writeFile(path.join(repo, "target.txt"), "target\n");
  await fs.symlink("target.txt", path.join(repo, "link.txt"));

  const blocked = await guardianDeletePaths({
    repoRoot: repo,
    cwd: repo,
    config: DEFAULT_CONFIG,
    mode: "plan",
    paths: [".", ".git", ".opencode", ".worktrees", "node_modules", "link.txt"],
    allowRecursive: true,
  });
  const reasons = (blocked.blockers as Array<Record<string, unknown>>).map((blocker) => String(blocker.reason)).sort();

  assert.equal(blocked.status, "blocked");
  assert.equal(reasons.some((reason) => /repository root/.test(reason)), true);
  assert.equal(reasons.some((reason) => /git metadata/.test(reason)), true);
  assert.equal(reasons.some((reason) => /protected \.opencode/.test(reason)), true);
  assert.equal(reasons.some((reason) => /configured Guardian worktree root/.test(reason)), true);
  assert.equal(reasons.some((reason) => /protected node_modules/.test(reason)), true);
  assert.equal(reasons.some((reason) => /symlink delete roots/.test(reason)), true);
});
