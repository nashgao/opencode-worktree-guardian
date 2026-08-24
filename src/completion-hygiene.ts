import { scanWorkspaceHygiene } from "./hygiene.ts";
import type { HygieneScanResult } from "./hygiene-scan.ts";

type CompletionInput = Record<string, unknown>;
type CompletionResult = Record<string, unknown>;

export type PostCompletionHygiene = {
  readonly inventory: HygieneScanResult;
  readonly status: "satisfied" | "incomplete" | "scan-failed";
};

export type CompletionWithHygiene = CompletionResult & {
  readonly complete: boolean;
  readonly postCompletionHygiene: PostCompletionHygiene;
};

function repositoryRoot(input: CompletionInput): string | undefined {
  if (typeof input.repoRoot === "string") return input.repoRoot;
  return typeof input.cwd === "string" ? input.cwd : undefined;
}

export async function attachPostCompletionHygiene(result: CompletionResult, input: CompletionInput): Promise<CompletionWithHygiene> {
  const repoRoot = repositoryRoot(input);
  const inventory = await scanWorkspaceHygiene({
    ...input,
    ...(repoRoot ? { repoRoot, cwd: repoRoot } : {}),
    includeAllReviewableCandidates: true,
  });
  const scanComplete = inventory.ok === true && inventory.summary.filesystemOnlyEmptyDirectoryScanComplete;
  const status: PostCompletionHygiene["status"] = inventory.ok === false ? "scan-failed" : scanComplete ? "satisfied" : "incomplete";
  const postCompletionHygiene = { status, inventory };
  if (status === "satisfied") return { ...result, complete: true, postCompletionHygiene };
  return {
    ...result,
    status: "partial",
    complete: false,
    postCompletionHygiene,
    reason: status === "scan-failed" ? "post-completion hygiene scan failed" : "post-completion hygiene scan coverage is incomplete",
  };
}
