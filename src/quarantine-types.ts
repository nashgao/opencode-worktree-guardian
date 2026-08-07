import { z } from "zod";

export const EXTERNAL_RECORD_VERSION = 1;
export const COMPLETION_STATUSES = ["complete", "partial", "blocked"] as const;
export const QUARANTINE_ITEM_STATES = ["available", "restored", "purged"] as const;
export const QUARANTINE_MOVE_OPERATION_PHASES = ["prepared", "renamed", "committed"] as const;
export const QUARANTINE_PURGE_OPERATION_PHASES = ["prepared", "tombstoned", "removed", "committed"] as const;

export type GuardianCompletionStatus = typeof COMPLETION_STATUSES[number];
export type QuarantineItemState = typeof QUARANTINE_ITEM_STATES[number];
export type QuarantineMoveOperationPhase = typeof QUARANTINE_MOVE_OPERATION_PHASES[number];
export type QuarantinePurgeOperationPhase = typeof QUARANTINE_PURGE_OPERATION_PHASES[number];

export type ExternalRecordReference = { readonly relativePath: string; readonly digest: string };
export type GuardianSessionProvenanceReferences = { readonly manifest?: ExternalRecordReference; readonly journals?: readonly ExternalRecordReference[] };
export type ProvenanceInventoryEntry = { readonly relativePath: string; readonly kind: "file" | "directory" | "symlink"; readonly fingerprint: string };
export type ProvenanceRecordV1 = {
  readonly version: 1;
  readonly kind: "provenance";
  readonly sessionId: string;
  readonly lineageId: string;
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly commonGitDir: string;
  readonly deviceId: number;
  readonly headCommit: string;
  readonly createdAt: string;
  readonly inventory: readonly ProvenanceInventoryEntry[];
};

export type QuarantineFingerprintEntry =
  | { readonly path: string; readonly kind: "directory" }
  | { readonly path: string; readonly kind: "file"; readonly size: number; readonly sha256: string }
  | { readonly path: string; readonly kind: "symlink"; readonly target: string };

type QuarantineItemCommon = {
  readonly version: 1;
  readonly kind: "quarantine-item";
  readonly quarantineId: string;
  readonly sessionId: string;
  readonly lineageId: string;
  readonly originalRelativePath: string;
  readonly originalWorktreePath: string;
  readonly artifactPath: string;
  readonly fingerprint: readonly QuarantineFingerprintEntry[];
  readonly fingerprintDigest: string;
  readonly manifestDigest: string;
  readonly doneIntentDigest: string;
  readonly guardianStateRevision: number;
  readonly sessionRevision: number;
  readonly deviceId: number;
  readonly nonce: string;
  readonly createdAt: string;
};

export type QuarantineItemRecordV1 =
  | (QuarantineItemCommon & { readonly state: "available"; readonly predecessorDigest?: string })
  | (QuarantineItemCommon & { readonly state: "restored" | "purged"; readonly predecessorDigest: string });

type QuarantineOperationCommon = Omit<QuarantineItemCommon, "kind"> & {
  readonly kind: "quarantine-operation";
  readonly operationId: string;
  readonly action: "quarantine" | "restore" | "purge";
};

export type QuarantineOperationRecordV1 =
  | (QuarantineOperationCommon & { readonly action: "quarantine"; readonly phase: QuarantineMoveOperationPhase; readonly predecessorDigest?: string })
  | (QuarantineOperationCommon & { readonly action: "restore"; readonly phase: QuarantineMoveOperationPhase; readonly targetWorktreePath: string; readonly predecessorDigest?: string })
  | (QuarantineOperationCommon & { readonly action: "purge"; readonly phase: QuarantinePurgeOperationPhase; readonly tombstonePath: string; readonly predecessorDigest?: string });

export type QuarantineJournalRecordV1 = QuarantineItemRecordV1 | QuarantineOperationRecordV1;
export type QuarantineDisposition =
  | { readonly disposition: "commit"; readonly relativePath: string }
  | { readonly disposition: "delete-known"; readonly relativePath: string }
  | { readonly disposition: "quarantine"; readonly relativePath: string }
  | { readonly disposition: "block"; readonly relativePath: string; readonly reason: string };
export type GuardianQuarantineAction = "restore" | "purge";

const requiredText = z.string().min(1);
const safeRelativePath = requiredText.refine((value) => !value.includes("\0") && !value.startsWith("/") && value !== "." && value !== ".." && !value.startsWith("../"), "safe relative path required");
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const externalVersion = z.literal(EXTERNAL_RECORD_VERSION);
const fingerprintEntrySchema = z.union([
  z.object({ path: safeRelativePath, kind: z.literal("directory") }).strict(),
  z.object({ path: safeRelativePath, kind: z.literal("file"), size: z.number().int().nonnegative(), sha256: digest }).strict(),
  z.object({ path: safeRelativePath, kind: z.literal("symlink"), target: requiredText }).strict(),
]);
const provenanceRecordSchema = z.object({
  version: externalVersion, kind: z.literal("provenance"), sessionId: requiredText, lineageId: requiredText, repoRoot: requiredText, worktreePath: requiredText,
  commonGitDir: requiredText, deviceId: z.number().int().nonnegative(), headCommit: requiredText, createdAt: z.iso.datetime({ offset: true }),
  inventory: z.array(z.object({ relativePath: requiredText, kind: z.enum(["file", "directory", "symlink"]), fingerprint: requiredText })),
});
const journalFields = {
  version: externalVersion, quarantineId: requiredText, sessionId: requiredText, lineageId: requiredText, originalRelativePath: safeRelativePath,
  originalWorktreePath: requiredText, artifactPath: requiredText, fingerprint: z.array(fingerprintEntrySchema).min(1), fingerprintDigest: digest,
  manifestDigest: digest, doneIntentDigest: digest, guardianStateRevision: z.number().int().nonnegative(), sessionRevision: z.number().int().nonnegative(),
  deviceId: z.number().int().nonnegative(), nonce: z.uuid(), createdAt: z.iso.datetime({ offset: true }), predecessorDigest: digest.optional(),
};
const itemRecordSchema = z.union([
  z.object({ ...journalFields, kind: z.literal("quarantine-item"), state: z.literal("available") }).strict().refine((record) => record.predecessorDigest === undefined, "available item cannot have a predecessor"),
  z.object({ ...journalFields, kind: z.literal("quarantine-item"), state: z.enum(["restored", "purged"]), predecessorDigest: digest }).strict(),
]);
const quarantineOperationSchema = z.object({ ...journalFields, kind: z.literal("quarantine-operation"), operationId: requiredText, action: z.literal("quarantine"), phase: z.enum(QUARANTINE_MOVE_OPERATION_PHASES) }).strict();
const restoreOperationSchema = z.object({ ...journalFields, kind: z.literal("quarantine-operation"), operationId: requiredText, action: z.literal("restore"), phase: z.enum(QUARANTINE_MOVE_OPERATION_PHASES), targetWorktreePath: requiredText }).strict();
const purgeOperationSchema = z.object({ ...journalFields, kind: z.literal("quarantine-operation"), operationId: requiredText, action: z.literal("purge"), phase: z.enum(QUARANTINE_PURGE_OPERATION_PHASES), tombstonePath: requiredText }).strict();
const quarantineJournalRecordSchema = z.union([itemRecordSchema, quarantineOperationSchema, restoreOperationSchema, purgeOperationSchema]);

export function isGuardianCompletionStatus(value: string): value is GuardianCompletionStatus {
  return COMPLETION_STATUSES.includes(value as GuardianCompletionStatus);
}

export function parseProvenanceRecord(value: unknown): ProvenanceRecordV1 {
  return provenanceRecordSchema.parse(value);
}

export function parseQuarantineJournalRecord(value: unknown): QuarantineJournalRecordV1 {
  return quarantineJournalRecordSchema.parse(value);
}
