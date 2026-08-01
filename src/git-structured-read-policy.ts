const aliasConfigPrefix = "alias.";
const remoteConfigPrefix = "remote.";
const remoteConfigSuffixes = [".fetch", ".push", ".mirror"] as const;
const commitRevisionSuffix = "^{commit}";

function isAllowedStructuredConfig(config: string): boolean {
  const separator = config.indexOf("=");
  if (separator <= 0 || config.includes("\0")) return false;
  const key = config.slice(0, separator).toLowerCase();
  if (key.startsWith(aliasConfigPrefix)) return key.length > aliasConfigPrefix.length;
  if (!key.startsWith(remoteConfigPrefix)) return false;
  return remoteConfigSuffixes.some((suffix) => key.endsWith(suffix) && key.length > remoteConfigPrefix.length + suffix.length);
}

export function areStructuredConfigsReadOnly(configs: readonly string[]): boolean {
  return configs.every(isAllowedStructuredConfig);
}

export function isStructuredReadOnlyCommand(args: readonly string[]): boolean {
  if (args[0] === "rev-parse") {
    if (args.length === 2) return args[1] === "--show-toplevel";
    if (args.length !== 3) return false;
    if (args[1] === "--path-format=absolute") return args[2] === "--git-common-dir";
    const revision = args[2];
    return args[1] === "--verify"
      && revision !== undefined
      && !revision.startsWith("-")
      && revision.length > commitRevisionSuffix.length
      && revision.endsWith(commitRevisionSuffix);
  }
  if (args[0] === "config") {
    return args.length === 5
      && args[1] === "--includes"
      && args[2] === "--null"
      && args[3] === "--get-regexp"
      && (args[4] === "^alias\\." || args[4] === "^remote\\..*\\.(fetch|push|mirror)$");
  }
  return args.length === 4
    && args[0] === "symbolic-ref"
    && args[1] === "--quiet"
    && args[2] === "--short"
    && args[3] === "HEAD";
}
