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

function isSafeGitName(value: string): boolean {
  return value.length > 0 && !value.startsWith("-") && !value.includes("\0") && !value.includes("\n") && !value.includes("\r");
}

function isSafeRemoteBranch(value: string): boolean {
  return isSafeGitName(value) && !value.startsWith("/") && !value.endsWith("/") && !value.includes("//") && !value.includes("..") && !value.includes("@{") && !/[\s~^:?*[\]\\]/.test(value);
}

function trustedUpstreamRemotes(config: Record<string, unknown>, configuredRemote: string): readonly string[] {
  const extra = Array.isArray(config.trustedUpstreamRemotes) ? config.trustedUpstreamRemotes.filter((value): value is string => typeof value === "string") : [];
  return [configuredRemote, ...extra];
}

function validateRemoteBranch(parsed: { readonly remote: string; readonly branch: string }, config: Record<string, unknown>, configuredRemote: string): void {
  if (!isSafeGitName(parsed.remote)) throw new Error(`Unsafe upstream remote name: ${parsed.remote}`);
  if (!isSafeRemoteBranch(parsed.branch)) throw new Error(`Unsafe upstream branch name: ${parsed.branch}`);
  if (!trustedUpstreamRemotes(config, configuredRemote).includes(parsed.remote)) {
    throw new Error(`Untrusted upstream remote ${parsed.remote}; add it to trustedUpstreamRemotes to use it as a Guardian base`);
  }
}

export async function resolveBaseRef(repoRoot: string, config: Record<string, unknown>): Promise<BaseRefResolution> {
  const localBaseBranch = String(config.baseBranch);
  const configuredRemote = String(config.remote);
  const configuredBaseRef = `${configuredRemote}/${localBaseBranch}`;
  const upstream = await getBranchUpstream(repoRoot, localBaseBranch);
  const parsed = upstream ? parseRemoteBranch(upstream) : null;
  if (parsed) {
    validateRemoteBranch(parsed, config, configuredRemote);
    return {
      localBaseBranch,
      remote: parsed.remote,
      remoteBranch: parsed.branch,
      baseRef: `${parsed.remote}/${parsed.branch}`,
      configuredBaseRef,
      source: "upstream",
    };
  }
  validateRemoteBranch({ remote: configuredRemote, branch: localBaseBranch }, { ...config, trustedUpstreamRemotes: [] }, configuredRemote);
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
