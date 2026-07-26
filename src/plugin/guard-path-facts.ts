import path from "node:path";
import { isRecursiveForce, rmTargets } from "../guards/destructive-inputs.ts";
import { commandSegments, tokenizeCommand } from "../guards/shell-parser.ts";
import { shellPayload, stripCommandWrappers } from "../guards/shell-prefix.ts";
import type { GuardPathFacts } from "../tool-types.ts";
import { canonicalPath } from "./canonical-path.ts";
import { discoverGitInvocations, gitInspectionTargetForInvocation } from "./effective-git-config.ts";

function destructiveTargets(command: string, cwd: string): readonly string[] {
  return commandSegments(tokenizeCommand(command)).flatMap((segment) => {
    const payload = shellPayload(segment);
    if (payload) return destructiveTargets(payload.payload, payload.envCwd ? path.resolve(cwd, payload.envCwd) : cwd);
    const stripped = stripCommandWrappers(segment);
    return stripped[0] === "rm" && isRecursiveForce(stripped.slice(1))
      ? rmTargets(stripped.slice(1)).map((target) => path.resolve(cwd, target))
      : [];
  });
}

export async function collectGuardPathFacts(input: {
  readonly command: string | null | undefined;
  readonly cwd: string;
  readonly repoRoots: readonly string[];
  readonly knownWorktreePaths: readonly string[];
}): Promise<GuardPathFacts> {
  const targets = input.command ? destructiveTargets(input.command, input.cwd) : [];
  const gitTargets = input.command
    ? discoverGitInvocations(input.command, input.cwd).flatMap((discovered) => {
      const target = gitInspectionTargetForInvocation(discovered);
      return [target.cwd, target.gitDir, target.workTree].filter((value): value is string => value !== null);
    })
    : [];
  const allTargets = [...new Set([...targets, ...gitTargets])];
  const canonicalTargets = Object.fromEntries(await Promise.all(allTargets.map(async (target) => [target, await canonicalPath(target)])));
  return {
    canonicalRepoRoots: await Promise.all(input.repoRoots.map(canonicalPath)),
    canonicalKnownWorktreePaths: await Promise.all(input.knownWorktreePaths.map(canonicalPath)),
    canonicalTargets,
  };
}
