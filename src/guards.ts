import path from "node:path";

const STASH_READ_ONLY = new Set(["list", "show"]);
const SEGMENT_BREAKS = new Set([";", "&&", "||", "|", "(", ")"]);
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path"]);
const GIT_PUSH_OPTIONS_WITH_VALUE = new Set(["--repo", "--receive-pack", "--exec", "--push-option", "--recurse-submodules", "-o"]);
const COMMAND_WRAPPERS = new Set(["command", "sudo", "if", "then", "do"]);
const SHELL_COMMANDS = new Set(["bash", "sh", "zsh", "dash", "fish"]);
const READ_ONLY_SHELL_COMMANDS = new Set(["pwd"]);
const READ_ONLY_GIT_COMMANDS = new Set(["status", "diff", "log", "show", "rev-parse", "branch", "worktree", "stash", "remote", "ls-files"]);

export function tokenizeCommand(command: string) {
  const tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const pair = `${char}${command[index + 1] ?? ""}`;
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if ((char === "'" || char === '"') && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (quote === null && (char === "\n" || char === "\r")) {
      if (token) tokens.push(token);
      tokens.push(";");
      token = "";
      continue;
    }
    if (quote === null && /\s/.test(char)) {
      if (token) tokens.push(token);
      token = "";
      continue;
    }
    if (quote === null && (pair === "&&" || pair === "||")) {
      if (token) tokens.push(token);
      tokens.push(pair);
      token = "";
      index += 1;
      continue;
    }
    if (quote === null && (char === ";" || char === "|" || char === "(" || char === ")")) {
      if (token) tokens.push(token);
      tokens.push(char);
      token = "";
      continue;
    }
    if (quote === null && char === "$" && command[index + 1] === "(") {
      if (token) tokens.push(token);
      tokens.push("(");
      token = "";
      index += 1;
      continue;
    }
    token += char;
  }
  if (token) tokens.push(token);
  return tokens;
}

function commandSegments(tokens: string[]) {
  const segments = [];
  let current = [];
  for (const token of tokens) {
    if (SEGMENT_BREAKS.has(token)) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

function hasForceCleanFlag(tokens: string[]) {
  return tokens.some((token) => token === "--force" || token === "-f" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(token));
}

function hasDryRunFlag(tokens: string[]) {
  return tokens.some((token) => token === "--dry-run" || token === "-n" || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(token));
}

function isCheckoutPathRestore(rest: string[]) {
  return rest.includes("--") && rest.indexOf("--") < rest.length - 1;
}

function isRestoreDestructive(rest: string[]) {
  if (rest.includes("--staged") && !rest.includes("--worktree") && rest.every((token) => token === "--staged" || token.startsWith("-"))) {
    return false;
  }
  return rest.includes("--worktree") || rest.some((token) => !token.startsWith("-"));
}

function shellPayload(segment: string[]) {
  const stripped = stripCommandWrappers(segment);
  if (!SHELL_COMMANDS.has(stripped[0])) return null;
  for (let index = 1; index < stripped.length; index += 1) {
    const token = stripped[index];
    if (token === "-c" || token === "-lc" || token === "-cl" || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(token)) {
      return stripped[index + 1] ?? "";
    }
  }
  return null;
}

function isRecursiveForce(tokens: string[]) {
  const flags = tokens.filter((token) => token.startsWith("-"));
  return flags.some((flag) => flag.includes("r") || flag.includes("R")) && flags.some((flag) => flag.includes("f") || flag.includes("F"));
}

function normalizeForCompare(value: string, cwd: string) {
  const resolved = path.resolve(cwd, value);
  return path.normalize(resolved);
}

function isSameOrInside(candidate: string, knownPath: string) {
  const relative = path.relative(knownPath, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function matchesKnownWorktreePath(candidate: string, knownWorktreePaths: string[], cwd: string) {
  if (!candidate || candidate.startsWith("-")) return false;
  const resolvedCandidate = normalizeForCompare(candidate, cwd);
  return knownWorktreePaths.some((knownPath) => isSameOrInside(resolvedCandidate, normalizeForCompare(knownPath, cwd)));
}

function block(reason: string, segment: string[]) {
  return { blocked: true, reason, command: segment.join(" "), segment };
}

function stringArrayOption(options: Record<string, any>, key: string) {
  const value = options[key];
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function stringOption(options: Record<string, any>, key: string) {
  const value = options[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function branchNameFromRef(ref: string) {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

function isProtectedRef(ref: string, protectedBranches: string[]) {
  return protectedBranches.includes(branchNameFromRef(ref));
}

function isGuardianRef(ref: string, branchPrefix: string) {
  return branchNameFromRef(ref).startsWith(branchPrefix);
}

function pushRefspecs(rest: string[]) {
  let index = 0;
  let repoOption = false;
  while (index < rest.length) {
    const token = rest[index];
    if (token === "--") {
      index += 1;
      break;
    }
    if (!token.startsWith("-")) break;
    if (token === "--repo") {
      repoOption = true;
      index += 2;
      continue;
    }
    if (token.startsWith("--repo=")) {
      repoOption = true;
      index += 1;
      continue;
    }
    if (GIT_PUSH_OPTIONS_WITH_VALUE.has(token)) {
      index += 2;
      continue;
    }
    if ([...GIT_PUSH_OPTIONS_WITH_VALUE].some((option) => token.startsWith(`${option}=`))) {
      index += 1;
      continue;
    }
    index += 1;
  }
  if (!repoOption && index < rest.length) index += 1;
  return rest.slice(index).filter((token) => token && !token.startsWith("-"));
}

function isForcePushToken(token: string) {
  return token === "--force" || token.startsWith("--force=") || token === "--force-with-lease" || token.startsWith("--force-with-lease=") || token === "-f";
}

function protectedBranchBypass(segment: string[], subcommand: string, rest: string[], options: Record<string, any>) {
  const protectedBranches = stringArrayOption(options, "protectedBranches");
  const branchPrefix = stringOption(options, "branchPrefix");
  if (protectedBranches.length === 0 || !branchPrefix) return null;

  if (subcommand === "push") {
    const deletesBranch = rest.includes("--delete") || rest.includes("-d");
    for (const rawSpec of pushRefspecs(rest)) {
      const spec = rawSpec.startsWith("+") ? rawSpec.slice(1) : rawSpec;
      const colon = spec.indexOf(":");
      if (colon === -1) {
        if (deletesBranch && isProtectedRef(spec, protectedBranches)) {
          return block("protected branch deletion push is blocked", segment);
        }
        continue;
      }
      const source = spec.slice(0, colon);
      const target = spec.slice(colon + 1);
      if (!source && target && isProtectedRef(target, protectedBranches)) {
        return block("protected branch deletion push is blocked", segment);
      }
      if (target && isProtectedRef(target, protectedBranches) && (source === "HEAD" || isGuardianRef(source, branchPrefix))) {
        return block("manual push from Guardian work to a protected branch is blocked; use guardian_finish", segment);
      }
    }
  }

  if (subcommand === "merge") {
    const currentBranch = stringOption(options, "currentBranch");
    if (!currentBranch || !isProtectedRef(currentBranch, protectedBranches)) return null;
    const mergeTargets = rest.filter((token) => token && !token.startsWith("-"));
    if (mergeTargets.some((target) => isGuardianRef(target, branchPrefix))) {
      return block("manual merge of Guardian work into a protected branch is blocked; use guardian_finish", segment);
    }
  }

  return null;
}

function stripCommandWrappers(segment: string[]) {
  let index = 0;
  while (COMMAND_WRAPPERS.has(segment[index])) index += 1;
  if (segment[index] === "env") {
    index += 1;
    while (segment[index] && (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(segment[index]) || segment[index].startsWith("-"))) index += 1;
  }
  return segment.slice(index);
}

function parseGitInvocation(segment: string[]) {
  const stripped = stripCommandWrappers(segment);
  if (stripped[0] !== "git") return null;
  let index = 1;
  while (index < stripped.length) {
    const token = stripped[index];
    if (!token.startsWith("-")) break;
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(token)) {
      index += 2;
      continue;
    }
    if ([...GIT_GLOBAL_OPTIONS_WITH_VALUE].some((option) => token.startsWith(`${option}=`))) {
      index += 1;
      continue;
    }
    index += 1;
  }
  return { subcommand: stripped[index], rest: stripped.slice(index + 1), normalized: stripped };
}

function classifyGit(segment: string[], options: Record<string, any> = {}) {
  const parsed = parseGitInvocation(segment);
  if (!parsed?.subcommand) return null;
  const { subcommand, rest, normalized } = parsed;
  const bypass = protectedBranchBypass(normalized, subcommand, rest, options);
  if (bypass) return bypass;
  if (subcommand === "reset" && rest.includes("--hard")) {
    return block("git reset --hard is blocked because it can discard session work", normalized);
  }
  if (subcommand === "clean" && hasForceCleanFlag(rest) && !hasDryRunFlag(rest)) {
    return block("destructive git clean variants are blocked", normalized);
  }
  if (subcommand === "branch" && (rest.includes("-D") || rest.includes("--delete") && rest.includes("--force"))) {
    return block("forced branch deletion is blocked", normalized);
  }
  if (subcommand === "worktree" && ["remove", "prune"].includes(rest[0])) {
    return block("raw git worktree removal/prune is blocked", normalized);
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
  return null;
}

function hasUnsafeReadOnlySyntax(command: string, tokens: string[]) {
  return command.includes("`") || command.includes("$(") || /[<>]/.test(command) || tokens.some((token) => SEGMENT_BREAKS.has(token));
}

function isAllowedReadOnlyGit(segment: string[]) {
  const parsed = parseGitInvocation(segment);
  if (!parsed?.subcommand || !READ_ONLY_GIT_COMMANDS.has(parsed.subcommand)) return false;
  const { subcommand, rest } = parsed;

  if (subcommand === "status") {
    return rest.every((token) => token.startsWith("-") || token === "--");
  }
  if (subcommand === "branch") {
    return rest.every((token) => token === "--list" || token === "--show-current" || token === "-a" || token === "-r" || token.startsWith("--format="));
  }
  if (subcommand === "worktree") {
    return rest[0] === "list" && rest.slice(1).every((token) => token.startsWith("-"));
  }
  if (subcommand === "stash") {
    const action = rest.find((token) => !token.startsWith("-")) ?? "list";
    return STASH_READ_ONLY.has(action);
  }
  if (subcommand === "remote") {
    return rest.length === 0 || rest.every((token) => token === "-v" || token === "--verbose");
  }
  if (subcommand === "diff") {
    return !rest.some((token) => token === "--output" || token.startsWith("--output=") || token === "--ext-diff" || token === "--textconv");
  }
  return true;
}

export function classifyReadOnlyInspectionCommand(command: unknown) {
  if (typeof command !== "string" || command.trim() === "") return { allowed: false, reason: "empty command" };
  const tokens = tokenizeCommand(command);
  if (hasUnsafeReadOnlySyntax(command, tokens)) return { allowed: false, reason: "compound or redirected shell syntax is not read-only allowlisted" };
  const segment = commandSegments(tokens)[0] ?? [];
  const stripped = stripCommandWrappers(segment);
  if (stripped.length === 1 && READ_ONLY_SHELL_COMMANDS.has(stripped[0])) return { allowed: true, reason: null };
  if (SHELL_COMMANDS.has(stripped[0])) return { allowed: false, reason: "shell payload execution is not read-only allowlisted" };
  if (isAllowedReadOnlyGit(segment)) return { allowed: true, reason: null };
  return { allowed: false, reason: "command is not read-only allowlisted" };
}

function classifySegment(segment: string[], options: Record<string, any>) {
  const payload = shellPayload(segment);
  if (payload) {
    const nested = classifyGuardCommand(payload, options);
    if (nested.blocked) return block(`shell -c payload is blocked: ${nested.reason}`, segment);
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
  }
  return null;
}

function findBacktickPayloads(command: string) {
  const payloads = [];
  let escaped = false;
  let start = -1;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "`") {
      if (start === -1) start = index + 1;
      else {
        payloads.push(command.slice(start, index));
        start = -1;
      }
    }
  }
  return payloads;
}

export function classifyGuardCommand(command: unknown, options: Record<string, any> = {}) {
  if (typeof command !== "string" || command.trim() === "") {
    return { blocked: false, reason: null, command: "", tokens: [] };
  }
  for (const payload of findBacktickPayloads(command)) {
    const nested = classifyGuardCommand(payload, options);
    if (nested.blocked) return { ...nested, reason: `backtick command substitution is blocked: ${nested.reason}` };
  }
  const tokens = tokenizeCommand(command);
  for (const segment of commandSegments(tokens)) {
    const result = classifySegment(segment, options);
    if (result) return { ...result, tokens };
  }
  return { blocked: false, reason: null, command, tokens };
}

export function extractCommandText(input: Record<string, any> = {}, output: Record<string, any> = {}) {
  return output?.args?.command ?? input?.args?.command ?? input?.command ?? output?.command ?? "";
}
