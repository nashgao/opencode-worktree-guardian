import type { GuardOptions } from "../types.ts";
import { hasDynamicShellArgument, hasUnsafeDiffOption, isReadOnlyStashInvocation } from "./allowlists.ts";
import type { CommandSegment, GuardBlockDecision } from "./guard-types.ts";
import { checkoutRestoresPaths, isRecursiveForce, restoreIsDestructive, targetsKnownWorktreePath, targetsRepoManagedPath, rmTargets } from "./destructive-inputs.ts";
import { effectiveGitPolicyReason } from "./effective-git-policy.ts";
import { hasAliasCapableEnvironmentAssignments, hasAliasCapableRuntimeConfig, isForcePushToken, parseGitInvocation, pushRefspecs } from "./git-invocation.ts";
import { block, stringArrayOption } from "./options.ts";
import { matchesKnownWorktreePath } from "./path-policy.ts";
import { protectedBranchBypass } from "./protected-branch-policy.ts";
import { hasUpdateRefStdin, isBranchRefDeleteTarget, isRecoveryRefTarget, reflogHasDynamicMutationTarget, reflogMutatesRecoveryRef, symbolicRefMutationTarget, updateRefDeleteTarget, updateRefTarget } from "./recovery-ref-policy.ts";
import { shellPayload, stripCommandWrappers } from "./shell-prefix.ts";

function hasForceCleanFlag(tokens: CommandSegment): boolean {
  return tokens.some((token) => token === "--force" || token === "-f" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(token));
}

function hasDryRunFlag(tokens: CommandSegment): boolean {
  return tokens.some((token) => token === "--dry-run" || token === "-n" || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(token));
}

function findWorktreeAddPath(rest: CommandSegment): string | null {
  let index = 1;
  while (index < rest.length) {
    const token = rest[index] ?? "";
    if (token === "--") return rest[index + 1] ?? null;
    if (!token.startsWith("-")) return token;
    if (["-b", "-B", "--orphan"].includes(token)) {
      index += 2;
      continue;
    }
    if (token === "--detach" || token.startsWith("--orphan=")) {
      index += 1;
      continue;
    }
    index += 1;
  }
  return null;
}

function hasBranchDeleteFlag(tokens: CommandSegment): boolean {
  return tokens.some((token) => {
    if (token === "--delete" || token.startsWith("--delete=")) return true;
    if (token.startsWith("--")) return false;
    return /^-[A-Za-z]*[dD][A-Za-z]*$/.test(token);
  });
}

function configMutatesAliasCapability(tokens: CommandSegment): boolean {
  const readOnly = ["get", "get-all", "get-regexp", "list"].includes(tokens[0] ?? "")
    || tokens.some((token) => ["--get", "--get-all", "--get-regexp", "--list"].includes(token));
  if (readOnly) return false;
  const aliasCapable = tokens.some((token) => {
    const key = token.toLowerCase();
    return key === "alias" || key.startsWith("alias.") || key === "include" || key === "include.path" || key.startsWith("includeif.");
  });
  return aliasCapable || hasDynamicShellArgument(tokens);
}

function configMutatesTransportCapability(tokens: CommandSegment): boolean {
  const readOnly = ["get", "get-all", "get-regexp", "list"].includes(tokens[0] ?? "")
    || tokens.some((token) => ["--get", "--get-all", "--get-regexp", "--list"].includes(token));
  if (readOnly) return false;
  return tokens.some((token) => /^remote\..+\.(fetch|push|mirror)$/i.test(token));
}

function classifyGit(segment: CommandSegment, options: GuardOptions = {}): GuardBlockDecision | null {
  const parsed = parseGitInvocation(segment, options);
  if (!parsed?.subcommand) return null;
  const { subcommand, rest, normalized, gitCwd, workTree, configs, unsafeExecutableSearchPath } = parsed;
  if (hasDynamicShellArgument([subcommand])) {
    return block("dynamic git subcommand is blocked because it can bypass Guardian command classification", normalized);
  }
  if (unsafeExecutableSearchPath) {
    return block("env alternate executable search path is blocked because it can replace git", normalized);
  }
  if (hasAliasCapableRuntimeConfig(configs)) {
    return block("runtime git alias-capable config is blocked because it can bypass Guardian command classification", normalized);
  }
  const bypass = protectedBranchBypass(normalized, subcommand, rest, options, gitCwd, workTree, configs);
  if (bypass) return bypass;
  const effectivePolicy = effectiveGitPolicyReason(parsed, options);
  if (effectivePolicy) return block(effectivePolicy, normalized);
  if (subcommand === "init") {
    return block("git init is blocked because it can create or replace repository metadata", normalized);
  }
  if (["diff", "log", "show"].includes(subcommand) && hasUnsafeDiffOption(rest)) {
    return block("Git diff/log/show write-capable options are blocked", normalized);
  }
  if (subcommand === "reset") {
    return block("raw git reset is blocked because it can discard or hide session work; use Guardian-native cleanup", normalized);
  }
  if (subcommand === "clean" && hasForceCleanFlag(rest) && !hasDryRunFlag(rest)) {
    return block("destructive git clean variants are blocked", normalized);
  }
  if (subcommand === "branch" && hasBranchDeleteFlag(rest)) {
    return block("raw git branch deletion is blocked; use guardian_delete_worktree", normalized);
  }
  if (subcommand === "config" && (configMutatesAliasCapability(rest) || configMutatesTransportCapability(rest))) {
    return block("runtime git alias-capable config or remote transport config mutation is blocked because it can bypass Guardian command classification", normalized);
  }
  if (subcommand === "update-ref") {
    if (hasUpdateRefStdin(rest)) {
      return block("raw git update-ref --stdin is blocked; use guardian_delete_worktree", normalized);
    }
    const deleteTarget = updateRefDeleteTarget(rest);
    if (isBranchRefDeleteTarget(deleteTarget)) {
      return block("raw git branch ref deletion is blocked; use guardian_delete_worktree", normalized);
    }
    const target = updateRefTarget(rest);
    if (target && hasDynamicShellArgument([target])) {
      return block("dynamic shell expansion in a recovery-ref-capable command is blocked", normalized);
    }
    if (isRecoveryRefTarget(target)) {
      return block("raw stash or Guardian recovery ref mutation is blocked", normalized);
    }
  }
  if (subcommand === "symbolic-ref") {
    const target = symbolicRefMutationTarget(rest);
    if (target && hasDynamicShellArgument([target])) {
      return block("dynamic shell expansion in a recovery-ref-capable command is blocked", normalized);
    }
    if (isRecoveryRefTarget(target)) return block("raw stash or Guardian recovery ref mutation is blocked", normalized);
  }
  if (subcommand === "reflog" && reflogHasDynamicMutationTarget(rest)) {
    return block("dynamic shell expansion in a recovery-ref-capable command is blocked", normalized);
  }
  if (subcommand === "reflog" && reflogMutatesRecoveryRef(rest)) {
    return block("raw stash or Guardian recovery reflog mutation is blocked", normalized);
  }
  if (subcommand === "worktree" && ["remove", "prune"].includes(rest[0] ?? "")) {
    return block("raw git worktree removal/prune is blocked; use guardian_delete_worktree", normalized);
  }
  if (subcommand === "worktree" && rest[0] === "add") {
    const addPath = findWorktreeAddPath(rest);
    const knownWorktreePaths = stringArrayOption(options, "knownWorktreePaths");
    if (!addPath || !matchesKnownWorktreePath(addPath, knownWorktreePaths, options.cwd ?? process.cwd())) {
      return block("raw git worktree add outside Guardian-owned roots is blocked; use guardian_start", normalized);
    }
  }
  if (subcommand === "restore" && restoreIsDestructive(rest)) {
    return block("destructive git restore variants are blocked", normalized);
  }
  if (subcommand === "checkout" && (rest.includes("-f") || rest.includes("--force") || checkoutRestoresPaths(rest))) {
    return block("destructive git checkout variants are blocked", normalized);
  }
  if (subcommand === "switch" && rest.some((token) => token === "-f" || token === "--force" || token === "--discard-changes")) {
    return block("destructive git switch variants are blocked", normalized);
  }
  if (subcommand === "stash") {
    if (!isReadOnlyStashInvocation(rest)) {
      return block("mutating git stash commands are blocked", normalized);
    }
  }
  if (subcommand === "push" && (rest.some(isForcePushToken) || pushRefspecs(rest).some((refspec) => refspec.startsWith("+")))) {
    return block("force push is blocked", normalized);
  }
  if (subcommand === "push" && rest.some((token) => token === "--mirror")) {
    return block("mirror push is blocked because it can delete remote refs", normalized);
  }
  return null;
}

export function classifySegment(
  segment: CommandSegment,
  options: GuardOptions,
  classifyNestedPayload: (payload: string, inheritedEnvAssignments: readonly string[], envCwd: string | null) => { readonly reason: string | null } | null,
): GuardBlockDecision | null {
  const payload = shellPayload(segment);
  if (payload) {
    if (payload.unsafeExecutableSearchPath) return block("env alternate executable search path is blocked because it can replace shell commands", segment);
    const inheritedEnvAssignments = [...(Array.isArray(options.inheritedEnvAssignments) ? options.inheritedEnvAssignments : []), ...payload.assignments];
    const nested = classifyNestedPayload(payload.payload, inheritedEnvAssignments, payload.envCwd);
    if (nested) return block(`shell -c payload is blocked: ${nested.reason}`, segment);
  }
  const stripped = stripCommandWrappers(segment);
  if (stripped[0] === "export" && hasAliasCapableEnvironmentAssignments(stripped.slice(1))) {
    return block("runtime git alias-capable config export is blocked because it can bypass Guardian command classification", stripped);
  }
  const gitResult = classifyGit(segment, options);
  if (gitResult) return gitResult;
  const gitIndex = segment.findIndex((token) => /(?:^|[\\/])git(?:\.exe)?$/i.test(token));
  if (gitIndex > 0) {
    const nestedGitResult = classifyGit(segment.slice(gitIndex), options);
    if (nestedGitResult) return nestedGitResult;
  }
  if (stripped[0] === "opencode-worktree-workflow" && stripped[1] === "wt-clean" && stripped[2] === "apply") {
    return block("opencode-worktree-workflow wt-clean apply is blocked", stripped);
  }
  if (stripped[0] === "rm" && isRecursiveForce(stripped.slice(1))) {
    const targets = rmTargets(stripped.slice(1));
    if (hasDynamicShellArgument(targets)) {
      return block("dynamic shell deletion targets are blocked", stripped);
    }
    if (targetsKnownWorktreePath(targets, options)) {
      return block("rm -rf of a known worktree path is blocked", stripped);
    }
    if (targetsRepoManagedPath(targets, options)) {
      return block("rm -rf inside the current repo/worktree is blocked; use guardian_delete_paths or guardian_hygiene", stripped);
    }
  }
  return null;
}
