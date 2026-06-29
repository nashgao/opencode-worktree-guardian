#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { z } from "zod";
import { loadConfig } from "../../src/config.ts";
import { classifyGuardCommand } from "../../src/guards.ts";
import { getCurrentBranch } from "../../src/git.ts";
import { formatGuardianOutput, READABLE_GUARDIAN_TOOLS } from "../../src/plugin/readable-output.ts";
import { getGuardianPaths } from "../../src/state.ts";
import { collectKnownWorktreePaths, recordLastSafeState, runGuardianTool } from "../../src/tools.ts";
import type { GuardOptions } from "../../src/types.ts";

const UnknownRecordSchema = z.record(z.string(), z.unknown());
const HookPayloadSchema = z.object({ hook_event_name: z.string(), session_id: z.string(), cwd: z.string(), tool_name: z.string().optional(), tool_input: UnknownRecordSchema.optional() }).passthrough();
const ToolArgsSchema = UnknownRecordSchema;
const PlanCacheFileSchema = z.object({ version: z.literal(1), entries: z.record(z.string(), z.string()) });
const HELP = "Usage:\n  guardian-hook hook pre-tool-use\n  guardian-hook hook post-tool-use\n  guardian-hook tool <guardian_tool_name> [json_args]\n";

type HookPayload = Readonly<z.infer<typeof HookPayloadSchema>>;

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function parseHookPayload(raw: string): HookPayload | undefined {
  if (raw.trim().length === 0) return undefined;
  try {
    const parsed = HookPayloadSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function commandFromToolInput(toolInput: Record<string, unknown> | undefined): string {
  if (toolInput === undefined) return "";
  return stringField(toolInput, "command") ?? stringField(toolInput, "cmd") ?? stringField(toolInput, "code") ?? "";
}

async function buildGuardOptions(cwd: string): Promise<GuardOptions> {
  try {
    const loaded = await loadConfig(cwd);
    const knownWorktreePaths = await collectKnownWorktreePaths({
      cwd,
      repoRoot: cwd,
      currentWorktree: cwd,
    });
    const currentBranch = await getCurrentBranch(cwd).catch((error: unknown) => {
      if (error instanceof Error) return null;
      throw error;
    });
    return {
      cwd,
      knownWorktreePaths,
      protectedBranches: loaded.config.protectedBranches,
      branchPrefix: loaded.config.branchPrefix,
      currentBranch,
    };
  } catch (error) {
    if (error instanceof Error) return { cwd };
    throw error;
  }
}

async function runPreToolUse(payload: HookPayload): Promise<string> {
  if (payload.hook_event_name !== "PreToolUse") return "";
  const command = commandFromToolInput(payload.tool_input);
  if (command.trim().length === 0) return "";
  const guard = classifyGuardCommand(command, await buildGuardOptions(payload.cwd));
  if (!guard.blocked) return "";
  return `${JSON.stringify({
    decision: "block",
    reason: `Worktree Guardian blocked command: ${guard.reason}. Use guardian_status or guardian_finish instead.`,
  })}\n`;
}

async function runPostToolUse(payload: HookPayload): Promise<string> {
  if (payload.hook_event_name !== "PostToolUse") return "";
  const command = commandFromToolInput(payload.tool_input);
  if (command.trim().length === 0) return "";
  await recordLastSafeState({
    repoRoot: payload.cwd,
    cwd: payload.cwd,
    sessionId: payload.session_id,
    tool: payload.tool_name,
  }).catch((error: unknown) => {
    if (error instanceof Error) return undefined;
    throw error;
  });
  return "";
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
}

function normalizeOptionalToolStrings(toolArgs: Record<string, unknown>): void {
  for (const key of ["repoRoot", "cwd", "sessionId", "branch", "targetPath", "worktreePath", "confirmToken"]) if (typeof toolArgs[key] === "string" && toolArgs[key].trim() === "") delete toolArgs[key];
}

function sortedStringArgs(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").sort((left, right) => left.localeCompare(right))
    : [];
}

function planCacheKey(name: string, toolArgs: Record<string, unknown>): string {
  return JSON.stringify({
    name, paths: sortedStringArgs(toolArgs["paths"]), cleanupPaths: sortedStringArgs(toolArgs["cleanupPaths"]), allowCategories: sortedStringArgs(toolArgs["allowCategories"]),
    sessionId: typeof toolArgs["sessionId"] === "string" ? toolArgs["sessionId"] : "", repoRoot: typeof toolArgs["repoRoot"] === "string" ? toolArgs["repoRoot"] : "", cwd: typeof toolArgs["cwd"] === "string" ? toolArgs["cwd"] : "",
    commitMessage: typeof toolArgs["commitMessage"] === "string" ? toolArgs["commitMessage"] : "", finishMode: typeof toolArgs["finishMode"] === "string" ? toolArgs["finishMode"] : "", action: typeof toolArgs["action"] === "string" ? toolArgs["action"] : "",
    allowTracked: toolArgs["allowTracked"] === true, allowRecursive: toolArgs["allowRecursive"] === true, allowDirtyNestedGit: toolArgs["allowDirtyNestedGit"] === true,
    primary: toolArgs["primary"] === true,
    deleteBranch: toolArgs["deleteBranch"] === true, abandonUnmerged: toolArgs["abandonUnmerged"] === true, allowIgnoredFiles: toolArgs["allowIgnoredFiles"] === true,
  });
}

function shouldUseCachedPlanToken(name: string, toolArgs: Record<string, unknown>): boolean {
  if (toolArgs["mode"] !== "apply") return false;
  if (name === "guardian_delete_paths" || name === "guardian_hygiene") return toolArgs["confirmDelete"] === true;
  return (name === "guardian_done" || name === "guardian_finish_workflow") && (toolArgs["confirm"] === true || toolArgs["confirmDelete"] === true);
}

function isPlaceholderConfirmToken(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  return normalized === "" || normalized === "CONFIRM_DELETE";
}

async function getPlanCachePath(repoRoot: string): Promise<string> {
  return path.join((await getGuardianPaths(repoRoot)).dir, "codex-plan-cache.json");
}

async function readPlanCache(repoRoot: string): Promise<Map<string, string>> {
  try {
    const cachePath = await getPlanCachePath(repoRoot);
    const parsed = PlanCacheFileSchema.safeParse(JSON.parse(await fs.readFile(cachePath, "utf8")));
    if (!parsed.success) return new Map();
    return new Map(Object.entries(parsed.data.entries));
  } catch (error) {
    if (isEnoent(error) || error instanceof SyntaxError) return new Map();
    throw error;
  }
}

async function writePlanCache(repoRoot: string, cache: Map<string, string>): Promise<void> {
  const cachePath = await getPlanCachePath(repoRoot);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify({ version: 1, entries: Object.fromEntries(cache) }, null, 2)}\n`);
  await fs.rename(tmpPath, cachePath);
}

function maybeInjectPlanConfirmToken(name: string, toolArgs: Record<string, unknown>, cache: Map<string, string>): void {
  if (!shouldUseCachedPlanToken(name, toolArgs)) return;
  if (typeof toolArgs["confirmToken"] === "string" && !isPlaceholderConfirmToken(toolArgs["confirmToken"])) return;
  const cachedToken = cache.get(planCacheKey(name, toolArgs));
  if (cachedToken !== undefined) toolArgs["confirmToken"] = cachedToken;
}

function rememberPlanConfirmToken(name: string, toolArgs: Record<string, unknown>, result: Record<string, unknown>, cache: Map<string, string>): boolean {
  if (toolArgs["mode"] !== "plan" || result["ok"] !== true || result["status"] !== "planned") return false;
  if (!["guardian_delete_paths", "guardian_done", "guardian_finish_workflow", "guardian_hygiene"].includes(name) || typeof result["confirmToken"] !== "string") return false;
  cache.set(planCacheKey(name, toolArgs), result["confirmToken"]);
  return true;
}

async function readStdin(): Promise<string> {
  return await new Promise((resolve, reject) => {
    let data = "";
    processStdin.setEncoding("utf8");
    processStdin.on("data", (chunk: string) => {
      data += chunk;
    });
    processStdin.once("error", reject);
    processStdin.once("end", () => resolve(data));
  });
}

function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw.trim().length === 0) return {};
  const parsed = ToolArgsSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error("tool args must be a JSON object");
  return parsed.data;
}

function textField(record: Record<string, unknown>, key: string, fallback = "-"): string {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function confirmationHint(name: string, result: Record<string, unknown>): string | undefined {
  if (result["status"] !== "planned" || typeof result["confirmToken"] !== "string") return undefined;
  if (name === "guardian_hygiene" || name === "guardian_delete_paths") {
    return "After explicit user confirmation, rerun with mode=apply and confirmDelete=true; the Codex adapter reuses the matching cached plan token.";
  }
  if (name === "guardian_done" || name === "guardian_finish_workflow") {
    return "After explicit user confirmation, rerun with mode=apply and confirm=true; the Codex adapter reuses the matching cached plan token.";
  }
  if (name === "guardian_delete_worktree") {
    return `After explicit user confirmation, rerun with mode=apply and confirmToken=${result["confirmToken"]}; delete-worktree tokens are not auto-injected.`;
  }
  return undefined;
}

function formatToolOutput(name: string, result: Record<string, unknown>): string {
  if (READABLE_GUARDIAN_TOOLS.has(name)) {
    const formatted = formatGuardianOutput(name, result);
    const hint = confirmationHint(name, result);
    return `${hint === undefined ? formatted : `${formatted}\n[INFO] ${hint}`}\n`;
  }
  const status = textField(result, "status", result["ok"] === false ? "blocked" : "completed");
  const lines = [`${result["ok"] === false ? "[FAIL]" : status === "planned" ? "[WARN]" : "[GOOD]"} ${name} ${status}`];
  const repoRoot = textField(result, "repoRoot", "");
  if (repoRoot.length > 0) lines.push(`[INFO] repoRoot: ${repoRoot}`);
  if (name === "guardian_status") {
    const count = (value: unknown) => Array.isArray(value) ? value.length : 0;
    lines.push(`[INFO] sessions: ${count(result["sessions"])} | worktrees: ${count(result["worktrees"])} | orphaned: ${count(result["orphanedSessions"])} | dirty: ${count(result["dirtyFiles"])}`);
  }
  const reason = textField(result, "reason", "");
  if (reason.length > 0) lines.push(`${result["ok"] === false ? "[FAIL]" : "[INFO]"} ${reason}`);
  const hint = confirmationHint(name, result);
  if (hint !== undefined) lines.push(`[INFO] ${hint}`);
  return `${lines.join("\n")}\n`;
}

async function runTool(name: string | undefined, rawArgs: string | undefined): Promise<string> {
  if (name === undefined) throw new Error("guardian tool name is required");
  const args = parseToolArgs(rawArgs);
  normalizeOptionalToolStrings(args);
  if (args["repoRoot"] === undefined) args["repoRoot"] = process.cwd();
  if (args["cwd"] === undefined) args["cwd"] = process.cwd();
  const repoRoot = typeof args["repoRoot"] === "string" ? args["repoRoot"] : process.cwd();
  const cache = await readPlanCache(repoRoot);
  maybeInjectPlanConfirmToken(name, args, cache);
  const result = await runGuardianTool(name, args);
  if (rememberPlanConfirmToken(name, args, result, cache)) await writePlanCache(repoRoot, cache);
  return formatToolOutput(name, result);
}

async function main(): Promise<number> {
  const [command, subcommand, toolName, rawArgs] = process.argv.slice(2);
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    processStdout.write(HELP);
    return 0;
  }
  if (command === "hook" && subcommand === "pre-tool-use") {
    const payload = parseHookPayload(await readStdin());
    if (payload !== undefined) processStdout.write(await runPreToolUse(payload));
    return 0;
  }
  if (command === "hook" && subcommand === "post-tool-use") {
    const payload = parseHookPayload(await readStdin());
    if (payload !== undefined) processStdout.write(await runPostToolUse(payload));
    return 0;
  }
  if (command === "tool") {
    processStdout.write(await runTool(subcommand, toolName));
    return 0;
  }
  processStdout.write(HELP);
  return 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`[guardian-codex] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
