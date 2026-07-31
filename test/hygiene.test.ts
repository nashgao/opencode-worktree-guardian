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

function recordField(record: Record<string, unknown>, key: string) {
  return record[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pathsFromRecords(records: unknown) {
  if (!Array.isArray(records)) {
    throw new TypeError("expected records array");
  }
  return records.map((entry) => {
    if (!isRecord(entry)) {
      throw new TypeError("expected record entry");
    }
    return entry.path;
  }).sort();
}

async function pathExists(candidate: string) {
  return fs.access(candidate).then(() => true, () => false);
}

async function createDirtyNestedRepository(repo: string, relative: string) {
  const nested = path.join(repo, relative);
  await fs.mkdir(nested, { recursive: true });
  await git(nested, ["init", "-b", "main"]);
  await git(nested, ["config", "user.email", "guardian@example.test"]);
  await git(nested, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(nested, "README.md"), "nested\n");
  await git(nested, ["add", "README.md"]);
  await git(nested, ["commit", "-m", "nested initial"]);
  await fs.writeFile(path.join(nested, "dirty.txt"), "dirty\n");
  return nested;
}

test("hygiene scanner detects known scratch artifact patterns", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "librarian-alpha/file.txt");
  await writeArtifact(repo, "alpha-librarian/file.txt");
  await writeArtifact(repo, "hyperf-demo/file.txt");
  await writeArtifact(repo, "export.tsv");
  await writeArtifact(repo, "test-phpkafka/file.txt");
  await writeArtifact(repo, "test-hyperf-kafka/file.txt");
  await writeArtifact(repo, "data/test-wal-001/segment");
  await writeArtifact(repo, "node-compile-cache/cache.blob");
  await writeArtifact(repo, "node-coverage-123/coverage.json");
  await writeArtifact(repo, "tsx-501/runtime-cache.json");

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(result.ok, true);
  assert.deepEqual(findingPaths(result), [
    "alpha-librarian",
    "data/test-wal-001",
    "export.tsv",
    "hyperf-demo",
    "librarian-alpha",
    "node-compile-cache",
    "node-coverage-123",
    "test-hyperf-kafka",
    "test-phpkafka",
    "tsx-501",
  ]);
  assert.equal(result.summary.byCategory["known-cleanable"], 10);
  const reasons = new Map((result.findings as Array<Record<string, unknown>>).map((finding) => [finding.path, finding.reason]));
  assert.equal(reasons.get("export.tsv"), "generated TSV artifact");
  assert.equal(reasons.get("node-compile-cache"), "generated Node compile cache");
  assert.equal(reasons.get("node-coverage-123"), "generated Node coverage cache");
  assert.equal(reasons.get("tsx-501"), "generated tsx runtime cache");
});

test("hygiene scanner detects nested git repos and marks dirty nested repos for manual hard deny", async () => {
  const repo = await createRepo();
  const nested = path.join(repo, "research-clone");
  await fs.mkdir(nested, { recursive: true });
  await git(nested, ["init", "-b", "main"]);
  await git(nested, ["config", "user.email", "guardian@example.test"]);
  await git(nested, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(nested, "README.md"), "nested\n");
  await git(nested, ["add", "README.md"]);
  await git(nested, ["commit", "-m", "nested initial"]);
  await fs.writeFile(path.join(nested, "dirty.txt"), "dirty\n");

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });
  const finding = (result.findings as Array<Record<string, unknown>>).find((entry) => entry.path === "research-clone");
  assert.equal(finding?.category, "nested-git");
  assert.equal(finding?.severity, "fail");
  assert.deepEqual(finding?.metadata, {
    dirty: true,
    manualReview: true,
    hardDeny: true,
    statusAvailable: true,
  });
  assert.equal((result.suggestedCommands as string[]).some((command) => /git clean|rm -rf|guardian.*clean/i.test(command)), false);
  assert.equal((result.suggestedCommands as string[]).includes("git -C research-clone status --short"), true);
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

test("hygiene scanner keeps reviewable delete suggestions narrow when siblings include hygiene findings", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "foo/node-compile-cache/cache.blob");
  await writeArtifact(repo, "foo/ordinary.txt");

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.deepEqual(findingPaths(result), ["foo/node-compile-cache"]);
  assert.deepEqual(recordField(result, "reviewableCandidates"), [
    { path: "foo/ordinary.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["foo/ordinary.txt"]' },
  ]);
});

test("hygiene scanner keeps reviewable files exact under tracked source directories", async () => {
  const repo = await createRepo();
  await fs.writeFile(path.join(repo, ".gitignore"), "*.txt\n");
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  await fs.writeFile(path.join(repo, "src", "index.ts"), "export const tracked = true;\n");
  await git(repo, ["add", ".gitignore", "src/index.ts"]);
  await git(repo, ["commit", "-m", "track source directory"]);
  await fs.writeFile(path.join(repo, "src", "ordinary.txt"), "reviewable\n");

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.deepEqual(recordField(result, "reviewableCandidates"), [
    { path: "src/ordinary.txt", status: "ignored", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["src/ordinary.txt"]' },
  ]);
});

test("hygiene scanner keeps nested protected exclusions from suppressing reviewable siblings", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "foo/node_modules/pkg/index.js");
  await writeArtifact(repo, "foo/ordinary.txt");

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.deepEqual(pathsFromRecords(result.exclusions), ["foo/node_modules"]);
  const protectedExclusion = (result.exclusions as Array<Record<string, unknown>>).find((entry) => entry.path === "foo/node_modules");
  assert.equal(recordField(protectedExclusion ?? {}, "suggestedDeletePathCommand"), undefined);
  assert.deepEqual(recordField(result, "reviewableCandidates"), [
    { path: "foo/ordinary.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["foo/ordinary.txt"]' },
  ]);
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
  assert.deepEqual(pathsFromRecords(result.exclusions), [".codegraph", ".milestones", ".omc", ".omo", ".omx", ".opencode", ".sisyphus", ".worktrees"]);
  assert.deepEqual(recordField(result, "reviewableCandidates"), []);
});

test("hygiene scanner excludes configured protected paths from cleanup findings", async () => {
  const repo = await createRepo();
  const config = { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths, ".agent-state"] };
  await writeArtifact(repo, ".agent-state/node-compile-cache/cache.blob");
  await writeArtifact(repo, ".agent-state/research-dump/file.txt");

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config });

  assert.equal(result.ok, true);
  assert.equal(result.summary.findingCount, 0);
  assert.deepEqual(pathsFromRecords(result.exclusions), [".agent-state"]);
  assert.deepEqual(recordField(result, "reviewableCandidates"), []);
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

test("hygiene cleanup allows an explicit parent when every descendant authority is granted", async () => {
  const repo = await createRepo();
  const parent = "research-authorized-parent";
  await writeArtifact(repo, `${parent}/marker.txt`);
  await createDirtyNestedRepository(repo, `${parent}/research-clone`);

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", cleanupPaths: [parent], allowCategories: ["nested-git", "suspicious"], allowDirtyNestedGit: true });
  const apply = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "apply", cleanupPaths: [parent], allowCategories: ["nested-git", "suspicious"], allowDirtyNestedGit: true, confirmToken: plan.confirmToken });

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.deepEqual(pathsFromRecords(plan.targets), [parent]);
  assert.equal(apply.ok, true);
  assert.equal(apply.status, "cleaned");
  assert.equal(await pathExists(path.join(repo, parent)), false);
});
