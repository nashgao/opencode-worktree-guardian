import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianHygiene, scanWorkspaceHygiene } from "../src/hygiene.ts";
import { createRepo, git } from "./helpers.ts";

async function writeArtifact(repo: string, relative: string) {
  const target = path.join(repo, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "artifact\n");
}

function findingPaths(result: Record<string, unknown>) {
  return (result.findings as Array<Record<string, unknown>>).map((finding) => finding.path).sort();
}

test("hygiene protects Beads state and matches suspicious directory segments despite config overrides", async () => {
  const repo = await createRepo();
  for (const relative of [".beads/embeddeddolt/owg/.dolt/repo_state.json", "ordinary/repo_state.json", "research-dump/file.txt"]) {
    const target = path.join(repo, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "state\n");
  }

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config: { ...DEFAULT_CONFIG, protectedPaths: ["keep-me"] } });

  assert.deepEqual(result.findings.map((finding) => finding.path), ["research-dump"]);
  assert.deepEqual(result.exclusions.map((exclusion) => exclusion.path), [".beads"]);
});

test("hygiene scanner ignores tracked files even when names match known artifact patterns", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "hyperf-tracked/file.txt");
  await git(repo, ["add", "hyperf-tracked/file.txt"]);
  await git(repo, ["commit", "-m", "track matching artifact name"]);

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(findingPaths(result).includes("hyperf-tracked"), false);
  assert.equal(result.summary.findingCount, 0);
});

test("hygiene scanner excludes protected dependency and build directories", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "node_modules/librarian-alpha/file.txt");
  await writeArtifact(repo, "vendor/hyperf-demo/file.txt");
  await writeArtifact(repo, "target/test-phpkafka/file.txt");

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(result.summary.findingCount, 0);
  assert.deepEqual((result.exclusions as Array<Record<string, unknown>>).map((entry) => entry.path).sort(), ["node_modules", "target", "vendor"]);
});

test("hygiene scanner excludes agent and local tooling state directories from cleanup findings", async () => {
  const repo = await createRepo();
  await fs.writeFile(path.join(repo, ".gitignore"), "logs/\n");
  await writeArtifact(repo, ".milestones/logs/progress-events.jsonl");
  await writeArtifact(repo, ".omc/session.json");
  await writeArtifact(repo, ".omo/plan.md");
  await writeArtifact(repo, ".omx/cache.json");
  await writeArtifact(repo, ".sisyphus/state.json");
  await writeArtifact(repo, ".opencode/worktree-guardian.json");
  await writeArtifact(repo, ".codegraph/index.sqlite");
  await writeArtifact(repo, ".worktrees/cache.json");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "track ignore rules"]);

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.equal(result.summary.findingCount, 0);
  assert.deepEqual((result.exclusions as Array<Record<string, unknown>>).map((entry) => entry.path).sort(), [".codegraph", ".milestones", ".omc", ".omo", ".omx", ".opencode", ".sisyphus", ".worktrees"]);
  assert.deepEqual((result as Record<string, unknown>).reviewableCandidates, []);
});

test("hygiene scanner excludes configured protected paths from cleanup findings", async () => {
  const repo = await createRepo();
  const config = { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths, ".agent-state"] };
  await writeArtifact(repo, ".agent-state/node-compile-cache/cache.blob");
  await writeArtifact(repo, ".agent-state/research-dump/file.txt");

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config });

  assert.equal(result.ok, true);
  assert.equal(result.summary.findingCount, 0);
  assert.deepEqual((result.exclusions as Array<Record<string, unknown>>).map((entry) => entry.path).sort(), [".agent-state"]);
  assert.deepEqual((result as Record<string, unknown>).reviewableCandidates, []);
});

test("hygiene scanner collapses known residue names to cleanup roots", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "guardian-residue/.opencode/worktree-guardian.json");
  await writeArtifact(repo, "guardian-origin-abc123/remote.git/hooks/push-to-checkout.sample");
  const nested = path.join(repo, "opencode-temp-abc123", "checkout");
  await fs.mkdir(nested, { recursive: true });
  await git(nested, ["init", "-b", "main"]);
  await git(nested, ["config", "user.email", "guardian@example.test"]);
  await git(nested, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(nested, "README.md"), "nested\n");
  await git(nested, ["add", "README.md"]);
  await git(nested, ["commit", "-m", "nested initial"]);

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(findingPaths(result).includes("guardian-origin-abc123"), true);
  assert.equal(findingPaths(result).includes("guardian-origin-abc123/remote.git/hooks/push-to-checkout.sample"), false);
  assert.equal(findingPaths(result).includes("guardian-residue"), true);
  assert.equal(findingPaths(result).includes("guardian-residue/.opencode/worktree-guardian.json"), false);
  assert.equal(findingPaths(result).includes("opencode-temp-abc123"), true);
  assert.equal(findingPaths(result).includes("opencode-temp-abc123/checkout"), false);
});

test("hygiene scanner recognizes nested Guardian residue without weakening protected or tracked-path guards", async () => {
  const repo = await createRepo();
  const nestedResidue = "test-fixtures/guardian-origin-nested/remote.git/objects/pack";
  const trackedResidue = "tracked-parent/guardian-origin-tracked/remote.git/objects/pack";
  await writeArtifact(repo, nestedResidue);
  await writeArtifact(repo, ".beads/guardian-origin-protected/remote.git/objects/pack");
  await writeArtifact(repo, "tracked-parent/guardian-origin-tracked/.keep");
  await git(repo, ["add", "tracked-parent/guardian-origin-tracked/.keep"]);
  await git(repo, ["commit", "-m", "track nested residue guard"]);
  await writeArtifact(repo, trackedResidue);

  const scan = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });
  const plan = await guardianHygiene({
    repoRoot: repo,
    config: DEFAULT_CONFIG,
    mode: "plan",
    cleanupPaths: ["tracked-parent/guardian-origin-tracked"],
    allowCategories: ["suspicious"],
  });

  assert.equal(findingPaths(scan).includes("test-fixtures/guardian-origin-nested"), true);
  assert.equal(findingPaths(scan).includes(".beads/guardian-origin-protected"), false);
  assert.equal((scan.exclusions as Array<Record<string, unknown>>).some((entry) => entry.path === ".beads"), true);
  assert.equal(plan.ok, false);
  assert.equal((plan.blockers as Array<Record<string, unknown>>).some((blocker) => String(blocker.reason).includes("tracked files")), true);
});
