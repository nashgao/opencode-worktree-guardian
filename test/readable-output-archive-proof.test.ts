import assert from "node:assert/strict";
import test from "node:test";
import { formatGuardianDeleteOutput, formatGuardianDeletePathsOutput } from "../src/plugin/readable-output-cleanup.ts";

const archiveSha256 = "a".repeat(64);
const archiveProof = {
  archivePath: "/recovery/evidence.tar.gz",
  archiveSha256,
  archivedPathCount: 1,
  archivedPathProofs: [{ path: ".milestones/evidence.txt", kind: "file", mode: 420, size: 8, sha256: "b".repeat(64) }],
};

test("readable delete output exposes archive-backed recovery evidence", () => {
  // Given an archive-backed worktree deletion plan.
  const result = { ok: true, status: "planned", confirmToken: "token", preflight: { mode: "plan", targetKind: "worktree", deleteBranch: true, ...archiveProof } };

  // When the native result is rendered for an operator.
  const output = formatGuardianDeleteOutput(result);

  // Then the recovery archive, digest, count, and bounded proof are visible before confirmation.
  assert.match(output, /archive-backed paths: 1/);
  assert.match(output, /evidence\.tar\.gz/);
  assert.match(output, new RegExp(archiveSha256));
  assert.match(output, /\.milestones\/evidence\.txt/);
});

test("readable delete-paths output exposes archive-backed recovery evidence", () => {
  // Given an archive-backed protected-path deletion plan.
  const result = { ok: true, status: "planned", summary: { approvedTargetCount: 1 }, targets: [], blockers: [], preflight: { mode: "plan", paths: [".omo/redundant.tar.gz"], allowTracked: false, allowRecursive: false, ...archiveProof } };

  // When the native result is rendered for an operator.
  const output = formatGuardianDeletePathsOutput(result);

  // Then the archive identity is visible before confirmation.
  assert.match(output, /archive-backed paths: 1/);
  assert.match(output, /evidence\.tar\.gz/);
  assert.match(output, new RegExp(archiveSha256));
});
