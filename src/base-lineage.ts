import { fetchRemote, getRefCommit, isAncestor, tryGitReadOnly } from "./git.ts";
import type { GitReadTarget, TryGitResult } from "./git.ts";

export type BaseLineageObservation = {
  readonly baseRefOid: string;
  readonly head: string;
  readonly baseIsAncestorOfHead: boolean;
  readonly headIsAncestorOfBase: boolean;
};

export async function observeBaseLineage(repoRoot: string, baseRefOid: string, head: string): Promise<BaseLineageObservation> {
  const [baseIsAncestorOfHead, headIsAncestorOfBase] = await Promise.all([
    isAncestor(repoRoot, baseRefOid, head),
    isAncestor(repoRoot, head, baseRefOid),
  ]);
  return { baseRefOid, head, baseIsAncestorOfHead, headIsAncestorOfBase };
}

function readOnlyAncestor(result: TryGitResult): boolean | null {
  if (result.ok) return true;
  if (result.error.gitExitCode === 1 && !result.error.gitSignal) return false;
  return null;
}

export async function observeBaseLineageReadOnly(input: { readonly target: GitReadTarget; readonly baseRefOid: string; readonly head: string }): Promise<BaseLineageObservation | null> {
  const [baseResult, headResult] = await Promise.all([
    tryGitReadOnly(input.target, ["merge-base", "--is-ancestor", input.baseRefOid, input.head]),
    tryGitReadOnly(input.target, ["merge-base", "--is-ancestor", input.head, input.baseRefOid]),
  ]);
  const baseIsAncestorOfHead = readOnlyAncestor(baseResult);
  const headIsAncestorOfBase = readOnlyAncestor(headResult);
  if (baseIsAncestorOfHead === null || headIsAncestorOfBase === null) return null;
  return { baseRefOid: input.baseRefOid, head: input.head, baseIsAncestorOfHead, headIsAncestorOfBase };
}

export async function observeFreshBaseLineage(input: { readonly repoRoot: string; readonly remote: string; readonly baseAuthorityRef: string; readonly head: string }): Promise<BaseLineageObservation> {
  await fetchRemote(input.repoRoot, input.remote);
  const baseRefOid = await getRefCommit(input.repoRoot, input.baseAuthorityRef);
  return observeBaseLineage(input.repoRoot, baseRefOid, input.head);
}
