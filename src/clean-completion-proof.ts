import { proveCleanCompletionUniverse } from "./clean-completion-universe.ts";
import { getGuardianPaths } from "./guardian-paths.ts";
import { isProvenanceEnabled } from "./session-provenance.ts";
import { updateState } from "./state.ts";
import type { CleanCompletionProofEvidence, CleanCompletionProofRecordV1, GuardianConfig, GuardianPaths } from "./types.ts";
import { isRecordLike } from "./types.ts";

const SHA256 = /^[0-9a-f]{64}$/;

function isProofRecord(value: unknown): value is CleanCompletionProofRecordV1 {
  if (!isRecordLike(value)) return false;
  return value.version === 1
    && value.kind === "clean-completion-proof"
    && value.status === "complete"
    && typeof value.stateVersion === "number"
    && Number.isSafeInteger(value.stateVersion)
    && value.stateVersion >= 0
    && typeof value.provenAt === "string"
    && !Number.isNaN(Date.parse(value.provenAt))
    && typeof value.inventoryDigest === "string"
    && SHA256.test(value.inventoryDigest)
    && typeof value.worktreeCount === "number"
    && Number.isSafeInteger(value.worktreeCount)
    && value.worktreeCount >= 1
    && typeof value.quarantineItemCount === "number"
    && Number.isSafeInteger(value.quarantineItemCount)
    && value.quarantineItemCount >= 0
    && value.incompleteOperationCount === 0;
}

export function inspectCleanCompletionProof(value: unknown, stateVersion: number | undefined): CleanCompletionProofEvidence | undefined {
  if (value === undefined) return undefined;
  if (!isProofRecord(value)) return { status: "invalid", reason: "clean-completion proof record is invalid or has an unsupported version" };
  const evidence = {
    version: value.version,
    stateVersion: value.stateVersion,
    provenAt: value.provenAt,
    inventoryDigest: value.inventoryDigest,
    worktreeCount: value.worktreeCount,
    quarantineItemCount: value.quarantineItemCount,
    incompleteOperationCount: value.incompleteOperationCount,
  };
  if (value.stateVersion !== stateVersion) return { status: "stale", reason: "Guardian state changed after the clean-completion proof", ...evidence };
  return { status: "proven", ...evidence };
}

export async function revalidateCleanCompletionProof(input: {
  readonly repoRoot: string;
  readonly config: GuardianConfig;
  readonly value: unknown;
  readonly stateVersion: number | undefined;
}): Promise<CleanCompletionProofEvidence | undefined> {
  const evidence = inspectCleanCompletionProof(input.value, input.stateVersion);
  if (evidence?.status !== "proven") return evidence;
  if (!isProvenanceEnabled(input.config)) return { ...evidence, status: "stale", reason: "clean-completion policy is disabled" };
  const proof = await proveCleanCompletionUniverse({ repoRoot: input.repoRoot, config: input.config, requireCleanWorktrees: true });
  if (proof.status !== "stable") return { ...evidence, status: "stale", reason: proof.reason ?? "clean-completion proof revalidation failed" };
  if (proof.stateVersion !== input.stateVersion) return { ...evidence, status: "stale", reason: "Guardian state changed during clean-completion proof revalidation" };
  return evidence;
}

export async function persistCleanCompletionProof(input: {
  readonly repoRoot: string;
  readonly config: GuardianConfig;
  readonly paths?: GuardianPaths;
  readonly expectedStateVersion: number;
  readonly inventoryDigest: string;
  readonly worktreeCount: number;
  readonly quarantineItemCount: number;
  readonly provenAt?: string;
}): Promise<CleanCompletionProofEvidence> {
  const paths = input.paths ?? await getGuardianPaths(input.repoRoot);
  const next = await updateState(input.repoRoot, input.config, (state) => {
    if (state.state_version !== input.expectedStateVersion) throw new Error("Guardian state changed after the clean-completion proof");
    state.clean_completion_proof = {
      version: 1,
      kind: "clean-completion-proof",
      status: "complete",
      stateVersion: input.expectedStateVersion + 1,
      provenAt: input.provenAt ?? new Date().toISOString(),
      inventoryDigest: input.inventoryDigest,
      worktreeCount: input.worktreeCount,
      quarantineItemCount: input.quarantineItemCount,
      incompleteOperationCount: 0,
    } satisfies CleanCompletionProofRecordV1;
    return state;
  }, { paths });
  const evidence = inspectCleanCompletionProof(next.clean_completion_proof, next.state_version);
  if (evidence?.status !== "proven") throw new Error(evidence?.reason ?? "clean-completion proof was not persisted");
  return evidence;
}

export async function proveAndPersistCleanCompletion(input: {
  readonly repoRoot: string;
  readonly config: GuardianConfig;
}): Promise<{ readonly ok: true; readonly evidence: CleanCompletionProofEvidence } | { readonly ok: false; readonly reason: string }> {
  const proof = await proveCleanCompletionUniverse({ repoRoot: input.repoRoot, config: input.config, requireCleanWorktrees: true });
  if (proof.status !== "stable") return { ok: false, reason: proof.reason ?? "clean-completion proof is unstable" };
  if (proof.inventoryDigest === undefined || proof.stateVersion === undefined || proof.worktreeCount === undefined || proof.quarantineItemCount === undefined) {
    return { ok: false, reason: "clean-completion proof evidence is incomplete" };
  }
  try {
    const evidence = await persistCleanCompletionProof({
      repoRoot: input.repoRoot,
      config: input.config,
      expectedStateVersion: proof.stateVersion,
      inventoryDigest: proof.inventoryDigest,
      worktreeCount: proof.worktreeCount,
      quarantineItemCount: proof.quarantineItemCount,
    });
    return { ok: true, evidence };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
