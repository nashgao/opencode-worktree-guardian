import { observeFreshBaseLineage } from "./base-lineage.ts";
import type { BaseLineageObservation } from "./base-lineage.ts";
import type { FinishPreflight } from "./finish-report.ts";
import { configuredRemoteAuthority } from "./git-authority.ts";
import type { GuardianConfig } from "./types.ts";

export async function observeFreshFinishBaseLineage(repoRoot: string, config: GuardianConfig, head: string): Promise<BaseLineageObservation & { readonly baseAuthorityRef: string }> {
  const baseAuthorityRef = configuredRemoteAuthority(config).authorityRef;
  const observation = await observeFreshBaseLineage({ repoRoot, remote: config.remote, baseAuthorityRef, head });
  return { ...observation, baseAuthorityRef };
}

export function recordFinishBaseLineage(preflight: FinishPreflight, baseLineage: BaseLineageObservation & { readonly baseAuthorityRef: string }): void {
  preflight.baseAuthorityRef = baseLineage.baseAuthorityRef;
  preflight.baseRefOid = baseLineage.baseRefOid;
  preflight.baseIsAncestorOfHead = baseLineage.baseIsAncestorOfHead;
  preflight.headIsAncestorOfBase = baseLineage.headIsAncestorOfBase;
}
