import type { GuardOptions } from "../types.ts";
import type { GitInvocation, GitRevisionIdentity } from "./guard-types.ts";
import { stringArrayOption, stringOption } from "./options.ts";
import { pushTransportArguments } from "./transport-arguments.ts";
import { hasUnsafeFetchTransport, hasUnsafePushTransport } from "./transport-policy.ts";

function inspectedTransportConfigs(options: GuardOptions): readonly string[] | null {
  const inspection = options.inspection;
  if (inspection?.state === "failed") return null;
  return inspection?.state === "available" ? inspection.transportConfigs : [];
}

function configuredProtectedSource(configs: readonly string[], remote: string | null, options: GuardOptions): boolean {
  const protectedBranches = stringArrayOption(options, "protectedBranches");
  const guardianBranches = stringArrayOption(options, "guardianBranches");
  const branchPrefix = stringOption(options, "branchPrefix");
  return configs.some((config) => {
    const separator = config.indexOf("=");
    if (separator === -1) return false;
    const key = config.slice(0, separator);
    const normalizedKey = key.toLowerCase();
    if (!normalizedKey.startsWith("remote.") || !normalizedKey.endsWith(".push")) return false;
    const configuredRemote = key.slice("remote.".length, -".push".length);
    if (configuredRemote.length === 0 || (remote !== null && configuredRemote !== remote)) return false;
    const [source, destination] = config.slice(separator + 1).split(":", 2);
    const branch = destination?.replace(/^refs\/heads\//, "") ?? "";
    if (!protectedBranches.includes(branch)) return false;
    return isGuardianHeadSource(source ?? "", options) || guardianBranches.includes(source?.replace(/^refs\/heads\//, "") ?? "")
      || Boolean(branchPrefix && source?.replace(/^refs\/heads\//, "").startsWith(branchPrefix));
  });
}

export function effectiveGitPolicyReason(invocation: GitInvocation, options: GuardOptions): string | null {
  const inspection = options.inspection;
  if (inspection?.state === "failed") return `Git inspection failed: ${inspection.reason}`;
  if (!invocation.subcommand) return null;
  const normalizedSubcommand = invocation.subcommand.toLowerCase();
  if (inspection?.state === "available" && inspection.aliases.some((alias) => alias.toLowerCase() === normalizedSubcommand)) {
    return "the invoked effective Git alias is blocked";
  }
  const configs = inspectedTransportConfigs(options);
  if (invocation.subcommand === "push" && configs && configuredProtectedSource(configs, pushTransportArguments(invocation.rest).remote, options)) {
    return "configured Guardian source mapping to a protected branch is blocked";
  }
  if (invocation.subcommand === "push" && hasUnsafePushTransport(invocation.rest, invocation.configs, configs)) {
    return "Guardian recovery ref or unsafe effective push transport is blocked";
  }
  if (invocation.subcommand === "fetch" && hasUnsafeFetchTransport(invocation.rest, invocation.configs, configs)) {
    return "Guardian recovery ref or unsafe effective fetch transport is blocked";
  }
  return null;
}

export function isGuardianHeadSource(source: string, options: GuardOptions): boolean {
  if (/^(?:HEAD|@)(?:[~^]0+)?$/.test(source)) return true;
  const inspection = options.inspection;
  if (inspection?.state !== "available") return false;
  if (inspection.currentHead === source) return true;
  if (/^[0-9a-f]+$/i.test(source) && inspection.currentHead?.startsWith(source)) return true;
  return revisionIdentityEvidence(options).some((identity) => identity.source === source && identity.oid === inspection.currentHead);
}

function revisionIdentityEvidence(options: GuardOptions): readonly GitRevisionIdentity[] {
  const evidence = options.revisionIdentities;
  return Array.isArray(evidence)
    ? evidence.filter((value): value is GitRevisionIdentity => typeof value === "object" && value !== null && "source" in value && typeof value.source === "string" && "oid" in value && typeof value.oid === "string")
    : [];
}
