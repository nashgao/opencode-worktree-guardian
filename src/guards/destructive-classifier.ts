import type { GuardOptions } from "../types.ts";
import { STASH_READ_ONLY } from "./allowlists.ts";
import type { CommandSegment, GuardBlockDecision } from "./guard-types.ts";
import { isForcePushToken, parseGitInvocation, pushRefspecs } from "./git-invocation.ts";
import { block, stringArrayOption, stringOption } from "./options.ts";
import { isSameOrInside, matchesKnownWorktreePath, normalizeForCompare } from "./path-policy.ts";
import { protectedBranchBypass } from "./protected-branch-policy.ts";
import { shellPayload, stripCommandWrappers } from "./shell-prefix.ts";

function hasForceCleanFlag(tokens: CommandSegment): boolean {
  return tokens.some((token) => token === "--force" || token === "-f" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(token));
}

function hasDryRunFlag(tokens: CommandSegment): boolean {
  return tokens.some((token) => token === "--dry-run" || token === "-n" || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(token));
}

function isCheckoutPathRestore(rest: CommandSegment): boolean {
  return rest.includes("--") && rest.indexOf("--") < rest.length - 1;
}

function isRestoreDestructive(rest: CommandSegment): boolean {
  if (rest.includes("--staged") && !rest.includes("--worktree") && rest.every((token) => token === "--staged" || token.startsWith("-"))) {
    return false;
  }
  return rest.includes("--worktree") || rest.some((token) => !token.startsWith("-"));
}

function isRecursiveForce(tokens: CommandSegment): boolean {
  const flags = tokens.filter((token) => token.startsWith("-"));
  return flags.some((flag) => flag.includes("r") || flag.includes("R")) && flags.some((flag) => flag.includes("f") || flag.includes("F"));
}

function targetsRepoManagedPath(targets: readonly string[], options: GuardOptions): boolean {
  const cwd = options.cwd ?? process.cwd();
  const explicitProtectedRoots = [stringOption(options, "repoRoot"), stringOption(options, "worktree")]
    .filter((root): root is string => Boolean(root))
    .map((root) => normalizeForCompare(root, cwd));
  const protectedRoots = explicitProtectedRoots.length > 0 ? explicitProtectedRoots : [normalizeForCompare(cwd, cwd)];

  return targets.some((target) => {
    if (!target || target.startsWith("-")) return false;
    const resolvedTarget = normalizeForCompare(target, cwd);
    return protectedRoots.some((root) => isSameOrInside(resolvedTarget, root));
  });
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

function updateRefDeleteTarget(tokens: CommandSegment): string | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "-d" || token === "--delete") {
      for (let targetIndex = index + 1; targetIndex < tokens.length; targetIndex += 1) {
        const candidate = tokens[targetIndex] ?? "";
        if (candidate === "--") return tokens[targetIndex + 1] ?? null;
        if (!candidate.startsWith("-")) return candidate;
      }
      return null;
    }
    if (token.startsWith("--delete=")) return token.slice("--delete=".length);
  }
  return null;
}

function hasUpdateRefStdin(tokens: CommandSegment): boolean {
  return tokens.includes("--stdin");
}

function isBranchRefDeleteTarget(target: string | null): boolean {
  return target === "HEAD" || target === "@" || Boolean(target?.startsWith("refs/heads/"));
}

function classifyGit(segment: CommandSegment, options: GuardOptions = {}): GuardBlockDecision | null {
  const parsed = parseGitInvocation(segment, options);
  if (!parsed?.subcommand) return null;
  const { subcommand, rest, normalized, gitCwd, workTree, configs } = parsed;
  const bypass = protectedBranchBypass(normalized, subcommand, rest, options, gitCwd, workTree, configs);
  if (bypass) return bypass;
  if (subcommand === "reset") {
    return block("raw git reset is blocked because it can discard or hide session work; use Guardian-native cleanup", normalized);
  }
  if (subcommand === "clean" && hasForceCleanFlag(rest) && !hasDryRunFlag(rest)) {
    return block("destructive git clean variants are blocked", normalized);
  }
  if (subcommand === "branch" && hasBranchDeleteFlag(rest)) {
    return block("raw git branch deletion is blocked; use guardian_delete_worktree", normalized);
  }
  if (subcommand === "update-ref") {
    if (hasUpdateRefStdin(rest)) {
      return block("raw git update-ref --stdin is blocked; use guardian_delete_worktree", normalized);
    }
    const deleteTarget = updateRefDeleteTarget(rest);
    if (isBranchRefDeleteTarget(deleteTarget)) {
      return block("raw git branch ref deletion is blocked; use guardian_delete_worktree", normalized);
    }
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
  if (subcommand === "restore" && isRestoreDestructive(rest)) {
    return block("destructive git restore variants are blocked", normalized);
  }
  if (subcommand === "checkout" && (rest.includes("-f") || rest.includes("--force") || isCheckoutPathRestore(rest))) {
    return block("destructive git checkout variants are blocked", normalized);
  }
  if (subcommand === "switch" && rest.some((token) => token === "-f" || token === "--force" || token === "--discard-changes")) {
    return block("destructive git switch variants are blocked", normalized);
  }
  if (subcommand === "stash") {
    const action = rest.find((token) => !token.startsWith("-")) ?? "push";
    if (!STASH_READ_ONLY.has(action)) {
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
  classifyNestedPayload: (payload: string, inheritedEnvAssignments: readonly string[]) => { readonly reason: string | null } | null,
): GuardBlockDecision | null {
  const payload = shellPayload(segment);
  if (payload) {
    const inheritedEnvAssignments = [...(Array.isArray(options.inheritedEnvAssignments) ? options.inheritedEnvAssignments : []), ...payload.assignments];
    const nested = classifyNestedPayload(payload.payload, inheritedEnvAssignments);
    if (nested) return block(`shell -c payload is blocked: ${nested.reason}`, segment);
  }
  const gitResult = classifyGit(segment, options);
  if (gitResult) return gitResult;
  const gitIndex = segment.findIndex((token) => token === "git");
  if (gitIndex > 0) {
    const nestedGitResult = classifyGit(segment.slice(gitIndex), options);
    if (nestedGitResult) return nestedGitResult;
  }
  const stripped = stripCommandWrappers(segment);
  if (stripped[0] === "opencode-worktree-workflow" && stripped[1] === "wt-clean" && stripped[2] === "apply") {
    return block("opencode-worktree-workflow wt-clean apply is blocked", stripped);
  }
  if (stripped[0] === "rm" && isRecursiveForce(stripped.slice(1))) {
    const targets = stripped.slice(1).filter((token) => !token.startsWith("-"));
    if (targets.some((target) => matchesKnownWorktreePath(target, options.knownWorktreePaths ?? [], options.cwd ?? process.cwd()))) {
      return block("rm -rf of a known worktree path is blocked", stripped);
    }
    if (targetsRepoManagedPath(targets, options)) {
      return block("rm -rf inside the current repo/worktree is blocked; use guardian_delete_paths or guardian_hygiene", stripped);
    }
  }
  return null;
}
