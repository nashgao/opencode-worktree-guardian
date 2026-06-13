import path from "node:path";
import type { GuardCommandPayload, SessionWorktreeResult } from "../types.ts";
import { errorMessage, isMutableRecord } from "../types.ts";
import { validateRecordedSessionTarget } from "./session-routing.ts";

const DIRECT_FILE_MUTATION_TOOLS = new Set([
  "write",
  "edit",
  "multiedit",
  "patch",
  "apply_patch",
  "functions.apply_patch",
]);
const DIRECT_FILE_PATH_KEYS = ["filePath", "filepath", "path", "target", "filename"];

function normalizePathForCompare(candidate: string) {
  return path.resolve(candidate);
}

function isPathInside(parent: string, candidate: string) {
  const relative = path.relative(normalizePathForCompare(parent), normalizePathForCompare(candidate));
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function directFileMutationPathArg(input: GuardCommandPayload = {}, output: GuardCommandPayload = {}) {
  const toolName = String(input.tool ?? "");
  if (!DIRECT_FILE_MUTATION_TOOLS.has(toolName)) return null;
  const args = isMutableRecord(output.args) ? output.args : isMutableRecord(input.args) ? input.args : null;
  if (!args) return null;
  for (const key of DIRECT_FILE_PATH_KEYS) {
    if (typeof args[key] === "string" && path.isAbsolute(args[key])) return { args, key, value: args[key] };
  }
  return null;
}

export async function routeDirectFileMutation(input: GuardCommandPayload, output: GuardCommandPayload, sessionWorktree: SessionWorktreeResult | null, repoRoot: string | undefined, cache: Map<string, string>) {
  const pathArg = directFileMutationPathArg(input, output);
  if (!pathArg) return { routed: false, blocked: false, reason: null };
  if (!repoRoot) return { routed: false, blocked: true, reason: "direct file mutation cannot be checked without a Guardian repo root" };
  if (!isPathInside(repoRoot, pathArg.value)) return { routed: false, blocked: false, reason: null };
  if (sessionWorktree?.sessionId == null) return { routed: false, blocked: false, reason: null };
  if (typeof sessionWorktree?.expectedWorktree !== "string") {
    return { routed: false, blocked: true, reason: "direct file mutation cannot be checked against a recorded Guardian worktree" };
  }
  if (isPathInside(sessionWorktree.expectedWorktree, pathArg.value)) return { routed: false, blocked: false, reason: null };

  let routedSession = sessionWorktree;
  if (routedSession.ok !== true) {
    try {
      routedSession = await validateRecordedSessionTarget(input, routedSession, repoRoot, cache);
    } catch (error) {
      return { routed: false, blocked: true, reason: errorMessage(error) };
    }
  }

  const relative = path.relative(normalizePathForCompare(repoRoot), normalizePathForCompare(pathArg.value));
  const expectedWorktree = routedSession.expectedWorktree;
  if (typeof expectedWorktree !== "string") {
    return { routed: false, blocked: true, reason: "direct file mutation cannot be routed without a recorded Guardian worktree" };
  }
  const routedPath = path.join(expectedWorktree, relative);
  if (!isPathInside(expectedWorktree, routedPath)) {
    return { routed: false, blocked: true, reason: "direct file mutation path cannot be safely rewritten into the Guardian worktree" };
  }
  pathArg.args[pathArg.key] = routedPath;
  if (!isMutableRecord(output.args)) output.args = pathArg.args;
  return { routed: true, blocked: false, reason: null, originalPath: pathArg.value, routedPath };
}
