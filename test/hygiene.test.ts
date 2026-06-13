import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { runGitNullSeparated } from "../src/git.ts";
import { guardianHygiene, scanWorkspaceHygiene } from "../src/hygiene.ts";
import { guardianStatus } from "../src/recover.ts";
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

test("hygiene scanner detects known scratch artifact patterns", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, ".omo/run-continuation/session.json");
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
    ".omo",
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
  assert.equal(result.summary.byCategory["known-cleanable"], 11);
  const reasons = new Map((result.findings as Array<Record<string, unknown>>).map((finding) => [finding.path, finding.reason]));
  assert.equal(reasons.get(".omo"), "local agent state directory");
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

test("hygiene scanner exposes reviewable scan inventory separately from cleanup findings", async () => {
  const repo = await createRepo();
  await fs.writeFile(path.join(repo, ".gitignore"), "*.log\nlogs/\nnode_modules/\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "add hygiene fixture ignores"]);
  await writeArtifact(repo, ".omo/run-continuation/session.json");
  await writeArtifact(repo, "node_modules/pkg/index.js");
  await writeArtifact(repo, "logs/run.log");
  await writeArtifact(repo, "plain.log");
  for (const relative of [
    "aaa.txt",
    "bbb.txt",
    "ccc.txt",
    "ddd.txt",
    "eee.txt",
    "fff.txt",
    "ggg.txt",
    "hhh.txt",
    "iii.txt",
    "jjj.txt",
    "yyy.txt",
    "zzz.txt",
  ]) {
    await writeArtifact(repo, relative);
  }

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.deepEqual(findingPaths(result), [".omo"]);
  assert.deepEqual(pathsFromRecords(result.exclusions), ["node_modules"]);
  assert.deepEqual(
    {
      summary: {
        candidateCount: result.summary.candidateCount,
        findingCount: result.summary.findingCount,
        exclusionCount: result.summary.exclusionCount,
        reviewableCandidateCount: recordField(result.summary, "reviewableCandidateCount"),
        reviewableShownCount: recordField(result.summary, "reviewableShownCount"),
        reviewableOmittedCount: recordField(result.summary, "reviewableOmittedCount"),
        reviewableTruncated: recordField(result.summary, "reviewableTruncated"),
      },
      reviewableCandidates: recordField(result, "reviewableCandidates"),
    },
    {
      summary: {
        candidateCount: 16,
        findingCount: 1,
        exclusionCount: 1,
        reviewableCandidateCount: 14,
        reviewableShownCount: 12,
        reviewableOmittedCount: 2,
        reviewableTruncated: true,
      },
      reviewableCandidates: [
        { path: "aaa.txt", status: "untracked", reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["aaa.txt"]' },
        { path: "bbb.txt", status: "untracked", reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["bbb.txt"]' },
        { path: "ccc.txt", status: "untracked", reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["ccc.txt"]' },
        { path: "ddd.txt", status: "untracked", reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["ddd.txt"]' },
        { path: "eee.txt", status: "untracked", reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["eee.txt"]' },
        { path: "fff.txt", status: "untracked", reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["fff.txt"]' },
        { path: "ggg.txt", status: "untracked", reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["ggg.txt"]' },
        { path: "hhh.txt", status: "untracked", reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["hhh.txt"]' },
        { path: "iii.txt", status: "untracked", reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["iii.txt"]' },
        { path: "jjj.txt", status: "untracked", reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["jjj.txt"]' },
        { path: "logs", status: "ignored", reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["logs"] allowRecursive=true' },
        { path: "plain.log", status: "ignored", reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["plain.log"]' },
      ],
    },
  );
});

test("hygiene scanner keeps reviewable delete suggestions narrow when siblings include hygiene findings", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "foo/node-compile-cache/cache.blob");
  await writeArtifact(repo, "foo/ordinary.txt");

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.deepEqual(findingPaths(result), ["foo/node-compile-cache"]);
  assert.deepEqual(recordField(result, "reviewableCandidates"), [
    { path: "foo/ordinary.txt", status: "untracked", reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["foo/ordinary.txt"]' },
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
    { path: "foo/ordinary.txt", status: "untracked", reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["foo/ordinary.txt"]' },
  ]);
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

test("guardian_status includes hygiene metadata without changing dirty files", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "librarian-status/file.txt");

  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(Array.isArray(status.dirtyFiles), true);
  assert.equal(status.dirtyFiles.some((entry: string) => entry.startsWith("librarian-status")), true);
  assert.equal(status.hygiene.ok, true);
  assert.ok(status.hygiene.summary);
  assert.equal(status.hygiene.summary.findingCount, 1);
  assert.equal(status.hygiene.findings[0].path, "librarian-status");
});

test("git NUL-separated streaming handles hygiene-sized candidate output without exec maxBuffer", async () => {
  const repo = await createRepo();
  const script = path.join(await createTempDir("guardian-hygiene-stream-"), "emit-large-output.mjs");
  await fs.writeFile(script, `
const suffix = "x".repeat(90);
for (let index = 0; index < 120000; index += 1) {
  process.stdout.write(` + "`entry-${String(index).padStart(6, \"0\")}-${suffix}\\0`" + `);
}
`);

  const entries = await runGitNullSeparated(repo, ["-c", `alias.guardian-stream=!node ${JSON.stringify(script)}`, "guardian-stream"]);

  assert.equal(entries.length, 120000);
  assert.equal(entries[0], `entry-000000-${"x".repeat(90)}`);
  assert.equal(entries.at(-1), `entry-119999-${"x".repeat(90)}`);
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

test("hygiene cleanup apply blocks stale tokens when approved target contents change", async () => {
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, "librarian-stale"), { recursive: true });
  await fs.writeFile(path.join(repo, "librarian-stale", "file.txt"), "original\n");
  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", cleanupPaths: ["librarian-stale"] });
  assert.equal(plan.status, "planned");

  await fs.writeFile(path.join(repo, "librarian-stale", "file.txt"), "replaced\n");
  const apply = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "apply", cleanupPaths: ["librarian-stale"], confirmToken: plan.confirmToken });

  assert.equal(apply.ok, false);
  assert.equal(apply.status, "blocked");
  assert.match(String(apply.reason), /confirm token mismatch/);
  assert.equal(await pathExists(path.join(repo, "librarian-stale")), true);
});

test("hygiene cleanup blocks unsafe selected cleanup roots", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "librarian-mixed/tracked.txt");
  await git(repo, ["add", "librarian-mixed/tracked.txt"]);
  await git(repo, ["commit", "-m", "track mixed cleanup root"]);
  await writeArtifact(repo, "librarian-mixed/extra.txt");
  await fs.symlink("README.md", path.join(repo, "librarian-link"));
  await writeArtifact(repo, "node_modules/librarian-protected/file.txt");

  const plan = await guardianHygiene({
    repoRoot: repo,
    config: DEFAULT_CONFIG,
    mode: "plan",
    cleanupPaths: [
      "librarian-mixed",
      "librarian-link",
      "node_modules/librarian-protected",
      "librarian-missing",
      path.join(repo, "..", "outside-cleanup"),
      ".git",
    ],
  });

  const reasons = (plan.blockers as Array<Record<string, unknown>>).map((blocker) => String(blocker.reason)).join("\n");
  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.match(reasons, /tracked files/);
  assert.match(reasons, /symlink cleanup roots/);
  assert.match(reasons, /protected node_modules directory/);
  assert.match(reasons, /missing/);
  assert.match(reasons, /outside the repository root/);
  assert.match(reasons, /\.git metadata/);
});

test("hygiene cleanup blocks dirty nested git repositories even when category is explicitly allowed", async () => {
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

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", cleanupPaths: ["research-clone"], allowCategories: ["nested-git"] });

  assert.equal(plan.ok, false);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.confirmToken, undefined);
  assert.equal((plan.blockers as Array<Record<string, unknown>>).some((blocker) => /dirty nested Git/.test(String(blocker.reason)) && blocker.fatal === true), true);
  assert.equal(await pathExists(nested), true);
});

test("hygiene cleanup can explicitly plan dirty nested git repositories", async () => {
  const repo = await createRepo();
  const nested = path.join(repo, "guardian-dirty-trash");
  await fs.mkdir(nested, { recursive: true });
  await git(nested, ["init", "-b", "main"]);
  await git(nested, ["config", "user.email", "guardian@example.test"]);
  await git(nested, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(nested, "README.md"), "nested\n");
  await git(nested, ["add", "README.md"]);
  await git(nested, ["commit", "-m", "nested initial"]);
  await fs.writeFile(path.join(nested, "dirty.txt"), "dirty\n");

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", cleanupPaths: ["guardian-dirty-trash"], allowCategories: ["nested-git"], allowDirtyNestedGit: true });

  assert.equal(plan.ok, true);
  assert.equal(plan.status, "planned");
  assert.deepEqual((plan.targets as Array<Record<string, unknown>>).map((target) => target.path), ["guardian-dirty-trash"]);
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

test("hygiene cleanup applies dirty nested git repositories with the explicit override", async () => {
  const repo = await createRepo();
  const nested = path.join(repo, "guardian-dirty-apply");
  await fs.mkdir(nested, { recursive: true });
  await git(nested, ["init", "-b", "main"]);
  await git(nested, ["config", "user.email", "guardian@example.test"]);
  await git(nested, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(nested, "README.md"), "nested\n");
  await git(nested, ["add", "README.md"]);
  await git(nested, ["commit", "-m", "nested initial"]);
  await fs.writeFile(path.join(nested, "dirty.txt"), "dirty\n");

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", cleanupPaths: ["guardian-dirty-apply"], allowCategories: ["nested-git"], allowDirtyNestedGit: true });
  assert.equal(plan.status, "planned");

  const apply = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "apply", cleanupPaths: ["guardian-dirty-apply"], allowCategories: ["nested-git"], allowDirtyNestedGit: true, confirmToken: plan.confirmToken });

  assert.equal(apply.ok, true);
  assert.equal(apply.status, "cleaned");
  assert.deepEqual((apply.removedTargets as Array<Record<string, unknown>>).map((target) => target.path), ["guardian-dirty-apply"]);
  assert.equal(await pathExists(nested), false);
});

test("hygiene cleanup removes file targets and fingerprints symlinked contents", async () => {
  const repo = await createRepo();
  await fs.writeFile(path.join(repo, "node-compile-cache"), "cache-blob\n");
  await writeArtifact(repo, "librarian-linked/file.txt");
  await fs.symlink("file.txt", path.join(repo, "librarian-linked", "link"));

  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan" });

  assert.equal(plan.status, "planned");
  const targets = plan.targets as Array<Record<string, unknown>>;
  assert.deepEqual(targets.map((target) => [target.path, target.kind]), [["librarian-linked", "directory"], ["node-compile-cache", "file"]]);
  const linkedFingerprint = targets[0].fingerprint as Array<Record<string, unknown>>;
  assert.equal(linkedFingerprint.some((entry) => entry.kind === "symlink" && entry.target === "file.txt"), true);

  const apply = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "apply", confirmToken: plan.confirmToken });

  assert.equal(apply.status, "cleaned");
  assert.equal(await pathExists(path.join(repo, "node-compile-cache")), false);
  assert.equal(await pathExists(path.join(repo, "librarian-linked")), false);
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
