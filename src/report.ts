import { guardianRecover, guardianStatus } from "./recover.ts";
import { getGuardianPaths, writeReportAtomic } from "./state.ts";

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/=/g, "&#61;");
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textValue(value: unknown, fallback = "-") {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function shortCommit(value: unknown) {
  const text = textValue(value);
  return text === "-" ? text : text.slice(0, 12);
}

function metric(label: string, value: number, tone = "") {
  return `<article class="metric ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;
}

function emptyRow(columns: number, message: string) {
  return `<tr><td colspan="${columns}" class="empty">${escapeHtml(message)}</td></tr>`;
}

function sessionsTable(sessions: unknown[]) {
  const rows = sessions.map((entry) => {
    const session = recordValue(entry);
    return `<tr><td>${escapeHtml(session.session_id ?? session.sessionId)}</td><td>${escapeHtml(session.status)}</td><td>${escapeHtml(session.branch)}</td><td>${escapeHtml(session.worktree_path ?? session.worktreePath)}</td><td>${escapeHtml(shortCommit(session.head_commit ?? session.headCommit))}</td></tr>`;
  }).join("") || emptyRow(5, "No guardian sessions recorded.");
  return `<table><thead><tr><th>Session</th><th>Status</th><th>Branch</th><th>Worktree</th><th>Head</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function worktreesTable(worktrees: unknown[]) {
  const rows = worktrees.map((entry) => {
    const worktree = recordValue(entry);
    const markers = [worktree.detached === true ? "detached" : "", worktree.bare === true ? "bare" : ""].filter(Boolean).join(", ");
    return `<tr><td>${escapeHtml(worktree.branch)}</td><td>${escapeHtml(worktree.path)}</td><td>${escapeHtml(shortCommit(worktree.head ?? worktree.head_commit ?? worktree.headCommit))}</td><td>${escapeHtml(markers || "clean")}</td></tr>`;
  }).join("") || emptyRow(4, "No git worktrees found.");
  return `<table><thead><tr><th>Branch</th><th>Path</th><th>Head</th><th>Markers</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function branchesTable(branches: unknown[]) {
  const rows = branches.map((entry) => {
    const branch = recordValue(entry);
    return `<tr><td>${escapeHtml(branch.name ?? entry)}</td><td>${escapeHtml(shortCommit(branch.commit ?? branch.head))}</td></tr>`;
  }).join("") || emptyRow(2, "Every listed branch has a worktree.");
  return `<table><thead><tr><th>Branch Without Worktree</th><th>Commit</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function listSection(title: string, entries: unknown[], tone: "risk" | "info") {
  const items = entries.map((entry) => `<li><code>${escapeHtml(describeEntry(entry))}</code></li>`).join("") || `<li class="empty">${escapeHtml(tone === "risk" ? "No risks detected." : "Nothing to show.")}</li>`;
  return `<section class="card ${tone}"><h2>${escapeHtml(title)}</h2><ul>${items}</ul></section>`;
}

function describeEntry(entry: unknown) {
  const item = recordValue(entry);
  return textValue(item.session_id ?? item.sessionId ?? item.branch ?? item.path ?? item.worktree_path ?? item.name ?? item.ref ?? item.command ?? entry, JSON.stringify(entry));
}

function commandSection(commands: unknown[]) {
  const items = commands.map((command) => `<li><code>${escapeHtml(command)}</code></li>`).join("") || `<li class="empty">No recovery commands suggested.</li>`;
  return `<section class="card command-bank"><h2>Recovery Commands</h2><p>Read-only suggestions. Review before running anything mutating.</p><ul>${items}</ul></section>`;
}

function styles() {
  return `:root{--bg:#080b0d;--panel:#11181c;--panel-2:#172126;--line:#31444c;--text:#e4efe9;--muted:#92a49f;--good:#7ddf9a;--warn:#ffbe5c;--bad:#ff6b5e;--accent:#8fd6ff;--shadow:0 24px 80px rgba(0,0,0,.42);--radius:18px;--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-6:24px;--space-8:32px}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 0%,#17303a 0,#080b0d 34%),linear-gradient(135deg,#080b0d,#121618);color:var(--text);font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}body:before{content:"";position:fixed;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(255,255,255,.025),rgba(255,255,255,.025) 1px,transparent 1px,transparent 6px)}header,main{width:min(1180px,calc(100% - 32px));margin:0 auto}header{padding:var(--space-8) 0 var(--space-6)}.eyebrow{color:var(--accent);letter-spacing:.18em;text-transform:uppercase;font-size:12px}h1{font-size:clamp(32px,6vw,72px);line-height:.9;margin:var(--space-3) 0;font-weight:900;letter-spacing:-.08em}h2{margin:0 0 var(--space-4);font-size:18px;text-transform:uppercase;letter-spacing:.08em}.timestamp{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:var(--space-4);margin-bottom:var(--space-4)}.card,.metric{background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.015));border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}.card{grid-column:span 12;padding:var(--space-6);overflow:hidden}.half{grid-column:span 6}.third{grid-column:span 4}.metric{padding:var(--space-4);min-height:96px}.metric span{display:block;color:var(--muted);text-transform:uppercase;font-size:12px;letter-spacing:.1em}.metric strong{display:block;font-size:34px;line-height:1.1}.metric.good strong{color:var(--good)}.metric.warn strong{color:var(--warn)}.metric.bad strong{color:var(--bad)}table{width:100%;border-collapse:collapse;overflow:hidden}th,td{padding:var(--space-3);border-bottom:1px solid rgba(255,255,255,.08);text-align:left;vertical-align:top}th{color:var(--accent);font-size:12px;text-transform:uppercase;letter-spacing:.08em;background:rgba(143,214,255,.06)}td{color:var(--text);word-break:break-word}.empty{color:var(--muted)}ul{margin:0;padding-left:var(--space-6)}li{margin:var(--space-2) 0}code,pre{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:#d7ffea}code{background:rgba(125,223,154,.08);padding:2px 6px;border-radius:8px}pre{white-space:pre-wrap;word-break:break-word;margin:var(--space-4) 0 0;max-height:520px;overflow:auto}.risk{border-color:rgba(255,190,92,.45)}.command-bank{border-color:rgba(143,214,255,.35)}details summary{cursor:pointer;color:var(--accent);font-weight:700}@media(max-width:800px){.half,.third{grid-column:span 12}header,main{width:min(100% - 20px,1180px)}th,td{padding:var(--space-2)}}`;
}

export function renderGuardianReportHtml(input: { reportPath: string; generatedAt: string; status: Record<string, unknown>; recover: Record<string, unknown> }) {
  const { reportPath, generatedAt, status, recover } = input;
  const sessions = arrayValue(status.sessions);
  const worktrees = arrayValue(status.worktrees);
  const orphanedSessions = arrayValue(status.orphanedSessions);
  const worktreesWithoutState = arrayValue(status.worktreesWithoutState);
  const dirtyFiles = arrayValue(status.dirtyFiles);
  const stashes = arrayValue(status.stashes);
  const safetyRefs = arrayValue(status.safetyRefs);
  const recoveryCandidates = arrayValue(recover.recoveryCandidates);
  const riskCount = orphanedSessions.length + worktreesWithoutState.length + dirtyFiles.length + stashes.length;
  const rawJson = JSON.stringify({ reportPath, generatedAt, status, recover }, null, 2);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(CSP)}"><title>Guardian Control Report</title><style>${styles()}</style></head><body><header><div class="eyebrow">OpenCode Worktree Guardian</div><h1>Control Report</h1><p class="timestamp">Generated ${escapeHtml(generatedAt)} for <code>${escapeHtml(status.repoRoot)}</code></p><p class="timestamp">Offline file: <code>${escapeHtml(reportPath)}</code></p></header><main><section class="grid" aria-label="Guardian summary metrics">${metric("Sessions", sessions.length, sessions.length > 0 ? "good" : "")}${metric("Worktrees", worktrees.length, worktrees.length > 0 ? "good" : "")}${metric("Risks", riskCount, riskCount > 0 ? "warn" : "good")}${metric("Safety Refs", safetyRefs.length, safetyRefs.length > 0 ? "warn" : "")}${metric("Recovery Candidates", recoveryCandidates.length, recoveryCandidates.length > 0 ? "warn" : "good")}${metric("Dirty Files", dirtyFiles.length, dirtyFiles.length > 0 ? "bad" : "good")}</section><section class="grid"><section class="card"><h2>Sessions</h2>${sessionsTable(sessions)}</section><section class="card"><h2>Worktrees</h2>${worktreesTable(worktrees)}</section><section class="card half"><h2>Branch Coverage</h2>${branchesTable(arrayValue(status.branchesWithoutWorktrees))}</section>${listSection("Orphaned Sessions", orphanedSessions, "risk")}${listSection("Worktrees Without State", worktreesWithoutState, "risk")}${listSection("Dirty Files", dirtyFiles, "risk")}${listSection("Stashes", stashes, "risk")}${listSection("Safety Refs", safetyRefs, "info")}${listSection("Recovery Candidates", recoveryCandidates, "info")}${commandSection(arrayValue(recover.suggestedCommands))}<section class="card"><h2>Raw Guardian JSON</h2><details><summary>Open raw status and recovery metadata</summary><pre>${escapeHtml(rawJson)}</pre></details></section></section></main></body></html>\n`;
}

export async function guardianReportHtml(input: Record<string, any> = {}) {
  const status = await guardianStatus(input);
  const recover = await guardianRecover(input);
  const paths = await getGuardianPaths(String(status.repoRoot));
  const generatedAt = new Date().toISOString();
  const html = renderGuardianReportHtml({ reportPath: paths.reportPath, generatedAt, status, recover });
  await writeReportAtomic(paths, html);
  return { ok: true, reportPath: paths.reportPath, status, recover };
}
