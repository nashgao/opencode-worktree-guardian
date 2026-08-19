import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { OPERATIONS_CENTER_CONTROLLER } from "../src/operations-center/controller.ts";
import { actionGuidance } from "../src/operations-center/guidance.ts";
import { guardianRecover, guardianStatus } from "../src/recover.ts";
import { REPORT_CSS } from "../src/report-css.ts";
import { guardianReportHtml, renderGuardianReportHtml } from "../src/report.ts";
import { getGuardianPaths } from "../src/state.ts";
import { createRepo, seedSession } from "./helpers.ts";

async function reportFixture() {
  const repo = await createRepo();
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const recover = await guardianRecover({ repoRoot: repo, config: DEFAULT_CONFIG });
  return { repo, status, recover };
}

function reportHtml(input: Awaited<ReturnType<typeof reportFixture>>) {
  return renderGuardianReportHtml({ reportPath: path.join(input.repo, ".git", "opencode-guardian", "report.html"), generatedAt: "2026-08-13T12:00:00.000Z", status: input.status, recover: input.recover });
}

function hash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("base64");
}

function escapedAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/=/g, "&#61;");
}

function inertPayload(html: string) {
  const payload = html.match(/<script type="application\/json" id="guardian-report-data">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(payload);
  return JSON.parse(payload);
}

function withoutInertPayload(html: string) {
  return html.replace(/<script type="application\/json" id="guardian-report-data">[\s\S]*?<\/script>/, "");
}

test("Given typed Guardian results, when rendering the report, then it provides the Operations Center shell and preserved evidence", async (t) => {
  // Given
  const fixture = await reportFixture();
  t.after(() => fs.rm(fixture.repo, { recursive: true, force: true }));

  // When
  const html = reportHtml(fixture);

  // Then
  assert.match(html, /<h1>Guardian Operations Center<\/h1>/);
  assert.match(html, /href="#main-content">Skip to report/);
  for (const tab of ["operations", "topology", "evidence", "raw-data"]) assert.match(html, new RegExp(`id="tab-${tab}"[\\s\\S]*aria-controls="panel-${tab}"`));
  for (const tab of ["operations", "topology", "evidence", "raw-data"]) assert.match(html, new RegExp(`id="panel-${tab}" role="tabpanel" aria-labelledby="tab-${tab}"`));
  for (const heading of ["Sessions", "Worktrees", "Branch Coverage", "Orphaned Sessions", "Worktrees Without State", "Dirty Files", "Stashes", "Workspace Hygiene", "Safety Refs", "Recovery Candidates", "Recovery Guidance", "Raw Guardian JSON"]) assert.match(html, new RegExp(heading));
  for (const mode of ["metro", "radar", "timeline", "gittree", "sunburst", "swimlanes", "terminal"]) assert.match(html, new RegExp(`id="topology-mode-${mode}"`));
  for (const mode of ["metro", "radar", "timeline", "gittree", "sunburst", "swimlanes", "terminal"]) assert.match(html, new RegExp(`data-topology-mode="${mode}"`));
  for (const action of ["add", "sync", "fetch", "pull", "switch", "open", "terminal", "remove"]) assert.match(html, new RegExp(`data-action="${action}"`));
  const payload = inertPayload(html);
  for (const selection of [payload.guidance.fallback, ...payload.guidance.worktrees]) {
    assert.deepEqual(selection.actions, payload.model.actions.map((action: { readonly id: Parameters<typeof actionGuidance>[0]["id"] }) => actionGuidance({ id: action.id, path: selection.path })));
  }
});

test("Given reviewable workspace files, when querying Guardian status and recovery, then report inputs retain shared hygiene metadata", async (t) => {
  // Given
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "ordinary.txt"), "reviewable\n");

  // When
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const recover = await guardianRecover({ repoRoot: repo, config: DEFAULT_CONFIG });

  // Then
  assert.equal(status.hygiene.reviewableCandidates.length, 1);
  assert.equal(status.hygiene.reviewableCandidates[0]?.path, "ordinary.txt");
  assert.deepEqual(recover.hygiene.reviewableCandidates, status.hygiene.reviewableCandidates);
  assert.deepEqual(recover.hygiene.summary, status.hygiene.summary);
});

test("Given hostile typed Guardian data, when embedding the model payload, then it remains inert and parseable", async (t) => {
  // Given
  const fixture = await reportFixture();
  t.after(() => fs.rm(fixture.repo, { recursive: true, force: true }));
  const malicious = "</script><img src=x onerror=alert(1)>";
  const status = { ...fixture.status, repoRoot: malicious };

  // When
  const html = renderGuardianReportHtml({ reportPath: malicious, generatedAt: "2026-08-13T12:00:00.000Z", status, recover: fixture.recover });
  const payload = html.match(/<script type="application\/json" id="guardian-report-data">([\s\S]*?)<\/script>/)?.[1];

  // Then
  assert.ok(payload);
  assert.doesNotMatch(payload, /<\/script/i);
  assert.match(payload, /\\u003c\/script\\u003e/);
  assert.equal(JSON.parse(payload).model.identity.repoRoot, malicious);
  assert.equal((html.match(/<script\b/gi) ?? []).length, 2);
});

test("Given hostile evidence values, when rendering the server evidence view, then it escapes markup without injecting elements or attributes", async (t) => {
  // Given
  const fixture = await reportFixture();
  t.after(() => fs.rm(fixture.repo, { recursive: true, force: true }));
  const hostile = "</script><img src=x onerror=alert(1)>";
  const status = {
    ...fixture.status,
    sessions: [{ session_id: hostile, status: "active" as const, branch: hostile, worktree_path: hostile, head_commit: "abc123def456" }],
    worktrees: [{ path: hostile, branch: hostile, head: "abc123def456" }],
  };

  // When
  const html = renderGuardianReportHtml({ reportPath: "report.html", generatedAt: "2026-08-13T12:00:00.000Z", status, recover: fixture.recover });

  // Then
  assert.match(html, /&lt;\/script&gt;&lt;img src&#61;x onerror&#61;alert\(1\)&gt;/);
  assert.equal((html.match(/<img\b/gi) ?? []).length, 0);
  assert.equal((withoutInertPayload(html).match(/\sonerror\s*=/gi) ?? []).length, 0);
  assert.equal((html.match(/<script\b/gi) ?? []).length, 2);
});

test("Given cached base authority and operational scope facts, when rendering evidence, then it presents the supplied facts as escaped read-only evidence", async (t) => {
  // Given
  const fixture = await reportFixture();
  t.after(() => fs.rm(fixture.repo, { recursive: true, force: true }));
  const hostileRemote = "trusted</code><img src=x onerror=alert(1)>";
  const status = {
    ...fixture.status,
    baseAuthority: {
      status: "available" as const,
      baseRef: "trusted/main",
      baseAuthorityRef: "refs/remotes/trusted/main",
      baseRefOid: "abcdef123456",
      effectiveRemote: hostileRemote,
      source: "upstream" as const,
    },
    operationalScope: {
      effectiveRemote: hostileRemote,
      unexaminedSecondaryRemotes: ["mirror", "archive<script>alert(1)</script>"],
      localBranchCount: 4,
      effectiveRemoteBranchCount: 7,
      freshness: "cached-read-only" as const,
    },
  };

  // When
  const html = renderGuardianReportHtml({ reportPath: "report.html", generatedAt: "2026-08-13T12:00:00.000Z", status, recover: fixture.recover });

  // Then
  assert.match(html, /<h2 id="base-authority-heading">Base Authority<\/h2>/);
  assert.match(html, /trusted\/main/);
  assert.match(html, /refs\/remotes\/trusted\/main/);
  assert.match(html, /abcdef123456/);
  assert.match(html, /<h2 id="operational-scope-heading">Operational Scope<\/h2>/);
  assert.match(html, /<th scope="row">Freshness<\/th><td data-label="Freshness">cached\/read-only<\/td>/);
  assert.match(html, /<th scope="row">Local Branches<\/th><td data-label="Local Branches">4<\/td>/);
  assert.match(html, /<th scope="row">Effective Remote Branches<\/th><td data-label="Effective Remote Branches">7<\/td>/);
  assert.match(html, /Unscanned Secondary Remotes/);
  assert.match(html, /trusted&lt;\/code&gt;&lt;img src&#61;x onerror&#61;alert\(1\)&gt;/);
  assert.match(html, /archive&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal((withoutInertPayload(html).match(/<img\b/gi) ?? []).length, 0);
  assert.equal((withoutInertPayload(html).match(/<script\b/gi) ?? []).length, 1);
});

test("Given contextual Guardian evidence, when rendering, then it retains orphan, safety-ref, recovery, hygiene, and reviewable evidence", async (t) => {
  // Given
  const fixture = await reportFixture();
  t.after(() => fs.rm(fixture.repo, { recursive: true, force: true }));
  const orphan = { session_id: "ses_missing", status: "active" as const, branch: "guardian/missing", worktree_path: "missing-worktree", reason: "worktree path is missing" };
  const status = {
    ...fixture.status,
    orphanedSessions: [orphan],
    safetyRefs: [{ name: "refs/opencode-guardian/safety/example", commit: "123456789abc", date: "2026-08-13", subject: "safety" }],
    hygiene: { ...fixture.status.hygiene, summary: { ...fixture.status.hygiene.summary, candidateCount: 7, findingCount: 1, reviewableCandidateCount: 1, reviewableShownCount: 1, reviewableOmittedCount: 0, reviewableTotalFileCount: 1, reviewableTruncated: false, bySeverity: { warn: 1, fail: 0 }, byCategory: { "known-cleanable": 1, "nested-git": 0, suspicious: 0 } }, findings: [{ path: "research-clone", category: "known-cleanable", severity: "warn", reason: "known librarian scratch artifact" }], reviewableCandidates: [{ path: "reviewable.txt", status: "untracked" as const, fileCount: 1, reason: "review before deleting", source: "git ls-files", suggestedDeletePathCommand: "guardian_delete_paths mode=plan paths=[\"reviewable.txt\"]" }] },
  };
  const recover = { ...fixture.recover, recoveryCandidates: { reflog: [{ selector: "HEAD@{1}", commit: "abcdef123456", subject: "lost work" }], unreachable: ["def456789abc"] } };

  // When
  const html = renderGuardianReportHtml({ reportPath: "report.html", generatedAt: "2026-08-13T12:00:00.000Z", status, recover });

  // Then
  assert.match(html, /missing-worktree<\/code> on branch <code>guardian\/missing<\/code> for <code>ses_missing<\/code> — worktree path is missing/);
  assert.match(html, /refs\/opencode-guardian\/safety\/example<\/code> at <code>123456789abc<\/code> — safety/);
  assert.match(html, /Reflog <code>HEAD@\{1\}<\/code> at <code>abcdef123456<\/code> — lost work/);
  assert.match(html, /Unreachable <code>def456789abc<\/code>/);
  assert.match(html, /Candidate Paths/);
  assert.match(html, /research-clone/);
  assert.match(html, /Reviewable Candidates/);
  assert.match(html, /reviewable.txt/);
  assert.match(html, /<span>Risks<\/span><strong>[1-9]\d*<\/strong>/);
});

test("Given good and blocked Guardian results, when rendering, then it exposes semantic verdict pills", async (t) => {
  // Given
  const fixture = await reportFixture();
  t.after(() => fs.rm(fixture.repo, { recursive: true, force: true }));
  const good = { ...fixture.status, activeSessions: [{ session_id: "ses_ready", status: "active" as const, branch: "guardian/ready" }], sessions: [], worktrees: [], orphanedSessions: [], poisonedSessions: [], dirtyFiles: [], stashes: [], safetyRefs: [] };
  const blocked = { ...good, ok: false, reason: "guardian status failed" };

  // When
  const goodHtml = renderGuardianReportHtml({ reportPath: "report.html", generatedAt: "2026-08-13T12:00:00.000Z", status: good, recover: fixture.recover });
  const blockedHtml = renderGuardianReportHtml({ reportPath: "report.html", generatedAt: "2026-08-13T12:00:00.000Z", status: blocked, recover: fixture.recover });

  // Then
  assert.match(goodHtml, /<span class="status-pill good">Ready<\/span>/);
  assert.match(blockedHtml, /<span class="status-pill bad">Blocked<\/span>/);
});

test("Given raw recovery commands, when rendering, then they occur only in inert payload while Raw Data is controller-populated", async (t) => {
  // Given
  const fixture = await reportFixture();
  t.after(() => fs.rm(fixture.repo, { recursive: true, force: true }));
  const rawCommand = "git worktree remove /tmp/x";
  const recover = { ...fixture.recover, suggestedCommands: [rawCommand] };

  // When
  const html = renderGuardianReportHtml({ reportPath: "report.html", generatedAt: "2026-08-13T12:00:00.000Z", status: fixture.status, recover });

  // Then
  assert.doesNotMatch(withoutInertPayload(html), new RegExp(rawCommand));
  assert.equal(inertPayload(html).model.raw.recover.suggestedCommands[0], rawCommand);
  assert.match(html, /<pre id="raw-json"><\/pre>/);
});

test("Given the fixed inline assets, when rendering CSP, then hashes authorize exactly one style and controller", async (t) => {
  // Given
  const fixture = await reportFixture();
  t.after(() => fs.rm(fixture.repo, { recursive: true, force: true }));

  // When
  const html = reportHtml(fixture);

  // Then
  assert.ok(html.includes(`script-src ${escapedAttribute(`'sha256-${hash(OPERATIONS_CENTER_CONTROLLER)}'`)}`));
  assert.ok(html.includes(`style-src ${escapedAttribute(`'sha256-${hash(REPORT_CSS)}'`)}`));
  for (const directive of ["default-src", "base-uri", "connect-src", "font-src", "form-action", "frame-src", "img-src", "media-src", "object-src"]) assert.match(html, new RegExp(`${directive} &#39;none&#39;`));
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval|https?:\/\//i);
  assert.equal((html.match(/<style>/g) ?? []).length, 1);
  assert.equal((html.match(/<script>([\s\S]*?)<\/script>/g) ?? []).length, 1);
});

test("Given the controller source, when reviewing DOM safety, then it has no unsafe sinks or network APIs", () => {
  // Then
  for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "Function(", "fetch(", "XMLHttpRequest", "WebSocket", "import("]) assert.doesNotMatch(OPERATIONS_CENTER_CONTROLLER, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const required of ["textContent", "createElement", "setAttribute", "append"]) assert.match(OPERATIONS_CENTER_CONTROLLER, new RegExp(required));
});

test("Given the Operations Center sources, when auditing responsive accessibility contracts, then focus, records, and reduced motion remain explicit", () => {
  // Then
  for (const token of [".operations-row-owner::before", "#operations-list:focus-visible", ".topology-stage:focus-visible", ".topology-card button:focus-visible", ".topology-terminal-table", ".topology-terminal-action", ".topology-alternative", "#panel-evidence .table-shell", "prefers-reduced-motion", "overflow-x: clip", ".topology-stage svg", ".topology-terminal-table th", "@media (min-width: 721px) and (max-width: 900px)", "@media (max-width: 900px)", "@media (max-width: 420px)"]) assert.match(REPORT_CSS, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(REPORT_CSS, /#operations-list:focus-visible, \.topology-stage:focus-visible \{ outline: 2px solid var\(--accent\); outline-offset: 3px; \}/);
  assert.doesNotMatch(REPORT_CSS, /min-width: 620px/);
  for (const forbidden of [".operations-row-owner { display: none"] ) assert.doesNotMatch(REPORT_CSS, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Given the Open Design control-room authority, when auditing selection and title CSS, then selection remains neutral while focus remains accented", () => {
  // Then
  assert.match(REPORT_CSS, /h1 \{[^}]*font: 650 clamp\(2\.5rem, 6vw, 4\.5rem\)\/\.95 var\(--font-display\);/);
  assert.doesNotMatch(REPORT_CSS, /@media \(max-width: 720px\) \{[^}]*h1 \{[^}]*font-size:/);
  assert.match(REPORT_CSS, /\.tabs button\[aria-selected="true"\] \{ border-color: var\(--border\); color: var\(--fg\); background: var\(--surface-raised\); \}/);
  assert.match(REPORT_CSS, /\.operations-filter\.active, \.operations-view-toggle button\[aria-pressed="true"\] \{ color: var\(--fg\); border-color: var\(--border\); background: var\(--surface-raised\); \}/);
  assert.match(REPORT_CSS, /#topology-mode-selector button\[aria-checked="true"\] \{ border-color: var\(--border\); color: var\(--fg\); background: var\(--surface-raised\); \}/);
  assert.match(REPORT_CSS, /\.topology-terminal-action\[aria-pressed="true"\] \{ border-color: var\(--border\); color: var\(--fg\); background: var\(--surface-raised\); \}/);
  assert.match(REPORT_CSS, /\.operations-row:hover, \.operations-row\[aria-selected="true"\] \{ background: var\(--surface-raised\); \}/);
  assert.match(REPORT_CSS, /\.operations-graph-node\.selected circle \{ fill: var\(--surface-raised\); stroke: var\(--fg\); stroke-width: 4; \}/);
  assert.match(REPORT_CSS, /\.topology-node\.selected \{ fill: var\(--surface-raised\); stroke: var\(--fg\); stroke-width: 4; \}/);
  assert.doesNotMatch(REPORT_CSS, /\.tabs button\[aria-selected="true"\] \{[^}]*var\(--accent\)/);
  assert.doesNotMatch(REPORT_CSS, /\.operations-filter\.active, \.operations-view-toggle button\[aria-pressed="true"\] \{[^}]*var\(--accent\)/);
});

test("Given long repository values, when auditing desktop table layout, then scrolling preserves readable columns without changing mobile record cards", () => {
  // Then
  for (const token of [".table-shell { width: 100%; min-width: 0; overflow-x: auto;", "table { width: max-content; min-width: 100%; border-collapse: collapse; table-layout: auto;", ".topology-terminal-table { min-width: 58rem;", ".topology-event-table { min-width: 38rem;", "@media (max-width: 900px)", ".topology-terminal-table, .topology-event-table { min-width: 0; width: 100%; table-layout: fixed; }", ".table-shell { max-height: 32rem; overflow: auto;"]) assert.match(REPORT_CSS, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(REPORT_CSS, /\.topology-terminal-table td, \.topology-event-table td \{[^}]*display: grid;[^}]*overflow-wrap: anywhere;/);
   assert.match(REPORT_CSS, /\.topology-stage \{ min-width: 0; min-height: 21rem; max-height: 32rem; overflow: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;/);
   assert.match(REPORT_CSS, /\.topology-stage \.topology-drawing \{ min-width: 50rem; width: 50rem; \}/);
  assert.match(REPORT_CSS, /\.topology-card, #topology-mode-selector, \.topology-stage, \.topology-alternative \{ min-width: 0; max-width: 100%; \}/);
  assert.match(REPORT_CSS, /\.topology-alternative \{[^}]*max-height: 32rem;[^}]*overflow: auto;[^}]*overscroll-behavior-inline: contain;/);
  assert.match(REPORT_CSS, /\.topology-graphic \{ min-width: 0; max-width: 100%; width: 100%; overflow: hidden;/);
   assert.match(REPORT_CSS, /@media \(max-width: 420px\) \{ \.topology-stage \{ min-height: 0; \}/);
  assert.match(REPORT_CSS, /#topology-mode-selector \{ display: flex; flex-wrap: nowrap; gap: var\(--space-2\); overflow-x: auto;/);
  assert.match(REPORT_CSS, /#topology-mode-selector button \{ flex: 0 0 auto; scroll-margin-inline: var\(--space-2\); white-space: nowrap; \}/);
  assert.match(REPORT_CSS, /\.topology-stage-terminal \{ max-height: 32rem; overflow: auto;/);
});

test("Given a Guardian session, when writing the report, then it preserves atomic report integration and emits the Operations Center", async (t) => {
  // Given
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await seedSession(repo, { session_id: "ses_report", status: "active", branch: "guardian/report", worktree_path: repo, base_ref: "origin/main", head_commit: "abc123def456", safety_refs: [] });

  // When
  const result = await guardianReportHtml({ repoRoot: repo, config: DEFAULT_CONFIG });
  const paths = await getGuardianPaths(repo);
  const html = await fs.readFile(paths.reportPath, "utf8");

  // Then
  assert.equal(result.ok, true);
  assert.equal(result.reportPath, paths.reportPath);
  assert.match(html, /Guardian Operations Center/);
  assert.match(html, /ses_report/);
  assert.match(html, /guardian\/report/);
});
