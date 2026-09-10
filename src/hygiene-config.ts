import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { z } from "zod";
import { errorCode } from "./types.ts";

const GuardianHygieneConfigSchema = z.object({
  knownCleanable: z.array(z.string().min(1)).readonly().optional(),
  alwaysKeep: z.array(z.string().min(1)).readonly().optional(),
}).strict().readonly();

const GuardianConfigSchema = z.object({ hygiene: GuardianHygieneConfigSchema.optional() }).strict().readonly();

export type GuardianHygieneConfig = z.infer<typeof GuardianHygieneConfigSchema>;
export type GuardianConfig = z.infer<typeof GuardianConfigSchema>;

export class GuardianHygieneConfigError extends Error {
  override readonly name = "GuardianHygieneConfigError";
  readonly configPath: string;

  constructor(configPath: string, cause: unknown) {
    super(`invalid or unreadable hygiene config ${configPath}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.configPath = configPath;
  }
}

export function loadGuardianConfig(repoRoot: string): GuardianConfig | null {
  const configPath = path.join(repoRoot, ".guardian.json");
  try {
    if (lstatSync(configPath).isSymbolicLink()) throw new GuardianHygieneConfigError(configPath, "symbolic links are not accepted");
    const content = readFileSync(configPath, "utf8");
    return GuardianConfigSchema.parse(JSON.parse(content));
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return null;
    if (error instanceof GuardianHygieneConfigError) throw error;
    throw new GuardianHygieneConfigError(configPath, error);
  }
}

export function matchesConfigPattern(relative: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => picomatch.isMatch(relative, pattern, { dot: true }));
}
