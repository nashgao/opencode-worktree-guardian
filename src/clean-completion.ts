import path from "node:path";
import type { CleanCompletionCandidateFacts, CleanCompletionDisposition } from "./clean-completion-disposition.ts";
import { classifyCleanCompletionDisposition } from "./clean-completion-disposition.ts";
import { proveCleanCompletionUniverse } from "./clean-completion-universe.ts";
import { inspectDirtySessionDoneIntent } from "./done-intent.ts";
import { getGuardianPaths } from "./guardian-paths.ts";
import { protectedPathMatch, protectedPathsFromConfig } from "./protected-paths.ts";
import { readProvenanceManifest } from "./provenance.ts";
import { buildQuarantinePathPreflight } from "./quarantine-path-preflight.ts";
import { isProvenanceEnabled } from "./session-provenance.ts";
import type { GuardianConfig, GuardianPaths, GuardianSession } from "./types.ts";

export type CleanCompletionCandidateResult = {
  readonly relativePath: string;
  readonly disposition: CleanCompletionDisposition["disposition"];
  readonly reason?: string;
};

export type CleanCompletionFinalProofStatus = "stable" | "unstable" | "not-applicable";

export type CleanCompletionFinalProof = {
  readonly status: CleanCompletionFinalProofStatus;
  readonly reason?: string;
  readonly candidates: readonly CleanCompletionCandidateResult[];
  readonly inventoryDigest?: string;
  readonly stateVersion?: number;
  readonly worktreeCount?: number;
  readonly quarantineItemCount?: number;
};

export type CleanCompletionPlan = {
  readonly applicable: boolean;
  readonly finalProof: CleanCompletionFinalProof;
  readonly incompleteOperationCount: number;
};

export type BuildFactsInput = {
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly config: GuardianConfig;
  readonly session: GuardianSession;
  readonly paths: GuardianPaths;
  readonly relativePath: string;
  readonly commitPaths: readonly string[];
};

// Reports whether `relativePath` is itself, or is an ancestor directory of, one of the paths
// guardian_done would actually commit. That distinguishes brand-new ignored residue (safe to
// quarantine) from residue that sits underneath -- or directly overlaps -- real implementation
// changes (must never be silently moved out from under a pending commit).
function classifyParent(relativePath: string, commitPaths: readonly string[]): CleanCompletionCandidateFacts["parent"] {
  const descendantPrefix = `${relativePath}/`;
  if (commitPaths.some((commitPath) => commitPath === relativePath || commitPath.startsWith(descendantPrefix))) return "commit-ancestor";
  const segments = relativePath.split("/");
  for (let depth = 1; depth < segments.length; depth += 1) {
    const ancestor = segments.slice(0, depth).join("/");
    const ancestorPrefix = `${ancestor}/`;
    if (commitPaths.some((commitPath) => commitPath === ancestor || commitPath.startsWith(ancestorPrefix))) return "mixed";
  }
  return "homogeneous-new";
}

function classifyCommitPath(relativePath: string, commitPaths: readonly string[]): CleanCompletionCandidateFacts["commitPath"] {
  if (commitPaths.includes(relativePath)) return "exact";
  const descendantPrefix = `${relativePath}/`;
  const ancestorPrefix = `${relativePath}/`;
  const overlaps = commitPaths.some((commitPath) => commitPath.startsWith(descendantPrefix) || ancestorPrefix.startsWith(`${commitPath}/`));
  return overlaps ? "ambiguous" : "absent";
}

async function buildProvenanceFacts(input: BuildFactsInput): Promise<CleanCompletionCandidateFacts["provenance"]> {
  const notCaptured = { enabled: true, captured: false, verified: false, lineageMatches: false, binding: "ambiguous" as const, baselineComplete: false, baselineContainsPath: false };
  if (!isProvenanceEnabled(input.config)) return { ...notCaptured, enabled: false };
  const { session } = input;
  const sessionId = session.session_id;
  const lineageId = session.lineage_id;
  const reference = session.provenance?.manifest;
  const captured = session.provenance_status === "captured" && session.quarantine_eligible === true
    && typeof sessionId === "string" && sessionId.length > 0
    && typeof lineageId === "string" && lineageId.length > 0
    && typeof reference?.relativePath === "string" && typeof reference?.digest === "string";
  if (!captured || typeof sessionId !== "string" || typeof lineageId !== "string" || !reference) return notCaptured;
  try {
    const manifest = await readProvenanceManifest({ repoRoot: input.repoRoot, worktreePath: input.worktreePath, sessionId, lineageId, reference });
    const baselineContainsPath = manifest.inventory.some((entry) => entry.relativePath === input.relativePath);
    return { enabled: true, captured: true, verified: true, lineageMatches: true, binding: "current", baselineComplete: true, baselineContainsPath };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { enabled: true, captured: true, verified: false, lineageMatches: false, binding: "ambiguous", baselineComplete: false, baselineContainsPath: false };
  }
}

// Routes protected/tracked/symlink/nested-git/active-session checks through the same
// buildQuarantinePathPreflight used by the real executor, so plan-time facts and execute-time
// facts can never silently diverge. artifactRelativePath is a throwaway destination used only to
// satisfy preflight's shape -- planning never writes anything, so it does not need to be unique
// across candidates, only free of path-traversal ambiguity.
export async function buildCandidateFacts(input: BuildFactsInput): Promise<CleanCompletionCandidateFacts> {
  const sourcePath = path.join(input.worktreePath, input.relativePath);
  const artifactRelativePath = path.posix.join(String(input.session.session_id ?? "unknown-session"), "plan-preview", encodeURIComponent(input.relativePath));
  const preflight = await buildQuarantinePathPreflight({
    action: "quarantine",
    artifactRelativePath,
    config: input.config,
    metadataRoot: input.paths.quarantineDir,
    repoRoot: input.repoRoot,
    session: input.session,
    sourcePath,
  });
  const blockerReasons = preflight.blockers.map((blocker) => blocker.reason);
  const hasBlocker = (needle: string) => blockerReasons.some((reason) => reason.includes(needle));
  const sourceKind = preflight.facts.source.kind;
  const scan: CleanCompletionCandidateFacts["scan"] = hasBlocker("path preflight failed") ? "failed" : "complete";
  const candidateTree: CleanCompletionCandidateFacts["candidateTree"] = sourceKind === "missing" ? "missing" : sourceKind === "file" || sourceKind === "directory" ? "matches" : "mismatch";
  const provenance = await buildProvenanceFacts(input);
  return {
    path: input.relativePath,
    status: "ignored",
    scan,
    candidateTree,
    commitPath: classifyCommitPath(input.relativePath, input.commitPaths),
    parent: classifyParent(input.relativePath, input.commitPaths),
    protected: protectedPathMatch(input.relativePath, protectedPathsFromConfig(input.config)) !== null,
    tracked: hasBlocker("tracked source cannot be quarantined"),
    symlink: sourceKind === "symlink" || hasBlocker("symlink ancestor"),
    nestedGit: hasBlocker("nested Git repository"),
    activeSession: hasBlocker("active session bindings are ambiguous") ? "ambiguous" : "clear",
    knownCleanable: false,
    provenance,
  };
}

function candidateResult(relativePath: string, disposition: CleanCompletionDisposition): CleanCompletionCandidateResult {
  return disposition.disposition === "block" ? { relativePath, disposition: disposition.disposition, reason: disposition.reason } : { relativePath, disposition: disposition.disposition };
}

// Plan-time only: every step here reads state without mutating it (preflight, provenance manifest
// read, journal enumeration, dirty/ignored inspection), so guardian_goal mode=plan can call this
// freely. Facts are gathered twice, sequentially, and compared: identical results across both
// passes is the two-pass proof that nothing raced between classification and a hypothetical
// execute. Actually moving files only ever happens through executeQuarantine during apply.
export async function planCleanCompletion(input: { readonly repoRoot: string; readonly cwd: string; readonly config: GuardianConfig; readonly session: GuardianSession }): Promise<CleanCompletionPlan> {
  if (!isProvenanceEnabled(input.config)) return { applicable: false, finalProof: { status: "not-applicable", candidates: [] }, incompleteOperationCount: 0 };
  const worktreePath = typeof input.session.worktree_path === "string" ? input.session.worktree_path : input.cwd;
  const paths = await getGuardianPaths(input.repoRoot);
  const universe = await proveCleanCompletionUniverse({ repoRoot: input.repoRoot, config: input.config });
  if (universe.status !== "stable") return { applicable: true, finalProof: { status: "unstable", reason: universe.reason, candidates: [] }, incompleteOperationCount: universe.incompleteOperationCount };
  const proofEvidence = {
    inventoryDigest: universe.inventoryDigest,
    stateVersion: universe.stateVersion,
    worktreeCount: universe.worktreeCount,
    quarantineItemCount: universe.quarantineItemCount,
  };

  const inspection = await inspectDirtySessionDoneIntent({ cwd: worktreePath, worktreePath });
  const candidates = inspection.ignoredFiles;
  if (candidates.length === 0) return { applicable: true, finalProof: { status: "stable", candidates: [], ...proofEvidence }, incompleteOperationCount: 0 };

  const buildAllFacts = () => Promise.all(candidates.map((relativePath) => buildCandidateFacts({ repoRoot: input.repoRoot, worktreePath, config: input.config, session: input.session, paths, relativePath, commitPaths: inspection.commitPaths })));
  const firstPass = await buildAllFacts();
  const secondPass = await buildAllFacts();

  const results: CleanCompletionCandidateResult[] = [];
  let unstableReason: string | undefined;
  for (let index = 0; index < candidates.length; index += 1) {
    const relativePath = candidates[index];
    const factsA = firstPass[index];
    const factsB = secondPass[index];
    if (relativePath === undefined || !factsA || !factsB) continue;
    if (!unstableReason && JSON.stringify(factsA) !== JSON.stringify(factsB)) unstableReason = `candidate facts drifted between proof passes: ${relativePath}`;
    results.push(candidateResult(relativePath, classifyCleanCompletionDisposition(factsB)));
  }

  const finalProof: CleanCompletionFinalProof = unstableReason ? { status: "unstable", reason: unstableReason, candidates: results } : { status: "stable", candidates: results, ...proofEvidence };
  return { applicable: true, finalProof, incompleteOperationCount: 0 };
}
