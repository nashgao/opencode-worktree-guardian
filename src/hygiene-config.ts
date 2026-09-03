import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const picomatch = require("picomatch") as { isMatch(str: string, pattern: string | string[], options?: { dot?: boolean }): boolean };

export interface GuardianHygieneConfig {
  knownCleanable?: string[];
  alwaysKeep?: string[];
}

export interface GuardianConfig {
  hygiene?: GuardianHygieneConfig;
}

const configCache = new Map<string, GuardianConfig | null>();

export function loadGuardianConfig(repoRoot: string): GuardianConfig | null {
  const cached = configCache.get(repoRoot);
  if (cached !== undefined) return cached;

  const configPath = path.join(repoRoot, ".guardian.json");
  try {
    const content = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(content) as GuardianConfig;
    configCache.set(repoRoot, parsed);
    return parsed;
  } catch (error: unknown) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code: string }).code : undefined;
    if (code !== "ENOENT") {
      process.stderr.write(`guardian: failed to parse .guardian.json: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    configCache.set(repoRoot, null);
    return null;
  }
}

export function matchesConfigPattern(relative: string, patterns: string[]): boolean {
  return picomatch.isMatch(relative, patterns, { dot: true });
}

export function clearConfigCache(): void {
  configCache.clear();
}
