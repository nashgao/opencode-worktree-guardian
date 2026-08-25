import crypto from "node:crypto";
import { isRecordLike } from "./types.ts";

type TokenJson = null | boolean | number | string | readonly TokenJson[] | { readonly [key: string]: TokenJson };

type GoalTokenStep = {
  readonly tool: string;
  readonly ok: boolean;
  readonly status: string;
  readonly reason?: string;
  readonly result?: unknown;
};

type GoalTokenPlan = {
  readonly repoRoot: string;
  readonly cwd: string;
  readonly goal: unknown;
  readonly steps: readonly GoalTokenStep[];
  readonly blockers: unknown;
  readonly complete: unknown;
  readonly hygienePostcondition: unknown;
  readonly cleanCompletion?: unknown;
};

const NO_IGNORED_TOKEN_KEYS = new Set<string>();
const HYGIENE_INFORMATIONAL_TOKEN_KEYS = new Set([
  "candidateCount",
  "exclusionCount",
  "protectedExclusionCount",
  "protectedInventory",
  "protectedInventoryCount",
  "protectedInventoryRootsTruncated",
  "protectedInventoryFileCount",
  "protectedInventoryDirectoryCount",
  "protectedInventoryTotalBytes",
  "protectedInventoryBytesTruncated",
]);

export function goalTokenValue(value: unknown, ignoredKeys: ReadonlySet<string> = NO_IGNORED_TOKEN_KEYS): TokenJson {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((entry) => goalTokenValue(entry, ignoredKeys));
  if (!isRecordLike(value)) return null;
  const output: Record<string, TokenJson> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "scannedAt" || ignoredKeys.has(key)) continue;
    output[key] = goalTokenValue(entry, ignoredKeys);
  }
  return output;
}

export function createGoalConfirmToken(plan: GoalTokenPlan): string {
  const material = {
    tool: "guardian_goal",
    repoRoot: plan.repoRoot,
    cwd: plan.cwd,
    goal: plan.goal,
    steps: plan.steps.map((step) => ({
      tool: step.tool,
      ok: step.ok,
      status: step.status,
      reason: step.reason ?? null,
      result: goalTokenValue(step.result, step.tool === "guardian_hygiene" ? HYGIENE_INFORMATIONAL_TOKEN_KEYS : NO_IGNORED_TOKEN_KEYS),
    })),
    blockers: plan.blockers,
    complete: plan.complete,
    hygienePostcondition: goalTokenValue(plan.hygienePostcondition, HYGIENE_INFORMATIONAL_TOKEN_KEYS),
    cleanCompletion: goalTokenValue(plan.cleanCompletion),
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}
