import path from "node:path";
import type { GuardCommandPayload, SessionWorktreeResult } from "../types.ts";
import { errorMessage, isMutableRecord } from "../types.ts";
import { canonicalPath } from "./canonical-path.ts";
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

export function directFileMutationPathArg(input: GuardCommandPayload, output: GuardCommandPayload, executionCwd: string) {
  const toolName = String(input.tool ?? "");
  if (!DIRECT_FILE_MUTATION_TOOLS.has(toolName)) return null;
  const args = isMutableRecord(output.args) ? output.args : isMutableRecord(input.args) ? input.args : null;
  if (!args) return null;
  for (const key of DIRECT_FILE_PATH_KEYS) {
    if (typeof args[key] === "string") return { args, key, value: path.resolve(executionCwd, args[key]) };
  }
  return null;
}

export async function routeDirectFileMutation(input: GuardCommandPayload, output: GuardCommandPayload, sessionWorktree: SessionWorktreeResult | null, repoRoot: string | undefined, executionCwd: string, cache: Map<string, string>) {
  const pathArg = directFileMutationPathArg(input, output, executionCwd);
  if (!pathArg) return { routed: false, blocked: false, reason: null };
  if (!repoRoot) return { routed: false, blocked: true, reason: "direct file mutation cannot be checked without a Guardian repo root" };
  const lexicallyInsideRepo = isPathInside(repoRoot, pathArg.value);
  let canonicalRepoRoot: string;
  let canonicalTarget: string;
  try {
    [canonicalRepoRoot, canonicalTarget] = await Promise.all([
      canonicalPath(repoRoot),
      canonicalPath(pathArg.value),
    ]);
  } catch (error) {
    return { routed: false, blocked: true, reason: errorMessage(error) };
  }
  if (!lexicallyInsideRepo && !isPathInside(canonicalRepoRoot, canonicalTarget)) return { routed: false, blocked: false, reason: null };
  if (sessionWorktree?.sessionId == null) return { routed: false, blocked: false, reason: null };
  // A terminal session has intentionally given up its worktree, so there is no live ownership to
  // enforce; treat it like "no session" and allow normal edits instead of locking the agent out.
  if (sessionWorktree?.terminal === true) return { routed: false, blocked: false, reason: null };
  if (typeof sessionWorktree?.expectedWorktree !== "string") {
    return { routed: false, blocked: true, reason: "direct file mutation cannot be checked against a recorded Guardian worktree" };
  }
  let routedSession = sessionWorktree;
  if (routedSession.ok !== true) {
    try {
      routedSession = await validateRecordedSessionTarget(input, routedSession, repoRoot, cache);
    } catch (error) {
      return { routed: false, blocked: true, reason: errorMessage(error) };
    }
  }

  const expectedWorktree = routedSession.expectedWorktree;
  if (typeof expectedWorktree !== "string") {
    return { routed: false, blocked: true, reason: "direct file mutation cannot be routed without a recorded Guardian worktree" };
  }
  let canonicalExpectedWorktree: string;
  try {
    canonicalExpectedWorktree = await canonicalPath(expectedWorktree);
  } catch (error) {
    return { routed: false, blocked: true, reason: errorMessage(error) };
  }
  if (!isPathInside(canonicalRepoRoot, canonicalTarget)) {
    return { routed: false, blocked: true, reason: "direct file mutation target resolves outside the Guardian repository" };
  }
  if (isPathInside(canonicalExpectedWorktree, canonicalTarget)) return { routed: false, blocked: false, reason: null };

  const relative = path.relative(canonicalRepoRoot, canonicalTarget);
  let routedPath: string;
  try {
    routedPath = await canonicalPath(path.join(canonicalExpectedWorktree, relative));
  } catch (error) {
    return { routed: false, blocked: true, reason: errorMessage(error) };
  }
  if (!isPathInside(canonicalExpectedWorktree, routedPath)) {
    return { routed: false, blocked: true, reason: "direct file mutation path cannot be safely rewritten into the Guardian worktree" };
  }
  pathArg.args[pathArg.key] = routedPath;
  if (!isMutableRecord(output.args)) output.args = pathArg.args;
  return { routed: true, blocked: false, reason: null, originalPath: pathArg.value, routedPath };
}
