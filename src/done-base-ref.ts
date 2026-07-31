import { getBranchUpstream } from "./git.ts";
import { configuredRemoteAuthority, resolveRemoteAuthority } from "./git-authority.ts";

export type BaseRefResolution = {
  readonly localBaseBranch: string;
  readonly remote: string;
  readonly remoteBranch: string;
  readonly baseRef: string;
  readonly authorityRef: string;
  readonly configuredBaseRef: string;
  readonly source: "upstream" | "config";
};

export async function resolveBaseRef(repoRoot: string, config: Record<string, unknown>): Promise<BaseRefResolution> {
  const localBaseBranch = String(config.baseBranch);
  const configured = configuredRemoteAuthority(config);
  const configuredBaseRef = configured.displayRef;
  const upstream = await getBranchUpstream(repoRoot, localBaseBranch);
  if (upstream) {
    const authority = resolveRemoteAuthority(upstream, config);
    return {
      localBaseBranch,
      remote: authority.remote,
      remoteBranch: authority.branch,
      baseRef: authority.displayRef,
      authorityRef: authority.authorityRef,
      configuredBaseRef,
      source: "upstream",
    };
  }
  return {
    localBaseBranch,
    remote: configured.remote,
    remoteBranch: configured.branch,
    baseRef: configuredBaseRef,
    authorityRef: configured.authorityRef,
    configuredBaseRef,
    source: "config",
  };
}

export function configForResolvedBase<T extends Record<string, unknown>>(config: T, resolved: BaseRefResolution): T {
  return { ...config, remote: resolved.remote, baseBranch: resolved.remoteBranch };
}
