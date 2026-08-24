import assert from "node:assert/strict";
import test from "node:test";
import { formatGuardianHygieneOutput } from "../src/plugin/readable-output-cleanup.ts";

test("guardian_hygiene readable output warns when inventory coverage is incomplete", () => {
  const output = formatGuardianHygieneOutput({
    ok: true,
    repoRoot: "/repo",
    summary: {
      filesystemOnlyEmptyDirectoryScanComplete: false,
      findingCount: 0,
      reviewableCandidateCount: 0,
      bySeverity: { fail: 0, warn: 0 },
    },
    findings: [],
    exclusions: [],
    reviewableCandidates: [],
    filesystemOnlyEmptyDirectories: [],
  });

  assert.match(output, /^\[WARN\] guardian_hygiene scan/m);
  assert.match(output, /inventory coverage is incomplete/);
  assert.doesNotMatch(output, /^\[GOOD\] guardian_hygiene scan/m);
});
