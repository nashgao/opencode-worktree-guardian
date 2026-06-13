import type { HookContext, PluginClient, RecordLike } from "../types.ts";
import { isRecordLike } from "../types.ts";

const SERVICE = "worktree-guardian";
const MAX_STRING_LENGTH = 160;
const SECRET_KEY_PATTERN = /(token|secret|password|passwd|authorization|cookie|api[-_]?key|credential)/i;

function truncate(value: string) {
  if (typeof value !== "string") return value;
  if (value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_LENGTH)}...<truncated:${value.length}>`;
}

function redactString(value: string) {
  return truncate(value)
    .replace(/(authorization:\s*)(bearer\s+)?\S+/gi, "$1$2<redacted>")
    .replace(/(token|secret|password|passwd|api[-_]?key|cookie|credential)=([^\s&]+)/gi, "$1=<redacted>");
}

function summarize(value: unknown, key = ""): unknown {
  if (SECRET_KEY_PATTERN.test(key)) return "<redacted>";
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      preview: value.slice(0, 5).map((entry) => summarize(entry, key)),
    };
  }
  if (isRecordLike(value)) {
    const entries = Object.entries(value).slice(0, 12);
    return Object.fromEntries(entries.map(([entryKey, entryValue]) => [entryKey, summarize(entryValue, entryKey)]));
  }
  return typeof value;
}

export async function writeLog(client: PluginClient | undefined, event: RecordLike) {
  if (typeof client?.app?.log === "function") {
    await client.app.log({ body: event });
    return;
  }

  console.error(JSON.stringify(event));
}

export function createEvent(message: string, input: unknown, output: unknown, context: HookContext, extra: RecordLike = {}): RecordLike {
  const summarizedExtra = summarize(extra);
  return {
    service: SERVICE,
    level: "info",
    message,
    directory: context.directory,
    worktree: context.worktree,
    input: summarize(input),
    output: summarize(output),
    ...(isRecordLike(summarizedExtra) ? summarizedExtra : {}),
  };
}
