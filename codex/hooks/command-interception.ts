import { z } from "zod";
import { evaluateGuardCommand } from "../../src/plugin/guard-evaluation.ts";

const UnknownRecordSchema = z.record(z.string(), z.unknown());
const HookPayloadSchema = z
  .looseObject({
    hook_event_name: z.string(),
    session_id: z.string(),
    cwd: z.string(),
    tool_name: z.string().optional(),
    tool_input: UnknownRecordSchema.optional(),
  });

export type HookPayload = Readonly<z.infer<typeof HookPayloadSchema>>;

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function parseHookPayload(raw: string): HookPayload | undefined {
  if (raw.trim().length === 0) return undefined;
  try {
    const parsed = HookPayloadSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export function commandFromToolInput(toolInput: Record<string, unknown> | undefined): string {
  if (toolInput === undefined) return "";
  return stringField(toolInput, "command") ?? stringField(toolInput, "cmd") ?? stringField(toolInput, "code") ?? "";
}

export async function runPreToolUse(payload: HookPayload): Promise<string> {
  if (payload.hook_event_name !== "PreToolUse") return "";
  const command = commandFromToolInput(payload.tool_input);
  if (command.trim().length === 0) return "";
  let evaluation: Awaited<ReturnType<typeof evaluateGuardCommand>>;
  try {
    evaluation = await evaluateGuardCommand({ command, cwd: payload.cwd, currentWorktree: payload.cwd });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return `${JSON.stringify({
      decision: "block",
      reason: `Worktree Guardian blocked command: ${error.message}. Use guardian_status or guardian_finish instead.`,
    })}\n`;
  }
  if (!evaluation.enforcedGuard.blocked) return "";
  return `${JSON.stringify({
    decision: "block",
    reason: `Worktree Guardian blocked command: ${evaluation.enforcedGuard.reason}. Use guardian_status or guardian_finish instead.`,
  })}\n`;
}
