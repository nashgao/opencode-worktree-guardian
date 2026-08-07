import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCleanCompletionDisposition,
  type CleanCompletionCandidateFacts,
  type CleanCompletionDisposition,
} from "../src/clean-completion-disposition.ts";

const safeCandidate = {
  path: "scratch/output.txt",
  status: "ignored",
  scan: "complete",
  candidateTree: "matches",
  commitPath: "absent",
  parent: "homogeneous-new",
  protected: false,
  tracked: false,
  symlink: false,
  nestedGit: false,
  activeSession: "clear",
  knownCleanable: false,
  provenance: {
    enabled: true,
    captured: true,
    verified: true,
    lineageMatches: true,
    binding: "current",
    baselineComplete: true,
    baselineContainsPath: false,
  },
} as const satisfies CleanCompletionCandidateFacts;

type Case = {
  readonly name: string;
  readonly facts: CleanCompletionCandidateFacts;
  readonly expected: CleanCompletionDisposition;
};

const cases: readonly Case[] = [
  {
    name: "commits exact verified intent before hygiene labels",
    facts: { ...safeCandidate, path: "librarian/output.ts", knownCleanable: true, commitPath: "exact" },
    expected: { disposition: "commit", relativePath: "librarian/output.ts" },
  },
  {
    name: "deletes known-cleanable safe residue",
    facts: { ...safeCandidate, path: ".omc/session.json", knownCleanable: true },
    expected: { disposition: "delete-known", relativePath: ".omc/session.json" },
  },
  {
    name: "quarantines only verified post-baseline residue",
    facts: safeCandidate,
    expected: { disposition: "quarantine", relativePath: "scratch/output.txt" },
  },
  {
    name: "blocks absent provenance",
    facts: { ...safeCandidate, provenance: { ...safeCandidate.provenance, captured: false } },
    expected: { disposition: "block", relativePath: "scratch/output.txt", reason: "provenance-unverified" },
  },
  {
    name: "blocks baseline members rather than calling them session-authored",
    facts: { ...safeCandidate, provenance: { ...safeCandidate.provenance, baselineContainsPath: true } },
    expected: { disposition: "block", relativePath: "scratch/output.txt", reason: "baseline-member" },
  },
  {
    name: "blocks candidate-tree mismatch even for an exact commit path",
    facts: { ...safeCandidate, commitPath: "exact", candidateTree: "mismatch" },
    expected: { disposition: "block", relativePath: "scratch/output.txt", reason: "candidate-tree-mismatch" },
  },
  {
    name: "blocks mixed parents",
    facts: { ...safeCandidate, parent: "mixed" },
    expected: { disposition: "block", relativePath: "scratch/output.txt", reason: "mixed-parent-or-commit-ancestor" },
  },
  {
    name: "blocks commit ancestors",
    facts: { ...safeCandidate, parent: "commit-ancestor" },
    expected: { disposition: "block", relativePath: "scratch/output.txt", reason: "mixed-parent-or-commit-ancestor" },
  },
  {
    name: "blocks protected paths",
    facts: { ...safeCandidate, protected: true },
    expected: { disposition: "block", relativePath: "scratch/output.txt", reason: "protected-path" },
  },
  {
    name: "blocks tracked paths",
    facts: { ...safeCandidate, tracked: true },
    expected: { disposition: "block", relativePath: "scratch/output.txt", reason: "tracked-path" },
  },
  {
    name: "blocks symlinks",
    facts: { ...safeCandidate, symlink: true },
    expected: { disposition: "block", relativePath: "scratch/output.txt", reason: "symlink" },
  },
  {
    name: "blocks nested Git repositories",
    facts: { ...safeCandidate, nestedGit: true },
    expected: { disposition: "block", relativePath: "scratch/output.txt", reason: "nested-git" },
  },
  {
    name: "blocks multiple active-session ownership",
    facts: { ...safeCandidate, activeSession: "conflict" },
    expected: { disposition: "block", relativePath: "scratch/output.txt", reason: "active-session-conflict" },
  },
  {
    name: "blocks repaired provenance bindings",
    facts: { ...safeCandidate, provenance: { ...safeCandidate.provenance, binding: "repaired" } },
    expected: { disposition: "block", relativePath: "scratch/output.txt", reason: "provenance-unverified" },
  },
  {
    name: "blocks superseded provenance bindings",
    facts: { ...safeCandidate, provenance: { ...safeCandidate.provenance, binding: "superseded" } },
    expected: { disposition: "block", relativePath: "scratch/output.txt", reason: "provenance-unverified" },
  },
  {
    name: "blocks incomplete scans",
    facts: { ...safeCandidate, scan: "failed" },
    expected: { disposition: "block", relativePath: "scratch/output.txt", reason: "scan-incomplete" },
  },
  {
    name: "fails closed for ambiguous prepared facts",
    facts: { ...safeCandidate, commitPath: "ambiguous" },
    expected: { disposition: "block", relativePath: "scratch/output.txt", reason: "ambiguous-facts" },
  },
  {
    name: "blocks untracked residues without exact candidate-tree proof",
    facts: { ...safeCandidate, status: "untracked", candidateTree: "missing" },
    expected: { disposition: "block", relativePath: "scratch/output.txt", reason: "candidate-tree-missing" },
  },
];

for (const scenario of cases) {
  test(`classifyCleanCompletionDisposition ${scenario.name}`, () => {
    const result = classifyCleanCompletionDisposition(scenario.facts);
    assert.deepEqual(result, scenario.expected);
  });
}

test("classifyCleanCompletionDisposition always returns one allowed disposition", () => {
  const results = cases.map(({ facts }) => classifyCleanCompletionDisposition(facts));
  assert.deepEqual(new Set(results.map((result) => result.disposition)), new Set(["commit", "delete-known", "quarantine", "block"]));
});
