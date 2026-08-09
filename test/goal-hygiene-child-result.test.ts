import assert from "node:assert/strict";
import test from "node:test";
import { projectGoalHygieneResult } from "../src/goal-hygiene-child-result.ts";

function record(value: unknown, name: string): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return Object.fromEntries(Object.entries(value));
  throw new TypeError(`${name} must be an object`);
}

function assertScalarPreviews(value: unknown, name: string): void {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  assert.equal(value.length <= 8, true);
  for (const entry of value) {
    const preview = record(entry, `${name} entry`);
    for (const field of Object.values(preview)) {
      assert.equal(field === null || ["boolean", "number", "string"].includes(typeof field), true);
    }
  }
}

function deeplyNestedValue(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (const index of Array.from({ length: depth }, (_, value) => value)) {
    const child: Record<string, unknown> = { index };
    cursor.next = child;
    cursor = child;
  }
  return root;
}

function hostileResult(): Record<string, unknown> {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const deep = deeplyNestedValue(20_000);
  const huge = "x".repeat(2 * 1024 * 1024);
  const entries = Array.from({ length: 50_000 }, (_, index) => ({
    path: `guardian-cache-${String(index).padStart(5, "0")}`,
    category: "known-cleanable",
    severity: "warn",
    reason: huge,
    kind: "directory",
    fingerprint: cyclic,
    nested: deep,
  }));
  return {
    ok: true,
    status: huge,
    reason: huge,
    confirmToken: "a".repeat(64),
    summary: {
      findingCount: entries.length,
      bySeverity: { warn: entries.length, fail: 0, nested: deep },
      byCategory: { "known-cleanable": entries.length, "nested-git": 0, suspicious: 0, cyclic },
      arbitrary: deep,
    },
    targets: entries,
    removedTargets: entries,
    blockers: entries,
    preflight: {
      repoRoot: huge,
      mode: "plan",
      allowCategories: Array.from({ length: 50_000 }, () => huge),
      allowDirtyNestedGit: false,
      summary: { findingCount: entries.length, byCategory: { "known-cleanable": entries.length, "nested-git": 0, suspicious: 0, cyclic } },
      cleanupPaths: Array.from({ length: 50_000 }, () => huge),
      targets: entries,
      blockers: entries,
      arbitrary: deep,
    },
    report: {
      action: "planned",
      mode: "plan",
      repoRoot: huge,
      summary: { findingCount: entries.length, byCategory: { "known-cleanable": entries.length, "nested-git": 0, suspicious: 0, cyclic } },
      cleanupPaths: Array.from({ length: 50_000 }, () => huge),
      approvedTargets: Array.from({ length: 50_000 }, () => huge),
      removedTargets: Array.from({ length: 50_000 }, () => huge),
      blockers: entries,
      arbitrary: deep,
    },
    suggestedCommands: Array.from({ length: 50_000 }, () => huge),
    arbitrary: cyclic,
  };
}

test("goal hygiene child result is non-recursive, fixed-schema, and byte-bounded for hostile input", () => {
  // Given
  const raw = hostileResult();

  // When
  const result = projectGoalHygieneResult(raw);
  const encoded = JSON.stringify(result);
  const preflight = record(result.preflight, "preflight");
  const report = record(result.report, "report");

  // Then
  assert.equal(Buffer.byteLength(encoded, "utf8") <= 16_384, true);
  assert.equal(result.confirmToken, "a".repeat(64));
  assert.equal(result.targetsTotal, 50_000);
  assert.equal(result.targetsOmittedCount, 49_992);
  assert.equal(preflight.targetsTotal, 50_000);
  assert.equal(report.blockersTotal, 50_000);
  assertScalarPreviews(result.targets, "targets");
  assertScalarPreviews(result.removedTargets, "removedTargets");
  assertScalarPreviews(result.blockers, "blockers");
  assertScalarPreviews(preflight.targets, "preflight targets");
  assertScalarPreviews(preflight.blockers, "preflight blockers");
  assertScalarPreviews(report.blockers, "report blockers");
});

test("goal hygiene child digest includes omitted entry 700", () => {
  // Given
  const entries = Array.from({ length: 701 }, (_, index) => ({
    path: `guardian-cache-${String(index).padStart(3, "0")}`,
    category: "known-cleanable",
    severity: "warn",
    reason: "cache",
    kind: "directory",
    fingerprint: `fingerprint-${index}`,
  }));
  const first = projectGoalHygieneResult({ ok: true, status: "planned", confirmToken: "b".repeat(64), targets: entries });
  const changedEntries = entries.map((entry, index) => index === 700 ? { ...entry, fingerprint: "changed-fingerprint" } : entry);

  // When
  const second = projectGoalHygieneResult({ ok: true, status: "planned", confirmToken: "b".repeat(64), targets: changedEntries });

  // Then
  assert.equal(first.targetsOmittedCount, 693);
  assert.notEqual(first.digest, second.digest);
});
