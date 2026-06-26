import { getBranchUpstream } from "./git.ts";

export type BaseRefResolution = {
  readonly localBaseBranch: string;
  readonly remote: string;
  readonly remoteBranch: string;
  readonly baseRef: string;
  readonly configuredBaseRef: string;
  readonly source: "upstream" | "config";
};

function parseRemoteBranch(ref: string): { readonly remote: string; readonly branch: string } | null {
  const trimmed = ref.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) return null;
  return { remote: trimmed.slice(0, separator), branch: trimmed.slice(separator + 1) };
}

export async function resolveBaseRef(repoRoot: string, config: Record<string, unknown>): Promise<BaseRefResolution> {
  const localBaseBranch = String(config.baseBranch);
  const configuredRemote = String(config.remote);
  const configuredBaseRef = `${configuredRemote}/${localBaseBranch}`;
  const upstream = await getBranchUpstream(repoRoot, localBaseBranch);
  const parsed = upstream ? parseRemoteBranch(upstream) : null;
  if (parsed) {
    return {
      localBaseBranch,
      remote: parsed.remote,
      remoteBranch: parsed.branch,
      baseRef: `${parsed.remote}/${parsed.branch}`,
      configuredBaseRef,
      source: "upstream",
    };
  }
  return {
    localBaseBranch,
    remote: configuredRemote,
    remoteBranch: localBaseBranch,
    baseRef: configuredBaseRef,
    configuredBaseRef,
    source: "config",
  };
}

export function configForResolvedBase<T extends Record<string, unknown>>(config: T, resolved: BaseRefResolution): T {
  return { ...config, remote: resolved.remote, baseBranch: resolved.remoteBranch };
}
