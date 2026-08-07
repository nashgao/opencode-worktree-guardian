import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTempDir } from "./helpers.ts";

const manifestUrl = new URL("./fixtures/clean-completion-assertions.sha256", import.meta.url);
const assertionUrl = new URL("./clean-completion-e2e.test.ts", import.meta.url);
const manifestTarget = "test/clean-completion-e2e.test.ts";

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function parseManifest(manifest: string): string {
  const match = /^([0-9a-f]{64})  test\/clean-completion-e2e\.test\.ts\n$/.exec(manifest);
  if (!match?.[1]) throw new Error("clean-completion assertion manifest must contain exactly one lowercase SHA-256 record for test/clean-completion-e2e.test.ts");
  return match[1];
}

function assertPinnedBytes(bytes: Uint8Array, expected: string): void {
  assert.equal(sha256(bytes), expected, "clean-completion assertion bytes differ from the committed SHA-256 manifest");
}

test("clean-completion assertion manifest pins the raw E2E bytes and rejects one-byte disposable tampering", async (t) => {
  const expected = parseManifest(await fs.readFile(manifestUrl, "utf8"));
  const bytes = await fs.readFile(assertionUrl);
  assertPinnedBytes(bytes, expected);
  const temp = await createTempDir("clean-completion-contract-hash-");
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const tampered = Uint8Array.from(bytes);
  tampered[0] = tampered[0] === 0 ? 1 : tampered[0] - 1;
  const copy = path.join(temp, "clean-completion-e2e.test.ts");
  await fs.writeFile(copy, tampered);
  assert.throws(() => assertPinnedBytes(tampered, expected), /SHA-256 manifest/);
  assertPinnedBytes(await fs.readFile(assertionUrl), expected);
});

test("clean-completion assertion manifest rejects malformed, wrong-target, and extra records", () => {
  const digest = "a".repeat(64);
  assert.throws(() => parseManifest(`${digest} test/clean-completion-e2e.test.ts\n`), /exactly one/);
  assert.throws(() => parseManifest(`${digest}  test/other.test.ts\n`), /exactly one/);
  assert.throws(() => parseManifest(`${digest}  ${manifestTarget}\n${digest}  ${manifestTarget}\n`), /exactly one/);
  assert.throws(() => parseManifest(`${"A".repeat(64)}  ${manifestTarget}\n`), /exactly one/);
});
