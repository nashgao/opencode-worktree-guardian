type ProtectedPathMatch = {
  readonly path: string;
  readonly reason: string;
};

const HARD_DENY_PROTECTED_PATHS = [".beads"] as const;

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
  const paths: string[] = [...HARD_DENY_PROTECTED_PATHS];
  for (const value of values) {
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
    reason: `configured protected path ${protectedPath}`,
  };
}
