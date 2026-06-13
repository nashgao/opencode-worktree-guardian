import crypto from "node:crypto";
import fs from "node:fs/promises";
import { buildDeletePathsPreflight, deleteSummary } from "./delete-paths-preflight.ts";
import type { DeletePathBlocker, DeletePathTarget } from "./delete-paths-preflight.ts";

function createDeleteConfirmToken(preflight: Record<string, unknown>) {
  const material = {
    tool: "guardian_delete_paths",
    repoRoot: preflight.repoRoot,
    paths: preflight.paths,
    allowTracked: preflight.allowTracked === true,
    allowRecursive: preflight.allowRecursive === true,
    targets: (preflight.targets as DeletePathTarget[] | undefined ?? []).map((target) => ({
      path: target.path,
      kind: target.kind,
      status: target.status,
      trackedContents: target.trackedContents,
      fingerprint: target.fingerprint,
    })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

function deleteReport(result: Record<string, unknown>, preflight: Record<string, unknown>, removedTargets: DeletePathTarget[] = []) {
  return {
    ...result,
    preflight,
    report: {
      action: result.status,
      mode: preflight.mode,
      repoRoot: preflight.repoRoot,
      paths: preflight.paths,
      approvedTargets: (preflight.targets as DeletePathTarget[] | undefined ?? []).map((target) => target.path),
      removedTargets: removedTargets.map((target) => target.path),
      blockers: preflight.blockers,
      summary: result.summary,
    },
  };
}

async function removeDeleteTarget(target: DeletePathTarget) {
  await fs.rm(target.absolutePath, { recursive: target.kind === "directory", force: false });
}

export async function guardianDeletePaths(input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const mode = input.mode;
  const preflight = await buildDeletePathsPreflight(input);
  if (mode !== "plan" && mode !== "apply") {
    const blocker = { reason: "mode must be plan or apply", fatal: true };
    const blockers = [blocker];
    const summary = deleteSummary([], blockers);
    return deleteReport({ ok: false, status: "blocked", reason: blocker.reason, summary, targets: [], blockers }, { ...preflight, blockers, summary });
  }
  const targets = preflight.targets as DeletePathTarget[];
  const blockers = preflight.blockers as DeletePathBlocker[];
  const summary = preflight.summary as Record<string, unknown>;
  const fatalBlockers = blockers.filter((blocker) => blocker.fatal);
  if (fatalBlockers.length > 0 || targets.length === 0) {
    const reason = fatalBlockers.length > 0 ? "delete paths preflight has fatal blockers" : "no approved delete targets";
    return deleteReport({ ok: false, status: "blocked", reason, summary, targets, blockers }, preflight);
  }
  const confirmToken = createDeleteConfirmToken(preflight);
  if (mode === "plan") return deleteReport({ ok: true, status: "planned", confirmToken, summary, targets, blockers, suggestedCommands: ["guardian_delete_paths"] }, preflight);
  if (input.confirmDelete !== true) {
    return deleteReport({ ok: false, status: "blocked", reason: "confirmDelete=true is required for guardian_delete_paths apply", tokenMatched: false, summary, targets, blockers }, preflight);
  }
  if (input.confirmToken !== confirmToken) {
    return deleteReport({ ok: false, status: "blocked", reason: "confirm token mismatch; re-run mode=plan and apply with confirmDelete=true", tokenMatched: false, summary, targets, blockers }, preflight);
  }
  const removedTargets: DeletePathTarget[] = [];
  for (const target of targets) {
    await removeDeleteTarget(target);
    removedTargets.push(target);
  }
  const finalSummary = deleteSummary(targets, blockers, removedTargets);
  return deleteReport({ ok: true, status: "deleted", summary: finalSummary, targets, removedTargets, blockers, suggestedCommands: ["guardian_status"] }, { ...preflight, summary: finalSummary }, removedTargets);
}
