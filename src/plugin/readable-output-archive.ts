import { appendBoundedList, arrayValue, recordValue, textValue } from "./readable-output-values.ts";

export function appendArchiveProof(lines: string[], preflight: Record<string, unknown>): void {
  const count = Number(preflight.archivedPathCount ?? 0);
  if (count <= 0) return;
  lines.push(`[INFO] archive-backed paths: ${count} | archivePath: ${textValue(preflight.archivePath)} | archiveSha256: ${textValue(preflight.archiveSha256)}`);
  appendBoundedList({
    lines,
    heading: "[INFO] archived path proofs",
    entries: arrayValue(preflight.archivedPathProofs),
    format: (entry) => {
      const proof = recordValue(entry);
      return `  - ${textValue(proof.kind)} ${textValue(proof.path)}`;
    },
  });
}
