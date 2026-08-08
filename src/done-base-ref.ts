import { getBranchUpstream, tryGitReadOnly, validateGitRef } from "./git.ts";
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

function resolveBaseRefFromUpstream(config: Record<string, unknown>, upstream: string | null): BaseRefResolution {
  const localBaseBranch = String(config.baseBranch);
  const configured = configuredRemoteAuthority(config);
  const configuredBaseRef = configured.displayRef;
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

export async function resolveBaseRef(repoRoot: string, config: Record<string, unknown>): Promise<BaseRefResolution> {
  configuredRemoteAuthority(config);
  return resolveBaseRefFromUpstream(config, await getBranchUpstream(repoRoot, String(config.baseBranch)));
}

export async function resolveBaseRefReadOnly(repoRoot: string, config: Record<string, unknown>): Promise<BaseRefResolution> {
  const localBaseBranch = String(config.baseBranch);
  configuredRemoteAuthority(config);
  validateGitRef(localBaseBranch);
  const upstreamResult = await tryGitReadOnly(
    { cwd: repoRoot, gitDir: null, workTree: null, configs: [] },
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${localBaseBranch}@{upstream}`],
  );
  const upstream = upstreamResult.ok && upstreamResult.stdout ? upstreamResult.stdout : null;
  return resolveBaseRefFromUpstream(config, upstream);
}

export function configForResolvedBase<T extends Record<string, unknown>>(config: T, resolved: BaseRefResolution): T {
  return { ...config, remote: resolved.remote, baseBranch: resolved.remoteBranch };
}
