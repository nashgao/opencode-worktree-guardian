import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { runGitNullSeparated } from "../src/git.ts";
import { guardianHygiene, scanWorkspaceHygiene } from "../src/hygiene.ts";
import { buildReviewableCandidates } from "../src/hygiene-reviewable.ts";
import { createRepo, createRepoWithOrigin, createTempDir, git } from "./helpers.ts";
import { guardianStart, runGuardianTool } from "../src/tools.ts";

async function writeArtifact(repo: string, relative: string) {
  const target = path.join(repo, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "artifact\n");
}

function findingPaths(result: Record<string, unknown>) {
  return (result.findings as Array<Record<string, unknown>>).map((finding) => finding.path).sort();
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

test("hygiene scanner declares Git untracked and ignored coverage plus bounded empty-directory coverage", async () => {
  // Given
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, "empty-directory"));

  // When
  const result = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });

  // Then
  assert.deepEqual(result.operationalScope, {
    enumeration: "git-untracked-and-ignored",
    emptyDirectories: "bounded-filesystem-empty-directory-scan",
  });
  assert.equal(result.summary.candidateCount, 0);
  assert.equal(result.summary.filesystemOnlyEmptyDirectoryCount, 1);
});

test("hygiene scanner degrades one unenumerable ignored directory without losing precision elsewhere", async () => {
  const repo = await createRepo();
  await fs.writeFile(path.join(repo, ".gitignore"), "data/\nhuge/\n");
  await writeArtifact(repo, "data/test-wal-001/segment");
  await writeArtifact(repo, "huge/node-compile-cache/cache.blob");

  const budgetExhausted = (relative: string) => {
    const error: NodeJS.ErrnoException & { signal?: string } = new Error(
      `git ls-files ${relative} failed with signal SIGTERM`,
    );
    error.signal = "SIGTERM";
    return error;
  };

  const result = await scanWorkspaceHygiene({
    repoRoot: repo,
    config: DEFAULT_CONFIG,
    runGitNullSeparated: async (repoPath: string, args: readonly string[]) => {
      const separator = args.indexOf("--");
      const pathspec = separator >= 0 ? args[separator + 1] : undefined;
      const unscopedIgnored = separator < 0 && args.includes("--ignored") && !args.includes("--directory");
      if (unscopedIgnored) throw budgetExhausted("(repository)");
      if (pathspec?.startsWith("huge")) throw budgetExhausted(pathspec);
      return runGitNullSeparated(repoPath, args);
    },
  });

  assert.equal(result.ok, true, "a single unenumerable directory must not fail the whole scan");
  assert.ok(
    findingPaths(result).includes("data/test-wal-001"),
    "directories that can be enumerated must keep nested known-cleanable precision",
  );
  const candidatePaths = (result.reviewableCandidates as Array<Record<string, unknown>>).map((entry) => String(entry.path));
  assert.ok(
    candidatePaths.some((entry) => entry.replace(/\/$/, "") === "huge"),
    "an unenumerable directory must surface as a collapsed reviewable candidate",
  );
  assert.equal(
    findingPaths(result).includes("huge/node-compile-cache"),
    false,
    "the scan must not claim findings inside a directory it could not enumerate",
  );
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

test("git NUL-separated streaming handles hygiene-sized candidate output without exec maxBuffer", async () => {
  const repo = await createRepo();
  const suffix = "x".repeat(90);
  const emptyBlob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: "" }).stdout.toString().trim();
  const indexInfo = Array.from({ length: 120000 }, (_, index) => `100644 blob ${emptyBlob}\t` + `entry-${String(index).padStart(6, "0")}-${suffix}`).join("\n");
  const update = spawnSync("git", ["update-index", "--add", "--index-info"], { cwd: repo, input: indexInfo });
  assert.equal(update.status, 0);

  const entries = await runGitNullSeparated(repo, ["ls-files", "-z"]);

  assert.equal(entries.length >= 120000, true);
  assert.equal(entries.includes(`entry-000000-${suffix}`), true);
  assert.equal(entries.includes(`entry-119999-${suffix}`), true);
});


async function pathExists(candidate: string) {
  return fs.access(candidate).then(() => true, () => false);
}

test("hygiene cleanup plans and applies all default hygiene targets", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "librarian-clean/file.txt");
  await writeArtifact(repo, "node-compile-cache/cache.blob");
  await writeArtifact(repo, "node-coverage-456/coverage.json");
  await writeArtifact(repo, "research-dump/file.txt");
  await writeArtifact(repo, "tsx-501/runtime-cache.json");
  const nested = path.join(repo, "research-clone-clean");
  await fs.mkdir(nested, { recursive: true });
  await git(nested, ["init", "-b", "main"]);
  await git(nested, ["config", "user.email", "guardian@example.test"]);
  await git(nested, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(nested, "README.md"), "nested\n");
  await git(nested, ["add", "README.md"]);
  await git(nested, ["commit", "-m", "nested initial"]);

  const plan = await runGuardianTool("guardian_hygiene", { repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan" });

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.equal(typeof plan.confirmToken, "string");
  assert.deepEqual((plan.targets as Array<Record<string, unknown>>).map((target) => target.path), ["librarian-clean", "node-compile-cache", "node-coverage-456", "research-clone-clean", "research-dump", "tsx-501"]);
  assert.equal(await pathExists(path.join(repo, "librarian-clean")), true);
  assert.equal(await pathExists(path.join(repo, "node-compile-cache")), true);
  assert.equal(await pathExists(path.join(repo, "node-coverage-456")), true);
  assert.equal(await pathExists(path.join(repo, "research-clone-clean")), true);
  assert.equal(await pathExists(path.join(repo, "research-dump")), true);
  assert.equal(await pathExists(path.join(repo, "tsx-501")), true);

  const apply = await runGuardianTool("guardian_hygiene", { repoRoot: repo, config: DEFAULT_CONFIG, mode: "apply", confirmToken: plan.confirmToken });

  assert.equal(apply.ok, true);
  assert.equal(apply.status, "cleaned");
  assert.deepEqual((apply.removedTargets as Array<Record<string, unknown>>).map((target) => target.path), ["librarian-clean", "node-compile-cache", "node-coverage-456", "research-clone-clean", "research-dump", "tsx-501"]);
  assert.equal(await pathExists(path.join(repo, "librarian-clean")), false);
  assert.equal(await pathExists(path.join(repo, "node-compile-cache")), false);
  assert.equal(await pathExists(path.join(repo, "node-coverage-456")), false);
  assert.equal(await pathExists(path.join(repo, "research-clone-clean")), false);
  assert.equal(await pathExists(path.join(repo, "research-dump")), false);
  assert.equal(await pathExists(path.join(repo, "tsx-501")), false);
});

test("guardian_hygiene plans and applies cleanup for approved target files and directories", async () => {
  const repo = await createRepo();
  await fs.writeFile(path.join(repo, "node-compile-cache"), "cache-blob\n");
  await writeArtifact(repo, "librarian-hygiene/file.txt");

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan" });

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.deepEqual((plan.targets as Array<Record<string, unknown>>).map((target) => [target.path, target.kind]), [["librarian-hygiene", "directory"], ["node-compile-cache", "file"]]);

  const apply = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "apply", confirmToken: plan.confirmToken });

  assert.equal(apply.ok, true);
  assert.equal(apply.status, "cleaned");
  assert.deepEqual((apply.removedTargets as Array<Record<string, unknown>>).map((target) => target.path), ["librarian-hygiene", "node-compile-cache"]);
  assert.equal(await pathExists(path.join(repo, "librarian-hygiene")), false);
  assert.equal(await pathExists(path.join(repo, "node-compile-cache")), false);
});

test("hygiene cleanup plans residue roots when categories are allowed", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "guardian-clean/.opencode/worktree-guardian.json");
  await writeArtifact(repo, "guardian-origin-clean/remote.git/hooks/push-to-checkout.sample");
  const nested = path.join(repo, "opencode-temp-clean", "checkout");
  await fs.mkdir(nested, { recursive: true });
  await git(nested, ["init", "-b", "main"]);
  await git(nested, ["config", "user.email", "guardian@example.test"]);
  await git(nested, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(nested, "README.md"), "nested\n");
  await git(nested, ["add", "README.md"]);
  await git(nested, ["commit", "-m", "nested initial"]);

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", allowCategories: ["nested-git", "suspicious"] });

  assert.equal(plan.ok, true);
  assert.deepEqual((plan.targets as Array<Record<string, unknown>>).map((target) => target.path).sort(), ["guardian-clean", "guardian-origin-clean", "opencode-temp-clean"]);

  const apply = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "apply", allowCategories: ["nested-git", "suspicious"], confirmToken: plan.confirmToken });

  assert.equal(apply.ok, true);
  assert.equal(apply.status, "cleaned");
  assert.deepEqual((apply.removedTargets as Array<Record<string, unknown>>).map((target) => target.path).sort(), ["guardian-clean", "guardian-origin-clean", "opencode-temp-clean"]);
  assert.equal(await pathExists(path.join(repo, "guardian-clean")), false);
  assert.equal(await pathExists(path.join(repo, "guardian-origin-clean")), false);
  assert.equal(await pathExists(path.join(repo, "opencode-temp-clean")), false);
});

test("hygiene cleanup blocks configured and registered Guardian worktree roots", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_hygiene_cleanup_worktree", taskName: "hygiene cleanup worktree", createWorktree: true, config: DEFAULT_CONFIG });
  const relativeWorktree = path.relative(repo, started.session.worktree_path);

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", cleanupPaths: [relativeWorktree] });

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal((plan.blockers as Array<Record<string, unknown>>).some((blocker) => /Guardian worktree root|registered/.test(String(blocker.reason))), true);
  assert.equal(await pathExists(started.session.worktree_path), true);
});

test("hygiene cleanup blocks invalid modes without removing anything", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "librarian-mode/file.txt");

  const result = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "delete" });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(String(result.reason), /mode must be plan or apply/);
  assert.equal(result.confirmToken, undefined);
  assert.equal(await pathExists(path.join(repo, "librarian-mode")), true);
});

test("hygiene cleanup rejects unsupported allowCategories entries as fatal blockers", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "librarian-categories/file.txt");

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", allowCategories: ["known-cleanable", "everything"] });

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.equal((plan.blockers as Array<Record<string, unknown>>).some((blocker) => blocker.fatal === true && /unsupported allowCategories entry: everything/.test(String(blocker.reason))), true);
  assert.equal(await pathExists(path.join(repo, "librarian-categories")), true);
});

test("hygiene cleanup blocks symlinked residue roots", { skip: process.platform === "win32" }, async (t) => {
  // Given
  const repo = await createRepo();
  const outside = await createTempDir("guardian-hygiene-outside-");
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "preserved.txt"), "outside\n");
  await fs.symlink(outside, path.join(repo, "guardian-origin-escape"));

  // When
  const result = await guardianHygiene({
    repoRoot: repo,
    config: DEFAULT_CONFIG,
    mode: "plan",
    cleanupPaths: ["guardian-origin-escape"],
    allowCategories: ["suspicious"],
  });

  // Then
  assert.equal(result.status, "blocked");
  assert.equal((result.blockers as Array<Record<string, unknown>>).some((blocker) => blocker.path === "guardian-origin-escape" && /symlink cleanup roots/.test(String(blocker.reason))), true);
  assert.equal(await fs.readFile(path.join(outside, "preserved.txt"), "utf8"), "outside\n");
});

test("hygiene cleanup blocks overlapping cleanup targets", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "guardian-overlap/root-file.txt");
  await writeArtifact(repo, "guardian-overlap/librarian-x/file.txt");

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", allowCategories: ["known-cleanable", "suspicious"] });

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.equal((plan.blockers as Array<Record<string, unknown>>).some((blocker) => blocker.fatal === true && /cleanup paths overlap/.test(String(blocker.reason))), true);
  assert.equal(await pathExists(path.join(repo, "guardian-overlap")), true);
});

test("hygiene scan reports failure metadata when the repo is unavailable", async () => {
  const dir = await createTempDir("guardian-hygiene-no-repo-");
  const result = await scanWorkspaceHygiene({ repoRoot: dir, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(typeof (result as Record<string, unknown>).reason, "string");
  assert.equal(result.failureReason, result.reason);
  assert.equal((result.summary as Record<string, unknown>).scanFailed, true);
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.findingCount, 0);
  assert.deepEqual(result.suggestedCommands, ["guardian_hygiene", "guardian_status"]);
});

test("reviewable candidates report bounded byte totals and prefer complete byte measurements", async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, "small"), { recursive: true });
  await fs.writeFile(path.join(repo, "small", "item.txt"), "x");
  await fs.mkdir(path.join(repo, "large"), { recursive: true });
  await fs.writeFile(path.join(repo, "large", "item.txt"), "x".repeat(64));

  const result = await buildReviewableCandidates(repo, [
    { path: "small/item.txt", status: "untracked" },
    { path: "large/item.txt", status: "untracked" },
  ], new Set(), null);

  assert.deepEqual(result.reviewableCandidates.map((candidate) => [candidate.path, candidate.bytes, candidate.bytesTruncated]), [
    ["large", 64, false],
    ["small", 1, false],
  ]);
  assert.equal(result.reviewableTotalBytes, 65);
  assert.equal(result.reviewableBytesTruncated, false);
});

test("reviewable byte measurement marks a per-candidate cap as partial", async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bulk = path.join(repo, "bulk");
  await fs.mkdir(bulk, { recursive: true });
  for (let offset = 0; offset < 10_001; offset += 100) {
    const writes: Promise<void>[] = [];
    for (let index = offset; index < Math.min(offset + 100, 10_001); index += 1) writes.push(fs.writeFile(path.join(bulk, `${index}.txt`), "x"));
    await Promise.all(writes);
  }

  const result = await buildReviewableCandidates(repo, [{ path: "bulk/0.txt", status: "untracked" }], new Set(), null);
  const candidate = result.reviewableCandidates[0];

  assert.equal(candidate?.path, "bulk");
  assert.equal(candidate?.bytesTruncated, true);
  assert.equal(result.reviewableBytesTruncated, true);
});
