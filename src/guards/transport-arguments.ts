import type { CommandSegment } from "./guard-types.ts";

type TransportArgumentPolicy = {
  readonly optionsWithValue: ReadonlySet<string>;
  readonly optionalValueOptions: ReadonlySet<string>;
  readonly supportsRepoOption: boolean;
  readonly capturedOptions: ReadonlySet<string>;
};

export type TransportArguments = {
  readonly refspecs: string[];
  readonly capturedValues: string[];
  readonly remote: string | null;
};

const GIT_PUSH_OPTIONS_WITH_VALUE = new Set(["--repo", "--receive-pack", "--exec", "--push-option", "-o"]);
const GIT_FETCH_OPTIONS_WITH_VALUE = new Set(["--depth", "--deepen", "--shallow-since", "--shallow-exclude", "--upload-pack", "--exec", "--server-option", "--refmap", "--filter", "--negotiation-tip", "--jobs", "-j", "-o"]);
const RECURSE_SUBMODULES_OPTION = new Set(["--recurse-submodules"]);

const GIT_PUSH_ARGUMENT_POLICY: TransportArgumentPolicy = { optionsWithValue: GIT_PUSH_OPTIONS_WITH_VALUE, optionalValueOptions: RECURSE_SUBMODULES_OPTION, supportsRepoOption: true, capturedOptions: new Set() };
const GIT_FETCH_ARGUMENT_POLICY: TransportArgumentPolicy = { optionsWithValue: GIT_FETCH_OPTIONS_WITH_VALUE, optionalValueOptions: RECURSE_SUBMODULES_OPTION, supportsRepoOption: false, capturedOptions: new Set(["--refmap"]) };

function transportArguments(rest: CommandSegment, policy: TransportArgumentPolicy): TransportArguments {
  let remoteSeen = false;
  let remote: string | null = null;
  const refspecs: string[] = [];
  const capturedValues: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? "";
    if (token === "--") {
      refspecs.push(...rest.slice(index + 1).filter(Boolean));
      break;
    }
    if (policy.supportsRepoOption && token === "--repo") {
      remoteSeen = true;
      remote = rest[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (policy.supportsRepoOption && token.startsWith("--repo=")) {
      remoteSeen = true;
      remote = token.slice("--repo=".length) || null;
      continue;
    }
    if (policy.optionsWithValue.has(token)) {
      const value = rest[index + 1] ?? "";
      if (value && policy.capturedOptions.has(token)) capturedValues.push(value);
      index += 1;
      continue;
    }
    const inlineOption = [...policy.optionsWithValue].find((option) => token.startsWith(`${option}=`));
    if (inlineOption) {
      const value = token.slice(inlineOption.length + 1);
      if (value && policy.capturedOptions.has(inlineOption)) capturedValues.push(value);
      continue;
    }
    if (policy.optionalValueOptions.has(token) || [...policy.optionalValueOptions].some((option) => token.startsWith(`${option}=`))) continue;
    if (token.startsWith("-")) continue;
    if (!remoteSeen) {
      remoteSeen = true;
      remote = token;
      continue;
    }
    refspecs.push(token);
  }
  return { refspecs, capturedValues, remote };
}

export function pushRefspecs(rest: CommandSegment): string[] {
  return pushTransportArguments(rest).refspecs;
}

export function pushTransportArguments(rest: CommandSegment): TransportArguments {
  return transportArguments(rest, GIT_PUSH_ARGUMENT_POLICY);
}

export function fetchTransportArguments(rest: CommandSegment): TransportArguments {
  return transportArguments(rest, GIT_FETCH_ARGUMENT_POLICY);
}

export function refspecDestinations(refspecs: readonly string[], sourceOnlyUsesSameName: boolean): string[] {
  return refspecs.flatMap((rawRefspec) => {
    const refspec = rawRefspec.startsWith("+") ? rawRefspec.slice(1) : rawRefspec;
    const separator = refspec.indexOf(":");
    if (separator === -1) return sourceOnlyUsesSameName ? [refspec] : [];
    const destination = refspec.slice(separator + 1);
    return destination ? [destination] : [];
  });
}
