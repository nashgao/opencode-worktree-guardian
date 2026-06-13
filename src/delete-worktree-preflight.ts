import { collectIgnoredFileFingerprint } from "./deletion-fingerprint.ts";
import { isAncestor, listUnmergedCommits } from "./git.ts";
import { errorMessage } from "./delete-worktree-report.ts";

export { collectIgnoredFileFingerprint };

export async function recordAncestryPreflight(repoRoot: string, head: string, baseRef: string, preflight: Record<string, unknown>) {
  preflight.ancestryRef = baseRef;
  const proven = await isAncestor(repoRoot, head, baseRef);
  preflight.ancestryProven = proven;
  if (proven) {
    preflight.unmergedCommits = [];
    preflight.unmergedCommitCount = 0;
    return proven;
  }
  let unmergedCommits: { commit: string; subject: string | undefined }[] = [];
  try {
    unmergedCommits = await listUnmergedCommits(repoRoot, head, baseRef);
  } catch (error) {
    preflight.unmergedCommitError = errorMessage(error);
  }
  preflight.unmergedCommits = unmergedCommits;
  preflight.unmergedCommitCount = unmergedCommits.length;
  return proven;
}
