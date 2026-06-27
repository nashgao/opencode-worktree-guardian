import fs from "node:fs/promises";
import path from "node:path";
import { getGuardianPaths } from "../state.ts";
import { errorCode } from "../types.ts";
import { collectProjectSnapshot } from "./snapshot.ts";
import type { CollectProjectSnapshotInput, ProjectIntelligenceProject, ProjectSnapshot, ProjectWarning } from "./types.ts";

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

type RenderProjectReportInput = {
  readonly reportPath: string;
  readonly snapshot: ProjectSnapshot;
};

export type WriteProjectReportResult = {
  readonly ok: true;
  readonly reportPath: string;
  readonly snapshot: ProjectSnapshot;
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/=/g, "&#61;");
}

function metric(label: string, value: unknown): string {
  return `<article class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;
}

function warningList(warnings: readonly ProjectWarning[]): string {
  const rows = warnings.map((warning) => `<li><code>${escapeHtml(warning.code)}</code> ${escapeHtml(warning.path ?? "-")} ${escapeHtml(warning.message)}</li>`).join("");
  return rows.length > 0 ? `<ul>${rows}</ul>` : `<p class="empty">No warnings.</p>`;
}

function projectSection(project: ProjectIntelligenceProject): string {
  const roadmapRows = project.roadmaps.map((roadmap) => `<li><strong>${escapeHtml(roadmap.title)}</strong> <code>${escapeHtml(roadmap.path)}</code> phases ${escapeHtml(roadmap.phases.length)}</li>`).join("");
  const reviewRows = project.milestoneReviews.map((review) => `<li><strong>${escapeHtml(review.title)}</strong> score ${escapeHtml(review.score ?? "-")} <code>${escapeHtml(review.path)}</code></li>`).join("");
  const planRows = project.omoPlans.map((plan) => `<li><strong>${escapeHtml(plan.title)}</strong> todos ${escapeHtml(plan.todoCount.done)}/${escapeHtml(plan.todoCount.total)} <code>${escapeHtml(plan.path)}</code></li>`).join("");
  const loopRows = project.omoLoops.map((loop) => `<li><strong>${escapeHtml(loop.loopId)}</strong> goals ${escapeHtml(loop.goals.length)} ledger ${escapeHtml(loop.ledgerEvents.length)} malformed ${escapeHtml(loop.malformedLedgerLineCount)}</li>`).join("");
  const branch = project.git.available ? `${project.git.branch ?? "detached"} ${project.git.head ?? ""}` : `not git: ${project.git.error ?? "unavailable"}`;
  return `<section class="card"><h2>${escapeHtml(project.name)}</h2><p><code>${escapeHtml(project.root)}</code></p><p>Git: ${escapeHtml(branch)}</p><h3>Roadmaps</h3><ul>${roadmapRows || `<li class="empty">None</li>`}</ul><h3>Milestone Reviews</h3><ul>${reviewRows || `<li class="empty">None</li>`}</ul><h3>Plans</h3><ul>${planRows || `<li class="empty">None</li>`}</ul><h3>ULW Loops</h3><ul>${loopRows || `<li class="empty">None</li>`}</ul><h3>Warnings</h3>${warningList(project.warnings)}</section>`;
}

function styles(): string {
  return `:root{--bg:#101312;--panel:#f7f7f4;--ink:#151716;--muted:#5f6963;--line:#cfd7d0;--accent:#255f85;--warn:#9d5b00}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}header,main{width:min(1120px,calc(100% - 32px));margin:0 auto}header{color:#f4f7f5;padding:32px 0 20px}h1{margin:0 0 8px;font-size:42px;letter-spacing:0}h2{margin:0 0 12px;color:var(--accent)}h3{margin:18px 0 8px;color:var(--muted);text-transform:uppercase;font-size:12px;letter-spacing:.08em}.grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-bottom:16px}.metric,.card{background:var(--panel);border:1px solid var(--line);border-radius:8px}.metric{padding:12px}.metric span{display:block;color:var(--muted);font-size:12px;text-transform:uppercase}.metric strong{font-size:28px}.card{padding:18px;margin-bottom:14px}.empty{color:var(--muted)}code{background:#e8ede8;border-radius:4px;padding:1px 4px}ul{margin:0;padding-left:22px}li{margin:6px 0;word-break:break-word}@media(max-width:760px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}header,main{width:min(100% - 20px,1120px)}}`;
}

export function renderProjectReportHtml(input: RenderProjectReportInput): string {
  const snapshot = input.snapshot;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(CSP)}"><title>Guardian Project Intelligence</title><style>${styles()}</style></head><body><header><p>OpenCode Worktree Guardian</p><h1>Project Intelligence</h1><p>Generated ${escapeHtml(snapshot.generatedAt)} for <code>${escapeHtml(snapshot.repoRoot)}</code></p><p>Offline file: <code>${escapeHtml(input.reportPath)}</code></p></header><main><section class="grid">${metric("Projects", snapshot.summary.projectCount)}${metric("Roadmaps", snapshot.summary.roadmapCount)}${metric("Reviews", snapshot.summary.milestoneReviewCount)}${metric("Plans", snapshot.summary.omoPlanCount)}${metric("ULW Loops", snapshot.summary.omoLoopCount)}${metric("Warnings", snapshot.summary.warningCount)}</section>${snapshot.projects.map(projectSection).join("")}<section class="card"><h2>Warnings</h2>${warningList(snapshot.warnings)}</section><section class="card"><h2>Raw Snapshot</h2><pre>${escapeHtml(JSON.stringify(snapshot, null, 2))}</pre></section></main></body></html>\n`;
}

async function assertReportTarget(pathName: string): Promise<void> {
  try {
    const stat = await fs.lstat(pathName);
    if (stat.isSymbolicLink()) throw new Error(`Refusing project report symlink: ${pathName}`);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

async function prepareReportDirectory(dir: string): Promise<void> {
  try {
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink()) throw new Error(`Refusing project report directory symlink: ${dir}`);
    if (!stat.isDirectory()) throw new Error(`Refusing project report directory because it is not a directory: ${dir}`);
    return;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  await fs.mkdir(dir, { recursive: true });
  const stat = await fs.lstat(dir);
  if (stat.isSymbolicLink()) throw new Error(`Refusing project report directory symlink: ${dir}`);
  if (!stat.isDirectory()) throw new Error(`Refusing project report directory because it is not a directory: ${dir}`);
}

export async function writeProjectReportForSnapshot(snapshot: ProjectSnapshot): Promise<WriteProjectReportResult> {
  const paths = await getGuardianPaths(snapshot.repoRoot);
  const reportPath = path.join(paths.dir, "project-report.html");
  await prepareReportDirectory(paths.dir);
  await assertReportTarget(reportPath);
  const html = renderProjectReportHtml({ reportPath, snapshot });
  const tmpPath = `${reportPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, html);
  await fs.rename(tmpPath, reportPath);
  return { ok: true, reportPath, snapshot };
}

export async function writeProjectReport(input: CollectProjectSnapshotInput = {}): Promise<WriteProjectReportResult> {
  return writeProjectReportForSnapshot(await collectProjectSnapshot(input));
}
