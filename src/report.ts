import { createHash } from "node:crypto";
import { guardianRecover, guardianStatus } from "./recover.ts";
import { OPERATIONS_CENTER_CONTROLLER } from "./operations-center/controller.ts";
import { renderEvidence, renderVerdict } from "./operations-center/evidence.ts";
import { buildOperationsCenterModel } from "./operations-center/model.ts";
import { renderOpenDesignReportBody } from "./operations-center/open-design-shell.ts";
import { buildOperationsCenterPayload } from "./operations-center/payload.ts";
import { REPORT_CSS } from "./report-css.ts";
import { getGuardianPaths, writeReportAtomic } from "./state.ts";
import type { GuardianRecoverResult, GuardianStatusResult } from "./status-result-types.ts";
import type { MutableRecord } from "./types.ts";

const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("base64");
const CSP = `default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; frame-src 'none'; img-src 'none'; media-src 'none'; object-src 'none'; script-src 'sha256-${hash(OPERATIONS_CENTER_CONTROLLER)}'; style-src 'sha256-${hash(REPORT_CSS)}'`;
const escape = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/=/g, "&#61;");
const escapedJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
const metric = (label: string, value: number, tone = "") => `<article class="metric ${tone}"><span>${escape(label)}</span><strong>${value}</strong></article>`;

export type GuardianReportInput = { readonly reportPath: string; readonly generatedAt: string; readonly status: GuardianStatusResult; readonly recover: GuardianRecoverResult };

export function renderGuardianReportHtml(input: GuardianReportInput) {
  const model = buildOperationsCenterModel(input);
  const payload = buildOperationsCenterPayload(model);
  const metrics = `${metric("Sessions", model.metrics.activeSessionCount, model.metrics.activeSessionCount > 0 ? "good" : "")}${metric("Worktrees", model.metrics.worktreeCount, "good")}${metric("Risks", model.metrics.riskCount, model.verdict.tone)}${metric("Safety Refs", input.status.safetyRefs.length)}${metric("Recovery Candidates", model.metrics.recoveryCandidateCount)}${metric("Dirty Files", model.metrics.dirtyFileCount, model.metrics.dirtyFileCount > 0 ? "bad" : "good")}`;
  const body = renderOpenDesignReportBody({
    model,
    repoRoot: input.status.repoRoot,
    generatedAt: input.generatedAt,
    reportPath: input.reportPath,
    verdictHtml: renderVerdict(model.verdict),
    metricsHtml: metrics,
    evidenceHtml: renderEvidence(input.status, input.recover),
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escape(CSP)}"><title>Worktree · Guardian Operations Center</title><style>${REPORT_CSS}</style></head><body>${body}<script type="application/json" id="guardian-report-data">${escapedJson(payload)}</script><script>${OPERATIONS_CENTER_CONTROLLER}</script></body></html>`;
}

export async function guardianReportHtml(input: MutableRecord = {}) {
  const status = await guardianStatus(input); const recover = await guardianRecover(input); const paths = await getGuardianPaths(status.repoRoot);
  await writeReportAtomic(paths, renderGuardianReportHtml({ reportPath: paths.reportPath, generatedAt: new Date().toISOString(), status, recover }));
  return { ok: true, reportPath: paths.reportPath, status, recover };
}
