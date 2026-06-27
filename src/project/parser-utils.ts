import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import type { ProjectTodoCount, ProjectWarning } from "./types.ts";
import { errorCode, errorMessage, isRecordLike } from "../types.ts";

export const PROJECT_LIMITS = {
  maxRoots: 10,
  maxFileBytes: 1024 * 1024,
  maxRoadmaps: 20,
  maxMilestoneReviews: 30,
  maxOmoPlans: 30,
  maxOmoLoops: 20,
  maxLedgerLines: 1_000,
  maxLedgerEvents: 25,
  maxConcurrentFileReads: 4,
} as const;

export type MarkdownHeading = {
  readonly level: number;
  readonly text: string;
  readonly line: number;
};

export function relativeArtifactPath(root: string, artifactPath: string): string {
  const relative = path.relative(root, artifactPath);
  return relative.length > 0 ? relative.split(path.sep).join("/") : path.basename(artifactPath);
}

function isInsidePath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function warning(code: string, message: string, artifactPath?: string): ProjectWarning {
  return {
    code,
    message,
    ...(artifactPath === undefined ? {} : { path: artifactPath }),
  };
}

export function textField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function objectField(value: unknown): Record<string, unknown> | undefined {
  return isRecordLike(value) ? value : undefined;
}

export function parseHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const lines = markdown.split("\n");
  for (const [index, line] of lines.entries()) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const marker = match[1];
    const text = match[2];
    if (!marker || !text) continue;
    headings.push({ level: marker.length, text, line: index });
  }
  return headings;
}

export function countChecklist(lines: readonly string[]): ProjectTodoCount {
  let total = 0;
  let done = 0;
  for (const line of lines) {
    const match = /^\s*[-*]\s+\[([ xX])\]\s+/.exec(line);
    if (!match) continue;
    total += 1;
    if (match[1]?.toLowerCase() === "x") done += 1;
  }
  return { total, done, pending: total - done };
}

export function tableRows(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|") && !/^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line));
}

export function sectionBetween(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${heading}\\s*$`, "i").test(line.trim()));
  if (start < 0) return "";
  const collected: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) break;
    collected.push(line);
  }
  return collected.join("\n").trim();
}

let activeFileReads = 0;
const fileReadQueue: Array<() => void> = [];

async function withFileReadSlot<T>(read: () => Promise<T>): Promise<T> {
  if (activeFileReads >= PROJECT_LIMITS.maxConcurrentFileReads) {
    await new Promise<void>((resolve) => fileReadQueue.push(resolve));
  }
  activeFileReads += 1;
  try {
    return await read();
  } finally {
    activeFileReads -= 1;
    fileReadQueue.shift()?.();
  }
}

async function firstSymlinkSegment(root: string, artifactPath: string): Promise<string | null> {
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(artifactPath);
  const relative = path.relative(rootPath, targetPath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;

  let current = rootPath;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) return current;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }
  return null;
}

async function isRealPathInsideRoot(root: string, artifactPath: string): Promise<boolean> {
  const [rootRealPath, artifactRealPath] = await Promise.all([fs.realpath(root), fs.realpath(artifactPath)]);
  return isInsidePath(rootRealPath, artifactRealPath);
}

async function validateArtifactPath(root: string, artifactPath: string, warnings: ProjectWarning[], kind: "file" | "directory"): Promise<boolean> {
  const relativePath = relativeArtifactPath(root, artifactPath);
  const stat = await fs.lstat(artifactPath);
  if (stat.isSymbolicLink()) {
    warnings.push(warning("artifact_symlink", `Artifact ${kind} is a symlink and was skipped`, relativePath));
    return false;
  }
  if (kind === "file" && !stat.isFile()) {
    warnings.push(warning("artifact_not_file", "Artifact path is not a file and was skipped", relativePath));
    return false;
  }
  if (kind === "directory" && !stat.isDirectory()) {
    warnings.push(warning("artifact_not_directory", "Artifact path is not a directory and was skipped", relativePath));
    return false;
  }
  const symlinkSegment = await firstSymlinkSegment(root, artifactPath);
  if (symlinkSegment !== null) {
    warnings.push(warning("artifact_symlink", "Artifact path uses a symlinked parent and was skipped", relativeArtifactPath(root, symlinkSegment)));
    return false;
  }
  if (!await isRealPathInsideRoot(root, artifactPath)) {
    warnings.push(warning("artifact_outside_root", "Artifact path resolves outside the project root and was skipped", relativePath));
    return false;
  }
  return true;
}

export async function readArtifactDirectory(root: string, directoryPath: string, warnings: ProjectWarning[]): Promise<readonly Dirent[]> {
  const relativePath = relativeArtifactPath(root, directoryPath);
  try {
    if (!await validateArtifactPath(root, directoryPath, warnings, "directory")) return [];
    return await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      warnings.push(warning("artifact_missing", "Optional artifact directory is missing", relativePath));
      return [];
    }
    warnings.push(warning("artifact_unreadable", `Artifact directory could not be read: ${errorMessage(error)}`, relativePath));
    return [];
  }
}

export async function readSmallTextFile(root: string, artifactPath: string, warnings: ProjectWarning[]): Promise<string | null> {
  const relativePath = relativeArtifactPath(root, artifactPath);
  try {
    const stat = await fs.lstat(artifactPath);
    if (!await validateArtifactPath(root, artifactPath, warnings, "file")) return null;
    if (stat.size > PROJECT_LIMITS.maxFileBytes) {
      warnings.push(warning("artifact_oversized", "Artifact exceeds the 1 MiB parser limit and was skipped", relativePath));
      return null;
    }
    return await withFileReadSlot(() => fs.readFile(artifactPath, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      warnings.push(warning("artifact_missing", "Optional artifact file is missing", relativePath));
      return null;
    }
    warnings.push(warning("artifact_unreadable", `Artifact could not be read: ${errorMessage(error)}`, relativePath));
    return null;
  }
}
