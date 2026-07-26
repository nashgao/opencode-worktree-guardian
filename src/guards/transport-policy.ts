import type { CommandSegment } from "./guard-types.ts";
import { fetchDestinationRefs, fetchUsesStdin, hasDynamicShellArgument, pushDestinationRefs } from "./git-invocation.ts";
import { isRecoveryRefTarget } from "./recovery-ref-policy.ts";
import { fetchTransportArguments, pushTransportArguments, refspecDestinations } from "./transport-arguments.ts";

type RemoteTransportConfig = {
  readonly remote: string;
  readonly kind: "fetch" | "push" | "mirror";
  readonly value: string;
};

function remoteTransportConfig(config: string): RemoteTransportConfig | null {
  const separator = config.indexOf("=");
  const key = separator === -1 ? config : config.slice(0, separator);
  if (!key.toLowerCase().startsWith("remote.")) return null;
  const remainder = key.slice("remote.".length);
  const suffixSeparator = remainder.lastIndexOf(".");
  if (suffixSeparator <= 0) return null;
  const kind = remainder.slice(suffixSeparator + 1).toLowerCase();
  if (kind !== "fetch" && kind !== "push" && kind !== "mirror") return null;
  if (separator === -1 && kind !== "mirror") return null;
  return { remote: remainder.slice(0, suffixSeparator), kind, value: separator === -1 ? "true" : config.slice(separator + 1) };
}

function hasUnsafeDestination(destinations: readonly string[]): boolean {
  return destinations.some((destination) => hasDynamicShellArgument([destination]) || isRecoveryRefTarget(destination));
}

function hasUnsafeConfiguredTransport(rest: CommandSegment, configs: readonly string[], subcommand: "fetch" | "push"): boolean {
  const remote = subcommand === "push" ? pushTransportArguments(rest).remote : fetchTransportArguments(rest).remote;
  const remoteConfigs = configs
    .map(remoteTransportConfig)
    .filter((config): config is RemoteTransportConfig => config !== null);
  return remoteConfigs.some((config) => {
    if ((remote && config.remote !== remote) || (config.kind !== subcommand && config.kind !== "mirror")) return false;
    if (subcommand === "push" && config.kind === "mirror") return ["true", "yes", "on", "1"].includes(config.value.toLowerCase());
    if (config.kind === "mirror") return false;
    if (/[$`[{?]/.test(config.value)) return true;
    if (subcommand === "push" && (config.value.startsWith("+") || config.value.startsWith(":"))) return true;
    return refspecDestinations([config.value], subcommand === "push").some(isRecoveryRefTarget);
  });
}

export function hasUnsafePushTransport(rest: CommandSegment, configs: readonly string[], effectiveConfigs: readonly string[] | null | undefined = undefined): boolean {
  if (effectiveConfigs === null) return true;
  const allConfigs = [...configs, ...(effectiveConfigs ?? [])];
  return hasUnsafeDestination(pushDestinationRefs(rest)) || hasUnsafeConfiguredTransport(rest, allConfigs, "push");
}

export function hasUnsafeFetchTransport(rest: CommandSegment, configs: readonly string[], effectiveConfigs: readonly string[] | null | undefined = undefined): boolean {
  if (effectiveConfigs === null) return true;
  const allConfigs = [...configs, ...(effectiveConfigs ?? [])];
  return fetchUsesStdin(rest) || hasUnsafeDestination(fetchDestinationRefs(rest)) || hasUnsafeConfiguredTransport(rest, allConfigs, "fetch");
}
