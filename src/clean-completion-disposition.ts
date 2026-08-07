export type CleanCompletionDisposition =
  | { readonly disposition: "commit"; readonly relativePath: string }
  | { readonly disposition: "delete-known"; readonly relativePath: string }
  | { readonly disposition: "quarantine"; readonly relativePath: string }
  | { readonly disposition: "block"; readonly relativePath: string; readonly reason: CleanCompletionBlockReason };

export type CleanCompletionBlockReason =
  | "scan-incomplete"
  | "candidate-tree-missing"
  | "candidate-tree-mismatch"
  | "mixed-parent-or-commit-ancestor"
  | "protected-path"
  | "tracked-path"
  | "symlink"
  | "nested-git"
  | "active-session-conflict"
  | "ambiguous-facts"
  | "provenance-unverified"
  | "baseline-member";

export type CleanCompletionCandidateFacts = {
  readonly path: string;
  readonly status: "ignored" | "untracked";
  readonly scan: "complete" | "failed";
  readonly candidateTree: "matches" | "missing" | "mismatch";
  readonly commitPath: "exact" | "absent" | "ambiguous";
  readonly parent: "homogeneous-new" | "mixed" | "commit-ancestor";
  readonly protected: boolean;
  readonly tracked: boolean;
  readonly symlink: boolean;
  readonly nestedGit: boolean;
  readonly activeSession: "clear" | "conflict" | "ambiguous";
  readonly knownCleanable: boolean;
  readonly provenance: {
    readonly enabled: boolean;
    readonly captured: boolean;
    readonly verified: boolean;
    readonly lineageMatches: boolean;
    readonly binding: "current" | "repaired" | "superseded" | "ambiguous";
    readonly baselineComplete: boolean;
    readonly baselineContainsPath: boolean;
  };
};

function block(relativePath: string, reason: CleanCompletionBlockReason): CleanCompletionDisposition {
  return { disposition: "block", relativePath, reason };
}

export function classifyCleanCompletionDisposition(facts: CleanCompletionCandidateFacts): CleanCompletionDisposition {
  if (facts.scan === "failed") return block(facts.path, "scan-incomplete");
  if (facts.candidateTree === "missing") return block(facts.path, "candidate-tree-missing");
  if (facts.candidateTree === "mismatch") return block(facts.path, "candidate-tree-mismatch");
  if (facts.parent === "mixed" || facts.parent === "commit-ancestor") return block(facts.path, "mixed-parent-or-commit-ancestor");
  if (facts.protected) return block(facts.path, "protected-path");
  if (facts.tracked) return block(facts.path, "tracked-path");
  if (facts.symlink) return block(facts.path, "symlink");
  if (facts.nestedGit) return block(facts.path, "nested-git");
  if (facts.activeSession === "conflict" || facts.activeSession === "ambiguous") return block(facts.path, "active-session-conflict");
  if (facts.commitPath === "ambiguous") return block(facts.path, "ambiguous-facts");
  if (facts.commitPath === "exact") return { disposition: "commit", relativePath: facts.path };
  if (facts.knownCleanable) return { disposition: "delete-known", relativePath: facts.path };
  if (!facts.provenance.enabled || !facts.provenance.captured || !facts.provenance.verified || !facts.provenance.lineageMatches || facts.provenance.binding !== "current" || !facts.provenance.baselineComplete) {
    return block(facts.path, "provenance-unverified");
  }
  if (facts.provenance.baselineContainsPath) return block(facts.path, "baseline-member");
  return { disposition: "quarantine", relativePath: facts.path };
}
