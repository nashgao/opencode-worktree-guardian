import { collectIgnoredFileFingerprint } from "./deletion-fingerprint.ts";
import { isAncestor, listUnmergedCommits } from "./git.ts";
import { errorMessage } from "./delete-worktree-report.ts";

export { collectIgnoredFileFingerprint };

export async function recordAncestryPreflight(repoRoot: string, head: string, baseAuthorityRef: string, preflight: Record<string, unknown>) {
  if (typeof preflight.ancestryRef !== "string") preflight.ancestryRef = baseAuthorityRef;
  const proven = await isAncestor(repoRoot, head, baseAuthorityRef);
  preflight.ancestryProven = proven;
  if (proven) {
    preflight.unmergedCommits = [];
    preflight.unmergedCommitCount = 0;
    return proven;
  }
  let unmergedCommits: { commit: string; subject: string | undefined }[] = [];
  try {
    unmergedCommits = await listUnmergedCommits(repoRoot, head, baseAuthorityRef);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    preflight.unmergedCommitError = errorMessage(error);
  }
  preflight.unmergedCommits = unmergedCommits;
  preflight.unmergedCommitCount = unmergedCommits.length;
  return proven;
}
