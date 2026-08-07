import crypto from "node:crypto";
import { captureProvenanceManifest, readProvenanceManifest } from "./provenance.ts";
import type { ExternalRecordReference, GuardianConfig, GuardianSession, RecordLike } from "./types.ts";
import { isRecordLike } from "./types.ts";

export type ProvenanceStatus = "captured" | "capture-failed" | "ineligible";

type CapturedProvenanceFields = {
  readonly lineage_id: string;
  readonly provenance_status: "captured";
  readonly quarantine_eligible: true;
  readonly provenance: { readonly manifest: ExternalRecordReference };
};

type CaptureStartProvenanceResult =
  | { readonly ok: true; readonly fields: CapturedProvenanceFields }
  | { readonly ok: false; readonly reason: string; readonly fields: { readonly provenance_status: "capture-failed"; readonly quarantine_eligible: false } };

function manifestReference(session: GuardianSession): ExternalRecordReference | null {
  if (!isRecordLike(session.provenance) || !isRecordLike(session.provenance.manifest)) return null;
  const { relativePath, digest } = session.provenance.manifest;
  return typeof relativePath === "string" && relativePath.length > 0 && typeof digest === "string" && digest.length > 0
    ? { relativePath, digest }
    : null;
}

export function isProvenanceEnabled(config: GuardianConfig | RecordLike): boolean {
  return isRecordLike(config.goal) && config.goal.quarantineSessionResidue === true;
}

export function ineligibleSessionProvenance(config: GuardianConfig | RecordLike): Partial<GuardianSession> {
  return isProvenanceEnabled(config)
    ? { provenance_status: "ineligible", quarantine_eligible: false }
    : {};
}

export async function captureStartProvenance(input: {
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly sessionId: string;
}): Promise<CaptureStartProvenanceResult> {
  const lineageId = crypto.randomUUID();
  try {
    const manifest = await captureProvenanceManifest({ ...input, lineageId, enabled: true });
    if (!manifest) return { ok: false, reason: "provenance capture returned no manifest", fields: { provenance_status: "capture-failed", quarantine_eligible: false } };
    return {
      ok: true,
      fields: {
        lineage_id: lineageId,
        provenance_status: "captured",
        quarantine_eligible: true,
        provenance: { manifest },
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason,
      fields: { provenance_status: "capture-failed", quarantine_eligible: false },
    };
  }
}

export async function verifyStartProvenance(input: {
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly sessionId: string;
  readonly session: GuardianSession;
}): Promise<string | null> {
  const status = input.session.provenance_status;
  const eligible = input.session.quarantine_eligible;
  if (status === undefined && eligible === undefined) return null;
  if (status === "ineligible" && eligible === false) return null;
  if (status === "capture-failed" && eligible === false) return "provenance capture previously failed; this session is not quarantine eligible";
  if (status !== "captured" || eligible !== true) return "provenance eligibility state is inconsistent";
  const lineageId = input.session.lineage_id;
  const reference = manifestReference(input.session);
  if (typeof lineageId !== "string" || lineageId.length === 0 || !reference) return "eligible provenance state is missing its immutable manifest identity";
  try {
    await readProvenanceManifest({ ...input, lineageId, reference });
    return null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `provenance manifest verification failed: ${reason}`;
  }
}
