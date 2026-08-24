export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export const DETAIL_LIST_LIMIT = 8;

export function inertText(value: string): string {
  return value
    .replace(/\u001b\][^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?/g, "")
    .replace(/\u009d[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u009b[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g, (control) => {
      const codePoint = control.codePointAt(0);
      return codePoint === undefined ? "" : `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
    })
    .replace(/\r\n|\n|\r/g, "\\n")
    .replace(/\t/g, "\\t");
}

export function textValue(value: unknown, fallback = "-") {
  return inertText(typeof value === "string" && value.length > 0 ? value : fallback);
}

export function shortCommit(value: unknown) {
  const text = textValue(value);
  return text === "-" ? text : text.slice(0, 12);
}

export function describeEntry(entry: unknown) {
  const item = recordValue(entry);
  return textValue(item.session_id ?? item.sessionId ?? item.branch ?? item.path ?? item.worktree_path ?? item.name ?? item.ref ?? item.command ?? entry, JSON.stringify(entry) ?? "-");
}

type BoundedListInput = {
  readonly lines: string[];
  readonly heading: string;
  readonly entries: readonly unknown[];
  readonly format: (entry: unknown) => string;
  readonly count?: unknown;
  readonly limit?: number;
  readonly afterEntry?: (entry: unknown) => void;
};

function itemCount(entries: readonly unknown[], value: unknown): number {
  const reported = typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  return Math.max(entries.length, reported);
}

export function appendBoundedList({ lines, heading, entries, format, count, limit = DETAIL_LIST_LIMIT, afterEntry }: BoundedListInput): void {
  const total = itemCount(entries, count);
  if (total === 0) return;
  const boundedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DETAIL_LIST_LIMIT;
  const shown = Math.min(entries.length, boundedLimit);
  const omitted = Math.max(0, total - shown);
  lines.push(`${heading}: ${total}${omitted > 0 ? ` | omitted: ${omitted}` : ""}`);
  for (const entry of entries.slice(0, boundedLimit)) {
    lines.push(format(entry));
    afterEntry?.(entry);
  }
}

export function appendStashInventoryWarning(lines: string[], value: unknown): void {
  const stashCount = typeof value === "number" ? value : 0;
  if (stashCount <= 0) return;
  lines.push(`[WARN] repository stash inventory: ${stashCount}; Guardian will not mutate stashes`);
  lines.push("[INFO] inspect with: git stash list");
}
