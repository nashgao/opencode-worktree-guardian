import { loadGuardianConfig, matchesConfigPattern } from "./hygiene-config.ts";

export type HygieneSeverity = "warn" | "fail";
export type HygieneCategory = "known-cleanable" | "nested-git" | "suspicious" | "filesystem-only-empty-directory";

export function knownCleanableMatch(relative: string, repoRoot?: string) {
  if (repoRoot) {
    const config = loadGuardianConfig(repoRoot);
    if (config?.hygiene) {
      const { knownCleanable, alwaysKeep } = config.hygiene;
      if (knownCleanable && knownCleanable.length > 0 && matchesConfigPattern(relative, knownCleanable)) {
        if (alwaysKeep && alwaysKeep.length > 0 && matchesConfigPattern(relative, alwaysKeep)) return null;
        return { path: relative, reason: "matched .guardian.json knownCleanable pattern" };
      }
    }
  }

  const parts = relative.split("/").filter(Boolean);
  if (parts.length === 1 && /^[^/]+\.tsv$/i.test(parts[0] ?? "")) return { path: parts[0], reason: "generated TSV artifact" };
  if (parts[0] === "data" && /^test-wal-[^/]+$/.test(parts[1] ?? "")) return { path: `data/${parts[1]}`, reason: "known test WAL scratch artifact" };
  if (parts.length === 1 && /^[^/]+\.(png|jpg|jpeg|webp)$/i.test(parts[0] ?? "")) return { path: parts[0], reason: "root-level image artifact" };
  for (const [index, part] of parts.entries()) {
    const artifactPath = parts.slice(0, index + 1).join("/");
    if (part === "node-compile-cache") return { path: artifactPath, reason: "generated Node compile cache" };
    if (/^node-compile-cache-coverage-run-[^/]+$/.test(part)) return { path: artifactPath, reason: "generated Node compile cache coverage run" };
    if (/^node-coverage-[^/]+$/.test(part)) return { path: artifactPath, reason: "generated Node coverage cache" };
    if (/^go-build[^/]*$/.test(part)) return { path: artifactPath, reason: "generated Go build cache" };
    if (/^space-shadow-[^/]+$/.test(part)) return { path: artifactPath, reason: "generated guarded shadow workspace" };
    if (/^TestRunGuardedShadowSnapshot_[^/]+$/.test(part)) return { path: artifactPath, reason: "generated guarded shadow snapshot" };
    if (/^tsx-\d+$/.test(part)) return { path: artifactPath, reason: "generated tsx runtime cache" };
    if (/^librarian-[^/]+$/.test(part)) return { path: artifactPath, reason: "known librarian scratch artifact" };
    if (/^[^/]+-librarian$/.test(part)) return { path: artifactPath, reason: "known librarian scratch artifact" };
    if (/^hyperf-[^/]+$/.test(part)) return { path: artifactPath, reason: "known Hyperf scratch artifact" };
    if (part === "test-phpkafka") return { path: artifactPath, reason: "known phpkafka test scratch artifact" };
    if (part === "test-hyperf-kafka") return { path: artifactPath, reason: "known Hyperf Kafka test scratch artifact" };
    if (part === "jest_dx") return { path: artifactPath, reason: "Jest transform cache" };
    if (/^v8-compile-cache-\d+$/.test(part)) return { path: artifactPath, reason: "V8 compile cache" };
    if (/^playwright-transform-cache-\d+$/.test(part)) return { path: artifactPath, reason: "Playwright transform cache" };
    if (part === "dist-types") return { path: artifactPath, reason: "TypeScript declaration output" };
    if (part === ".playwright-mcp") return { path: artifactPath, reason: "Playwright MCP session artifacts" };
    if (/^xfs-[0-9a-f]+$/.test(part)) return { path: artifactPath, reason: "ephemeral session temp file" };
    if (part === ".previews") return { path: artifactPath, reason: "preview image artifacts" };
    if (part === "e2e-test-report") return { path: artifactPath, reason: "stale e2e test report" };
    if (part === "core-js-banners") return { path: artifactPath, reason: "npm install artifact" };
  }
  return null;
}
