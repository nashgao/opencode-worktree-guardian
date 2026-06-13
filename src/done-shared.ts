import path from "node:path";
import { isRecordLike } from "./types.ts";

export function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

export function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function blocked(reason: string, details: Record<string, unknown> = {}, preflight?: Record<string, unknown>): Record<string, unknown> {
  if (preflight) preflight.blockers = [...((preflight.blockers as string[] | undefined) ?? []), reason];
  return { ok: false, status: "blocked", reason, ...details, ...(preflight ? { preflight } : {}) };
}

export function text(input: unknown): string {
  return typeof input === "string" ? input : "";
}

export function errorMessage(error: unknown): string {
  if (isRecordLike(error)) {
    if (typeof error.gitStderr === "string" && error.gitStderr.length > 0) return error.gitStderr;
    if (typeof error.message === "string" && error.message.length > 0) return error.message;
  }
  return String(error);
}
