import fs from "node:fs/promises";
import path from "node:path";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

export async function canonicalPath(candidate: string): Promise<string> {
  const suffix: string[] = [];
  let existing = path.resolve(candidate);
  while (true) {
    try {
      return path.join(await fs.realpath(existing), ...suffix);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
}
