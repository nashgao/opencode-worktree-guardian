import { z } from "zod";

export const PROTECTED_INVENTORY_MAX_ROOTS = 128;
export const PROTECTED_INVENTORY_MAX_ENTRIES_PER_ROOT = 10_000;
export const PROTECTED_INVENTORY_MAX_ENTRIES_TOTAL = 100_000;

export type ProtectedInventorySeed = {
  readonly path: string;
  readonly reason: string;
};

export type ProtectedInventoryEntry = ProtectedInventorySeed & {
  readonly assessment: "not-assessed";
  readonly cleanupAuthorized: false;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly bytes: number;
  readonly bytesTruncated: boolean;
};

export type ProtectedInventorySummary = {
  readonly rootCount: number;
  readonly rootsTruncated: boolean;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly totalBytes: number;
  readonly bytesTruncated: boolean;
  readonly assessment: "not-assessed";
  readonly cleanupAuthorized: false;
};

export type ProtectedInventoryResult = {
  readonly entries: readonly ProtectedInventoryEntry[];
  readonly summary: ProtectedInventorySummary;
};

export type ProtectedInventoryRequest = {
  readonly repoRoot: string;
  readonly seeds: readonly ProtectedInventorySeed[];
  readonly rootsTruncated: boolean;
};

export type ProtectedInventoryWorkerInput = ProtectedInventoryRequest & {
  readonly repoDevice: string;
  readonly repoInode: string;
};

const nonNegativeInteger = z.number().int().nonnegative().finite();
const seedSchema = z.object({ path: z.string(), reason: z.string() }).strict();
const entrySchema = seedSchema.extend({
  assessment: z.literal("not-assessed"),
  cleanupAuthorized: z.literal(false),
  fileCount: nonNegativeInteger,
  directoryCount: nonNegativeInteger,
  bytes: nonNegativeInteger,
  bytesTruncated: z.boolean(),
}).strict();

export const protectedInventoryWorkerInputSchema = z.object({
  repoRoot: z.string(),
  seeds: z.array(seedSchema).max(PROTECTED_INVENTORY_MAX_ROOTS),
  rootsTruncated: z.boolean(),
  repoDevice: z.string().regex(/^\d+$/),
  repoInode: z.string().regex(/^\d+$/),
}).strict();

export const protectedInventoryResultSchema = z.object({
  entries: z.array(entrySchema).max(PROTECTED_INVENTORY_MAX_ROOTS),
  summary: z.object({
    rootCount: nonNegativeInteger,
    rootsTruncated: z.boolean(),
    fileCount: nonNegativeInteger,
    directoryCount: nonNegativeInteger,
    totalBytes: nonNegativeInteger,
    bytesTruncated: z.boolean(),
    assessment: z.literal("not-assessed"),
    cleanupAuthorized: z.literal(false),
  }).strict(),
}).strict();
