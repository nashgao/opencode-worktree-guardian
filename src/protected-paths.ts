export const DEFAULT_PROTECTED_PATHS = [".omo", ".omc", ".omx", ".sisyphus", ".milestones"] as const;

const DEFAULT_PROTECTED_PATH_SET = new Set<string>(DEFAULT_PROTECTED_PATHS);

type ProtectedPathMatch = {
  readonly path: string;
  readonly reason: string;
};

function normalizeProtectedPath(value: string) {
  const trimmed = value.trim().replaceAll("\\", "/");
  if (trimmed.length === 0 || trimmed.startsWith("/") || /^[A-Za-z]:\//.test(trimmed)) return null;
  const parts = trimmed.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) return null;
  return parts.join("/");
}

function pathContains(parent: string, child: string) {
  return child === parent || child.startsWith(`${parent}/`);
}

export function normalizeProtectedPaths(values: readonly unknown[] = []) {
  const paths: string[] = [];
  for (const value of [...DEFAULT_PROTECTED_PATHS, ...values]) {
    if (typeof value !== "string") continue;
    const normalized = normalizeProtectedPath(value);
    if (!normalized || paths.some((protectedPath) => pathContains(protectedPath, normalized))) continue;
    for (const protectedPath of [...paths]) {
      if (pathContains(normalized, protectedPath)) paths.splice(paths.indexOf(protectedPath), 1);
    }
    paths.push(normalized);
  }
  return paths;
}

export function protectedPathsFromConfig(config: Record<string, unknown>) {
  return normalizeProtectedPaths(Array.isArray(config.protectedPaths) ? config.protectedPaths : []);
}

export function protectedPathMatch(relative: string, protectedPaths: readonly string[]): ProtectedPathMatch | null {
  const normalized = normalizeProtectedPath(relative);
  if (!normalized) return null;
  const protectedPath = protectedPaths.find((candidate) => normalized === candidate || normalized.startsWith(`${candidate}/`));
  if (!protectedPath) return null;
  return {
    path: protectedPath,
    reason: DEFAULT_PROTECTED_PATH_SET.has(protectedPath) ? "local agent state directory" : `configured protected path ${protectedPath}`,
  };
}
