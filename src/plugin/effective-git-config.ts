import path from "node:path";
import { tryGitReadOnly } from "../git.ts";
import type { GitReadTarget } from "../git.ts";
import { parseGitInvocation } from "../guards/git-invocation.ts";
import type { CommandSegment, GitInvocation, GitRevisionIdentity } from "../guards/guard-types.ts";
import { commandSegmentsWithSeparators, tokenizeCommand } from "../guards/shell-parser.ts";
import { cdTarget, peelCommandPrefix, shellPayload } from "../guards/shell-prefix.ts";
import type { GuardContextInspection } from "../tool-types.ts";

export type GitInspectionTarget = GitReadTarget;

export type EffectiveGitInspection = {
  readonly inspection: GuardContextInspection;
  readonly revisionIdentities: readonly GitRevisionIdentity[];
};

export type DiscoveredGitInvocation = {
  readonly segment: CommandSegment;
  readonly cwd: string;
  readonly inheritedEnvAssignments: readonly string[];
  readonly invocation: GitInvocation;
};

function discoverInCommand(command: string, cwd: string, inheritedEnvAssignments: readonly string[]): DiscoveredGitInvocation[] {
  const discovered: DiscoveredGitInvocation[] = [];
  let effectiveCwd = cwd;
  for (const { segment, nextSeparator } of commandSegmentsWithSeparators(tokenizeCommand(command))) {
    const prefix = peelCommandPrefix(segment);
    const scopedCwd = prefix.envCwd ? path.resolve(effectiveCwd, prefix.envCwd) : effectiveCwd;
    const assignments = [...inheritedEnvAssignments, ...prefix.assignments];
    const invocation = parseGitInvocation(segment, { cwd: scopedCwd, inheritedEnvAssignments });
    if (invocation) discovered.push({ segment, cwd: scopedCwd, inheritedEnvAssignments, invocation });
    const payload = shellPayload(segment);
    if (payload) discovered.push(...discoverInCommand(payload.payload, scopedCwd, assignments));
    if (nextSeparator === ";" || nextSeparator === "&&") effectiveCwd = cdTarget(segment, scopedCwd) ?? effectiveCwd;
  }
  return discovered;
}

export function discoverGitInvocations(command: string | null | undefined, cwd: string): readonly DiscoveredGitInvocation[] {
  return command ? discoverInCommand(command, cwd, []) : [];
}

export function gitInspectionTargetForInvocation(discovered: DiscoveredGitInvocation): GitInspectionTarget {
  const { invocation, cwd } = discovered;
  const targetCwd = invocation.gitCwd ? path.resolve(cwd, invocation.gitCwd) : cwd;
  return {
    cwd: targetCwd,
    gitDir: invocation.gitDir ? path.resolve(targetCwd, invocation.gitDir) : null,
    workTree: invocation.workTree ? path.resolve(targetCwd, invocation.workTree) : null,
    configs: invocation.configs,
  };
}

export function gitInspectionTarget(command: string | null | undefined, cwd: string): GitInspectionTarget {
  const discovered = discoverGitInvocations(command, cwd)[0];
  return discovered ? gitInspectionTargetForInvocation(discovered) : { cwd, gitDir: null, workTree: null, configs: [] };
}

function configEntries(stdout: string): string[] {
  return stdout.split("\0").flatMap((entry) => {
    const separator = entry.indexOf("\n");
    if (separator <= 0) return [];
    return [`${entry.slice(0, separator)}=${entry.slice(separator + 1)}`];
  });
}

type ConfigEntries =
  | { readonly ok: true; readonly entries: readonly string[] }
  | { readonly ok: false; readonly reason: string };

async function configEntriesFor(target: GitInspectionTarget, pattern: string): Promise<ConfigEntries> {
  const result = await tryGitReadOnly(target, ["config", "--includes", "--null", "--get-regexp", pattern]);
  if (result.ok) return { ok: true, entries: configEntries(result.stdout) };
  if (result.error.gitExitCode === 1) return { ok: true, entries: [] };
  return { ok: false, reason: result.error.message };
}

function protectedSources(refspecs: readonly string[], protectedBranches: readonly string[]): string[] {
  return refspecs.flatMap((refspec) => {
    const normalized = refspec.startsWith("+") ? refspec.slice(1) : refspec;
    const separator = normalized.indexOf(":");
    if (separator < 0) return [];
    const source = normalized.slice(0, separator);
    const destination = normalized.slice(separator + 1).replace(/^refs\/heads\//, "");
    return source && protectedBranches.includes(destination) ? [source] : [];
  });
}

async function revisionIdentities(target: GitInspectionTarget, sources: readonly string[]): Promise<{ readonly ok: true; readonly values: readonly GitRevisionIdentity[] } | { readonly ok: false; readonly reason: string }> {
  const uniqueSources = [...new Set(sources)];
  const results = await Promise.all(uniqueSources.map(async (source) => ({ source, result: await tryGitReadOnly(target, ["rev-parse", "--verify", `${source}^{commit}`]) })));
  const failed = results.find(({ result }) => !result.ok);
  if (failed && !failed.result.ok) return { ok: false, reason: failed.result.error.message };
  return { ok: true, values: results.flatMap(({ source, result }) => result.ok ? [{ source, oid: result.stdout }] : []) };
}

export async function inspectEffectiveGitConfig(target: GitInspectionTarget, input: { readonly protectedBranches: readonly string[]; readonly explicitPushSources: readonly string[] }): Promise<EffectiveGitInspection> {
  const targetCheck = await tryGitReadOnly(target, ["rev-parse", "--show-toplevel"]);
  if (!targetCheck.ok) {
    return { inspection: { state: "failed", stage: "git-target", reason: targetCheck.error.message }, revisionIdentities: [] };
  }
  const [aliasEntries, transportConfigs, head] = await Promise.all([
    configEntriesFor(target, "^alias\\."),
    configEntriesFor(target, "^remote\\..*\\.(fetch|push|mirror)$"),
    tryGitReadOnly(target, ["rev-parse", "--verify", "HEAD^{commit}"]),
  ]);
  if (!aliasEntries.ok) {
    return { inspection: { state: "failed", stage: "git-config", reason: aliasEntries.reason }, revisionIdentities: [] };
  }
  if (!transportConfigs.ok) {
    return { inspection: { state: "failed", stage: "git-config", reason: transportConfigs.reason }, revisionIdentities: [] };
  }
  const configuredSources = transportConfigs.entries.flatMap((entry) => {
    const separator = entry.indexOf("=");
    const key = entry.slice(0, separator).toLowerCase();
    return separator >= 0 && key.startsWith("remote.") && key.endsWith(".push") ? protectedSources([entry.slice(separator + 1)], input.protectedBranches) : [];
  });
  const identities = await revisionIdentities(target, [...input.explicitPushSources, ...configuredSources]);
  if (!identities.ok) return { inspection: { state: "failed", stage: "git-config", reason: identities.reason }, revisionIdentities: [] };
  const aliases = aliasEntries.entries.map((entry) => entry.slice("alias.".length, entry.indexOf("="))).filter((entry) => entry.length > 0);
  return { inspection: { state: "available", aliases, transportConfigs: transportConfigs.entries, currentHead: head.ok ? head.stdout : null }, revisionIdentities: identities.values };
}
