import type { CommandSegment } from "./guard-types.ts";
import { hasDynamicShellArgument } from "./git-invocation.ts";

export function updateRefDeleteTarget(tokens: CommandSegment): string | null {
  let deletes = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "-d" || token === "--delete") {
      deletes = true;
      continue;
    }
    if (token.startsWith("--delete=")) return token.slice("--delete=".length);
    if (token === "-m") {
      index += 1;
      continue;
    }
    if (token === "--") return deletes ? tokens[index + 1] ?? null : null;
    if (deletes && !token.startsWith("-")) return token;
  }
  return null;
}

export function hasUpdateRefStdin(tokens: CommandSegment): boolean {
  return tokens.includes("--stdin");
}

export function isBranchRefDeleteTarget(target: string | null): boolean {
  return target === "HEAD" || target === "@" || Boolean(target?.startsWith("refs/heads/"));
}

export function updateRefTarget(tokens: CommandSegment): string | null {
  const deleteTarget = updateRefDeleteTarget(tokens);
  if (deleteTarget) return deleteTarget;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--") return tokens[index + 1] ?? null;
    if (token === "-m") {
      index += 1;
      continue;
    }
    if (!token.startsWith("-")) return token;
  }
  return null;
}

export function isGuardianRecoveryRefTarget(target: string): boolean {
  const ref = target.replace(/@\{[^}]*\}$/, "");
  return ref === "refs/opencode-guardian" || ref.startsWith("refs/opencode-guardian/");
}

export function isRecoveryRefTarget(target: string | null): boolean {
  if (!target) return false;
  const ref = target.replace(/@\{[^}]*\}$/, "");
  return ref === "stash" || ref === "refs/stash" || ref.startsWith("refs/stash/") || isGuardianRecoveryRefTarget(ref);
}

export function symbolicRefMutationTarget(tokens: CommandSegment): string | null {
  const positional: string[] = [];
  let deletes = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "-d" || token === "--delete") {
      deletes = true;
      continue;
    }
    if (token === "-m") {
      index += 1;
      continue;
    }
    if (token === "--") {
      positional.push(...tokens.slice(index + 1));
      break;
    }
    if (!token.startsWith("-")) positional.push(token);
  }
  return deletes || positional.length >= 2 ? positional[0] ?? null : null;
}

export function reflogMutatesRecoveryRef(tokens: CommandSegment): boolean {
  const action = tokens[0] ?? "";
  if (!["delete", "drop", "expire", "write"].includes(action)) return false;
  return tokens.includes("--all") || tokens.slice(1).some(isRecoveryRefTarget);
}

export function reflogHasDynamicMutationTarget(tokens: CommandSegment): boolean {
  const action = tokens[0] ?? "";
  return ["delete", "drop", "expire", "write"].includes(action) && hasDynamicShellArgument(tokens.slice(1));
}
