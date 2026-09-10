import { getCurrentBranch, isAncestor, runGitNullSeparated, tryGit } from "./git.ts";
import type { LooseRecord } from "./finish-report.ts";

export type BaseRealignment = { readonly baseHead: string; readonly required: boolean; readonly blocker: string | null };

export async function inspectBaseRealignment(repoRoot: string, baseBranch: string, commit: string, input: LooseRecord): Promise<BaseRealignment> {
  const resolved = await tryGit(repoRoot, ["rev-parse", "--verify", `refs/heads/${baseBranch}^{commit}`]);
  if (!resolved.ok) return { baseHead: "", required: false, blocker: "merge-to-base requires the configured base branch to exist locally; refusing to auto-create a tracking branch" };
  const baseHead = resolved.stdout;
  const required = !await isAncestor(repoRoot, baseHead, commit);
  let blocker: string | null = null;
  if (required) {
    if (input.allowBaseBranchRealign !== true) blocker = "divergent local base requires explicit allowBaseBranchRealign=true and expectedBaseHead";
    else if (input.expectedBaseHead !== baseHead) blocker = "base realignment expectedBaseHead does not match the current local base head";
    else if (await getCurrentBranch(repoRoot) !== baseBranch) blocker = "base realignment requires the primary worktree to already be on the configured base branch";
  }
  return { baseHead, required, blocker };
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export async function primaryWriteCollision(repoRoot: string, from: string, targets: readonly string[], registeredPaths: readonly string[]): Promise<string | null> {
  const changes = new Set<string>();
  for (const target of targets) {
    for (const file of await runGitNullSeparated(repoRoot, ["diff", "--name-only", "--no-renames", "-z", from, target, "--"])) changes.add(file);
  }
  const nestedCollision = registeredPaths.find((root) => [...changes].some((file) => overlaps(root, file)));
  if (nestedCollision) return `primary branch transition intersects registered worktree: ${nestedCollision}`;
  const ignoredFiles = await runGitNullSeparated(repoRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]);
  const ignoredCollision = ignoredFiles.find((file) => [...changes].some((changed) => overlaps(file, changed)));
  return ignoredCollision ? `primary branch transition would overwrite ignored untracked path: ${ignoredCollision}` : null;
}
