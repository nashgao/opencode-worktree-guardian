import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { loadGuardianConfig } from "../src/hygiene-config.ts";
import { knownCleanableMatch } from "../src/hygiene-classification.ts";
import { guardianHygiene, scanWorkspaceHygiene } from "../src/hygiene.ts";
import { createRepo } from "./helpers.ts";

function makeTempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guardian-hygiene-config-")));
}

test("loadGuardianConfig returns null when no .guardian.json exists", () => {
  const tmp = makeTempDir();
  try {
    const result = loadGuardianConfig(tmp);
    assert.equal(result, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadGuardianConfig returns parsed config when file exists", () => {
  const tmp = makeTempDir();
  try {
    const config = { hygiene: { knownCleanable: ["**/*.log"], alwaysKeep: ["important.log"] } };
    fs.writeFileSync(path.join(tmp, ".guardian.json"), JSON.stringify(config));
    const result = loadGuardianConfig(tmp);
    assert.deepEqual(result, config);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("public hygiene scan and cleanup fail closed when .guardian.json is invalid", async (t) => {
  // Given a built-in cleanup candidate and malformed repository hygiene policy.
  const repo = await createRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, "node-compile-cache"));
  fs.writeFileSync(path.join(repo, "node-compile-cache/cache.bin"), "retain\n");
  fs.writeFileSync(path.join(repo, ".guardian.json"), "not valid json {{{");

  // When the public scan and cleanup planner read the policy.
  const scan = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });
  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan" });

  // Then both surfaces fail closed and leave the candidate intact.
  assert.equal(scan.ok, false, JSON.stringify(scan));
  assert.match(String(scan.reason), /.guardian.json/);
  assert.equal(plan.ok, false, JSON.stringify(plan));
  assert.equal(plan.status, "blocked");
  assert.equal(fs.readFileSync(path.join(repo, "node-compile-cache/cache.bin"), "utf8"), "retain\n");
});

test("loadGuardianConfig re-reads repository policy", () => {
  const tmp = makeTempDir();
  try {
    const config = { hygiene: { knownCleanable: ["*.log"] } };
    fs.writeFileSync(path.join(tmp, ".guardian.json"), JSON.stringify(config));
    const first = loadGuardianConfig(tmp);
    const replacement = { hygiene: { alwaysKeep: ["*.log"] } };
    fs.writeFileSync(path.join(tmp, ".guardian.json"), JSON.stringify(replacement));
    const second = loadGuardianConfig(tmp);
    assert.deepEqual(first, config);
    assert.deepEqual(second, replacement);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("public hygiene apply rejects stale approval after alwaysKeep policy changes", async (t) => {
  // Given a plan approving a repository-configured cleanup path.
  const repo = await createRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, "generated"));
  fs.writeFileSync(path.join(repo, "generated/result.log"), "retain after policy change\n");
  fs.writeFileSync(path.join(repo, ".guardian.json"), JSON.stringify({ hygiene: { knownCleanable: ["generated/**"] } }));
  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", allowCategories: ["known-cleanable"] });
  assert.equal(plan.status, "planned", JSON.stringify(plan));

  // When retention policy changes before the approved plan is applied.
  fs.writeFileSync(path.join(repo, ".guardian.json"), JSON.stringify({ hygiene: { knownCleanable: ["generated/**"], alwaysKeep: ["generated/**"] } }));
  const apply = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "apply", allowCategories: ["known-cleanable"], confirmToken: plan.confirmToken });

  // Then the stale approval is blocked and retained data remains.
  assert.equal(apply.status, "blocked", JSON.stringify(apply));
  assert.equal(fs.readFileSync(path.join(repo, "generated/result.log"), "utf8"), "retain after policy change\n");
});

test("alwaysKeep descendant blocks a built-in cleanup ancestor through public scan and plan", async (t) => {
  // Given a built-in cleanup root containing data selected by retention policy.
  const repo = await createRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, "node-compile-cache"));
  fs.writeFileSync(path.join(repo, "node-compile-cache/disposable.bin"), "discardable\n");
  fs.writeFileSync(path.join(repo, "node-compile-cache/retained.bin"), "retained\n");
  fs.writeFileSync(path.join(repo, ".guardian.json"), JSON.stringify({ hygiene: { alwaysKeep: ["node-compile-cache/retained.bin"] } }));

  // When the public scan and cleanup planner classify the built-in root.
  const scan = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });
  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", allowCategories: ["known-cleanable"] });

  // Then neither surface approves the ancestor that contains retained data.
  assert.equal(scan.ok, true, JSON.stringify(scan));
  assert.equal(scan.findings.some((finding) => finding.path === "node-compile-cache" && finding.category === "known-cleanable"), false, JSON.stringify(scan));
  assert.equal(scan.exclusions.some((exclusion) => exclusion.path === "node-compile-cache/retained.bin" && exclusion.cleanupAuthorized === false), true, JSON.stringify(scan));
  assert.equal(plan.status, "blocked", JSON.stringify(plan));
  assert.deepEqual(plan.targets, []);
  assert.equal(fs.readFileSync(path.join(repo, "node-compile-cache/retained.bin"), "utf8"), "retained\n");
});

test("knownCleanableMatch with config glob pattern matches correctly", () => {
  const tmp = makeTempDir();
  try {
    fs.writeFileSync(path.join(tmp, ".guardian.json"), JSON.stringify({
      hygiene: { knownCleanable: ["**/*.log", "tmp/**"] },
    }));
    const logMatch = knownCleanableMatch("build/output.log", tmp);
    assert.ok(logMatch);
    assert.equal(logMatch.path, "build/output.log");
    assert.equal(logMatch.reason, "matched .guardian.json knownCleanable pattern");

    const tmpMatch = knownCleanableMatch("tmp/scratch.txt", tmp);
    assert.ok(tmpMatch);
    assert.equal(tmpMatch.path, "tmp/scratch.txt");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("knownCleanableMatch with alwaysKeep pattern prevents cleanup", () => {
  const tmp = makeTempDir();
  try {
    fs.writeFileSync(path.join(tmp, ".guardian.json"), JSON.stringify({
      hygiene: {
        knownCleanable: ["**/*.log"],
        alwaysKeep: ["important.log"],
      },
    }));
    const kept = knownCleanableMatch("important.log", tmp);
    assert.equal(kept, null);

    const cleaned = knownCleanableMatch("debug.log", tmp);
    assert.ok(cleaned);
    assert.equal(cleaned.reason, "matched .guardian.json knownCleanable pattern");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("knownCleanableMatch without repoRoot falls through to hardcoded defaults", () => {
  const result = knownCleanableMatch("node-compile-cache/cache.blob");
  assert.ok(result);
  assert.equal(result.path, "node-compile-cache");
  assert.equal(result.reason, "generated Node compile cache");
});

test("missing config preserves the pre-feature built-in classification boundary", () => {
  const paths = [
    "jest_dx/file",
    ".playwright-mcp/session",
    "v8-compile-cache-501/data",
    "xfs-abc123/file",
    "dist-types/index.d.ts",
    "e2e-test-report/results.html",
    "screenshot.png",
    "core-js-banners/notice",
    ".previews/img.png",
    "playwright-transform-cache-42/data",
  ];
  for (const candidate of paths) {
    assert.equal(knownCleanableMatch(candidate), null, `unexpected default cleanup classification for "${candidate}"`);
  }
});

test("new built-in patterns do NOT match non-artifacts", () => {
  const noMatch = knownCleanableMatch("src/screenshot.png");
  assert.equal(noMatch, null, "src/screenshot.png should not match (not root-level)");

  const noMatchFile = knownCleanableMatch("jest_dx.ts");
  assert.equal(noMatchFile, null, "jest_dx.ts should not match (file name, not directory segment)");
});

test("public hygiene scan keeps broad evidence and report names reviewable by default", async (t) => {
  // Given untracked evidence artifacts whose names alone do not prove disposability.
  const repo = await createRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  for (const relative of [
    "screenshot.png",
    ".previews/image.png",
    ".playwright-mcp/session.json",
    "e2e-test-report/results.html",
    "jest_dx/file",
    "v8-compile-cache-501/data",
    "xfs-abc123/file",
    "dist-types/index.d.ts",
    "core-js-banners/notice",
    "playwright-transform-cache-42/data",
  ]) {
    fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
    fs.writeFileSync(path.join(repo, relative), "retain for review\n");
  }

  // When the public scanner runs without repository hygiene configuration.
  const scan = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });

  // Then none of those broad names becomes an automatic cleanup finding.
  assert.equal(scan.ok, true, JSON.stringify(scan));
  assert.equal(scan.findings.some((finding) => finding.category === "known-cleanable"), false, JSON.stringify(scan));
  assert.equal(scan.reviewableCandidates.length, 10, JSON.stringify(scan));
});

test("public hygiene scan classifies an explicitly configured preview path", async (t) => {
  // Given an explicit repository policy approving preview artifacts.
  const repo = await createRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, ".previews"));
  fs.writeFileSync(path.join(repo, ".previews/image.png"), "configured disposable preview\n");
  fs.writeFileSync(path.join(repo, ".guardian.json"), JSON.stringify({ hygiene: { knownCleanable: [".previews/**"] } }));

  // When the public scanner applies that policy.
  const scan = await scanWorkspaceHygiene({ repoRoot: repo, config: DEFAULT_CONFIG });

  // Then the specifically approved path is known-cleanable.
  assert.equal(scan.ok, true, JSON.stringify(scan));
  assert.equal(scan.findings.some((finding) => finding.path === ".previews/image.png" && finding.category === "known-cleanable"), true, JSON.stringify(scan));
});

test("alwaysKeep blocks filesystem empty-directory cleanup", async (t) => {
  // Given an empty directory covered by both cleanup and retention patterns.
  const repo = await createRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, "generated/retained"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".guardian.json"), JSON.stringify({ hygiene: { knownCleanable: ["generated/**"], alwaysKeep: ["generated/retained"] } }));

  // When the public cleanup planner inventories filesystem-only empty directories.
  const plan = await guardianHygiene({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan" });

  // Then the retained directory is not an approved cleanup target.
  assert.equal(plan.status, "blocked", JSON.stringify(plan));
  assert.deepEqual(plan.targets, []);
  assert.equal(fs.statSync(path.join(repo, "generated/retained")).isDirectory(), true);
});

test("public hygiene scan rejects invalid, unreadable, and symlinked policy files", { skip: process.platform === "win32" }, async (t) => {
  // Given separate repositories with structurally invalid, unreadable, and symlinked policies.
  const invalidRepo = await createRepo();
  const unreadableRepo = await createRepo();
  const symlinkRepo = await createRepo();
  const outside = makeTempDir();
  t.after(() => fs.rmSync(invalidRepo, { recursive: true, force: true }));
  t.after(() => fs.rmSync(unreadableRepo, { recursive: true, force: true }));
  t.after(() => fs.rmSync(symlinkRepo, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(invalidRepo, ".guardian.json"), JSON.stringify({ hygiene: { knownCleanable: "**/*.log" } }));
  fs.mkdirSync(path.join(unreadableRepo, ".guardian.json"));
  fs.writeFileSync(path.join(outside, "policy.json"), JSON.stringify({ hygiene: { knownCleanable: ["**"] } }));
  fs.symlinkSync(path.join(outside, "policy.json"), path.join(symlinkRepo, ".guardian.json"));

  // When the public scanner reads each untrusted boundary.
  const invalid = await scanWorkspaceHygiene({ repoRoot: invalidRepo, config: DEFAULT_CONFIG });
  const unreadable = await scanWorkspaceHygiene({ repoRoot: unreadableRepo, config: DEFAULT_CONFIG });
  const symlinked = await scanWorkspaceHygiene({ repoRoot: symlinkRepo, config: DEFAULT_CONFIG });

  // Then all scans fail closed.
  assert.equal(invalid.ok, false, JSON.stringify(invalid));
  assert.equal(unreadable.ok, false, JSON.stringify(unreadable));
  assert.equal(symlinked.ok, false, JSON.stringify(symlinked));
});

test("existing hardcoded patterns still work (regression)", () => {
  const nodeCache = knownCleanableMatch("node-compile-cache/blob");
  assert.ok(nodeCache);
  assert.equal(nodeCache.path, "node-compile-cache");

  const hyperf = knownCleanableMatch("hyperf-demo/file");
  assert.ok(hyperf);
  assert.equal(hyperf.path, "hyperf-demo");

  const tsv = knownCleanableMatch("export.tsv");
  assert.ok(tsv);
  assert.equal(tsv.reason, "generated TSV artifact");

  const tsx = knownCleanableMatch("tsx-501/cache");
  assert.ok(tsx);
  assert.equal(tsx.path, "tsx-501");

  const librarian = knownCleanableMatch("librarian-alpha/file");
  assert.ok(librarian);
  assert.equal(librarian.reason, "known librarian scratch artifact");
});
