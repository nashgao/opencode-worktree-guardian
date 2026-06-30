import fs from "node:fs/promises";
import path from "node:path";
import { errorCode, isRecordLike } from "./types.ts";

export function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

export function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function realPathOrResolved(candidate: string): Promise<string> {
  try {
    return await fs.realpath(candidate);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return path.resolve(candidate);
    throw error;
  }
}

export async function samePathOnDisk(left: string, right: string): Promise<boolean> {
  const [leftPath, rightPath] = await Promise.all([realPathOrResolved(left), realPathOrResolved(right)]);
  return samePath(leftPath, rightPath);
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
