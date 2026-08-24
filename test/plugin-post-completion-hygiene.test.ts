import assert from "node:assert/strict";
import test from "node:test";
import { formatGuardianOutput } from "../src/plugin/readable-output.ts";

test("completion output renders the full attached hygiene inventory", () => {
  // Given
  const result = {
    ok: true,
    status: "completed",
    postCompletionHygiene: {
      status: "satisfied",
      inventory: {
        ok: true,
        summary: {
          findingCount: 2,
          reviewableCandidateCount: 1,
          reviewableOmittedCount: 0,
          filesystemOnlyEmptyDirectoryCount: 1,
          filesystemOnlyEmptyDirectoryScanComplete: true,
        },
        findings: [
          { path: "space-shadow-session", category: "filesystem-only-empty-directory", reason: "generated guarded shadow workspace" },
          { path: "research-dump", category: "suspicious", reason: "requires review" },
        ],
        reviewableCandidates: [{ path: "ordinary.log", status: "untracked", fileCount: 1, reason: "review first" }],
        filesystemOnlyEmptyDirectories: [{ path: "space-shadow-session", classification: "known-cleanable", reason: "generated guarded shadow workspace" }],
      },
    },
  };

  // When
  const output = formatGuardianOutput("guardian_done", result);

  // Then
  assert.match(output, /post-completion hygiene: satisfied/);
  assert.match(output, /findings: 2 \| reviewable: 1 \| filesystem-only empty directories: 1 \| omitted: 0/);
  assert.match(output, /space-shadow-session/);
  assert.match(output, /research-dump/);
  assert.match(output, /ordinary\.log/);
});
