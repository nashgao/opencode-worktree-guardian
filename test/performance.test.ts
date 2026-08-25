import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { classifyGuardCommand } from "../src/guards.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { runGitNullSeparated } from "../src/git.ts";
import { guardianHygiene, scanWorkspaceHygiene } from "../src/hygiene.ts";
import { readState, getGuardianPaths } from "../src/state.ts";
import { createRepo, createTempDir, git, seedSession } from "./helpers.ts";

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

test("long command strings classify quickly and safely", () => {
  const command = `${"printf safe && ".repeat(250)}bash -c "git restore ."`;
  const started = performance.now();
  const result = classifyGuardCommand(command);
  assert.equal(result.blocked, true);
  assert.equal(performance.now() - started < 250, true);
});

test("large guardian state remains readable", async () => {
  const repo = await createRepo();
  for (let index = 0; index < 40; index += 1) {
    await seedSession(repo, {
      session_id: `ses_large_${index}`,
      status: "active",
      branch: `guardian/large-${index}`,
      worktree_path: repo,
      base_ref: "origin/main",
      safety_refs: [],
    });
  }
  const paths = await getGuardianPaths(repo);
  const started = performance.now();
  const state = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(Object.keys(state.sessions).length, 40);
  assert.equal(performance.now() - started < 250, true);
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

  await git(repo, ["config", "alias.guardian-stream", `!node ${JSON.stringify(script)}`]);
  const entries = await runGitNullSeparated(repo, ["guardian-stream"]);

  assert.equal(entries.length, 120000);
  assert.equal(entries[0], `entry-000000-${"x".repeat(90)}`);
  assert.equal(entries.at(-1), `entry-119999-${"x".repeat(90)}`);
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
  assert.deepEqual(findingPaths(result), []);
  assert.deepEqual(pathsFromRecords(result.exclusions), [".omo", "node_modules"]);
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
        findingCount: 0,
        exclusionCount: 2,
        reviewableCandidateCount: 14,
        reviewableShownCount: 14,
        reviewableOmittedCount: 0,
        reviewableTruncated: false,
      },
      reviewableCandidates: [
        { path: "aaa.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["aaa.txt"]' },
        { path: "bbb.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["bbb.txt"]' },
        { path: "ccc.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["ccc.txt"]' },
        { path: "ddd.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["ddd.txt"]' },
        { path: "eee.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["eee.txt"]' },
        { path: "fff.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["fff.txt"]' },
        { path: "ggg.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["ggg.txt"]' },
        { path: "hhh.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["hhh.txt"]' },
        { path: "iii.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["iii.txt"]' },
        { path: "jjj.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["jjj.txt"]' },
        { path: "logs", status: "ignored", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["logs"] allowRecursive=true' },
        { path: "plain.log", status: "ignored", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["plain.log"]' },
        { path: "yyy.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["yyy.txt"]' },
        { path: "zzz.txt", status: "untracked", fileCount: 1, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["zzz.txt"]' },
      ].map((candidate) => ({ ...candidate, bytes: 9, bytesTruncated: false })),
    },
  );
});

test("reviewable inventory includes the largest candidates and every smaller path", async () => {
  const repo = await createRepo();
  for (const name of ["aaa", "bbb", "ccc", "ddd", "eee", "fff", "ggg", "hhh", "iii", "jjj", "kkk", "lll"]) {
    await writeArtifact(repo, `${name}.txt`);
  }
  for (const name of ["one", "two", "three", "four", "five"]) {
    await writeArtifact(repo, `zzz-bulk/${name}.txt`);
  }

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });
  const candidates = recordField(result, "reviewableCandidates") as Array<Record<string, unknown>>;
  const summary = result.summary as Record<string, unknown>;

  assert.equal(summary.candidateCount, 17);
  assert.equal(summary.reviewableCandidateCount, 13);
  assert.equal(summary.reviewableShownCount, 13);
  assert.equal(summary.reviewableOmittedCount, 0);
  assert.equal(summary.reviewableTotalFileCount, 17);

  assert.equal(candidates[0]?.path, "zzz-bulk");
  assert.equal(candidates[0]?.fileCount, 5);
  assert.ok(candidates.some((candidate) => candidate.path === "lll.txt"));
});

test("hygiene scanner keeps reviewable delete suggestions narrow when siblings include hygiene findings", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "foo/node-compile-cache/cache.blob");
  await writeArtifact(repo, "foo/ordinary.txt");

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.deepEqual(findingPaths(result), ["foo/node-compile-cache"]);
  assert.deepEqual(recordField(result, "reviewableCandidates"), [
    { path: "foo/ordinary.txt", status: "untracked", fileCount: 1, bytes: 9, bytesTruncated: false, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["foo/ordinary.txt"]' },
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
    { path: "src/ordinary.txt", status: "ignored", fileCount: 1, bytes: 11, bytesTruncated: false, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["src/ordinary.txt"]' },
  ]);
});

test("hygiene scanner keeps nested protected exclusions from suppressing reviewable siblings", async () => {
  const repo = await createRepo();
  await writeArtifact(repo, "foo/node_modules/pkg/index.js");
  await writeArtifact(repo, "foo/ordinary.txt");

  const result = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });

  assert.equal(result.ok, true);
  assert.deepEqual(pathsFromRecords(result.exclusions), ["foo/node_modules"]);
  const protectedExclusion = result.exclusions.find((entry) => entry.path === "foo/node_modules");
  assert.equal(recordField(protectedExclusion ?? {}, "suggestedDeletePathCommand"), undefined);
  assert.deepEqual(recordField(result, "reviewableCandidates"), [
    { path: "foo/ordinary.txt", status: "untracked", fileCount: 1, bytes: 9, bytesTruncated: false, reason: "not matched by Guardian hygiene cleanup rules", source: "git ls-files --others/--ignored", suggestedDeletePathCommand: 'guardian_delete_paths mode=plan paths=["foo/ordinary.txt"]' },
  ]);
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

test("readiness keeps each command timeout finite and sufficient for verification", async () => {
  const readiness = await readFile(new URL("../scripts/readiness.ts", import.meta.url), "utf8");

  assert.match(readiness, /const commandTimeoutMs = 1500000;/);
  assert.match(readiness, /timeout: commandTimeoutMs,/);
  assert.match(readiness, /killSignal: "SIGTERM",/);
});
