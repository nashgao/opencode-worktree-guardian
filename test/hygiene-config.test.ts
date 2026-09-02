import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadGuardianConfig, clearConfigCache } from "../src/hygiene-config.ts";
import { knownCleanableMatch } from "../src/hygiene-classification.ts";

function makeTempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guardian-hygiene-config-")));
}

test("loadGuardianConfig returns null when no .guardian.json exists", () => {
  clearConfigCache();
  const tmp = makeTempDir();
  try {
    const result = loadGuardianConfig(tmp);
    assert.equal(result, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadGuardianConfig returns parsed config when file exists", () => {
  clearConfigCache();
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

test("loadGuardianConfig returns null on invalid JSON without throwing", () => {
  clearConfigCache();
  const tmp = makeTempDir();
  try {
    fs.writeFileSync(path.join(tmp, ".guardian.json"), "not valid json {{{");
    const result = loadGuardianConfig(tmp);
    assert.equal(result, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadGuardianConfig caches per repoRoot", () => {
  clearConfigCache();
  const tmp = makeTempDir();
  try {
    const config = { hygiene: { knownCleanable: ["*.log"] } };
    fs.writeFileSync(path.join(tmp, ".guardian.json"), JSON.stringify(config));
    const first = loadGuardianConfig(tmp);
    fs.unlinkSync(path.join(tmp, ".guardian.json"));
    const second = loadGuardianConfig(tmp);
    assert.deepEqual(first, config);
    assert.strictEqual(first, second);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("knownCleanableMatch with config glob pattern matches correctly", () => {
  clearConfigCache();
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
  clearConfigCache();
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

test("new built-in patterns match expected artifacts", () => {
  const cases: Array<{ input: string; expectedPath: string; expectedReason: string }> = [
    { input: "jest_dx/file", expectedPath: "jest_dx", expectedReason: "Jest transform cache" },
    { input: ".playwright-mcp/session", expectedPath: ".playwright-mcp", expectedReason: "Playwright MCP session artifacts" },
    { input: "v8-compile-cache-501/data", expectedPath: "v8-compile-cache-501", expectedReason: "V8 compile cache" },
    { input: "xfs-abc123/tmp", expectedPath: "xfs-abc123", expectedReason: "ephemeral session temp file" },
    { input: "dist-types/index.d.ts", expectedPath: "dist-types", expectedReason: "TypeScript declaration output" },
    { input: "e2e-test-report/results.html", expectedPath: "e2e-test-report", expectedReason: "stale e2e test report" },
    { input: "screenshot.png", expectedPath: "screenshot.png", expectedReason: "root-level image artifact" },
    { input: "core-js-banners/notice", expectedPath: "core-js-banners", expectedReason: "npm install artifact" },
    { input: ".previews/img.png", expectedPath: ".previews", expectedReason: "preview image artifacts" },
    { input: "playwright-transform-cache-42/data", expectedPath: "playwright-transform-cache-42", expectedReason: "Playwright transform cache" },
  ];
  for (const { input, expectedPath, expectedReason } of cases) {
    const result = knownCleanableMatch(input);
    assert.ok(result, `expected match for "${input}"`);
    assert.equal(result.path, expectedPath, `path mismatch for "${input}"`);
    assert.equal(result.reason, expectedReason, `reason mismatch for "${input}"`);
  }
});

test("new built-in patterns do NOT match non-artifacts", () => {
  const noMatch = knownCleanableMatch("src/screenshot.png");
  assert.equal(noMatch, null, "src/screenshot.png should not match (not root-level)");

  const noMatchFile = knownCleanableMatch("jest_dx.ts");
  assert.equal(noMatchFile, null, "jest_dx.ts should not match (file name, not directory segment)");
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
