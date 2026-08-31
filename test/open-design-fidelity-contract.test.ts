import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianRecover, guardianStatus } from "../src/recover.ts";
import { REPORT_CSS } from "../src/report-css.ts";
import { renderGuardianReportHtml } from "../src/report.ts";
import { createRepo } from "./helpers.ts";

test("Guardian report implements the binding Open Design dashboard and topology surfaces", async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const recover = await guardianRecover({ repoRoot: repo, config: DEFAULT_CONFIG });

  const html = renderGuardianReportHtml({
    reportPath: path.join(repo, ".git", "opencode-guardian", "report.html"),
    generatedAt: "2026-08-28T00:00:00.000Z",
    status,
    recover,
  });
  const controller = await fs.readFile(path.join(process.cwd(), "src", "operations-center", "controller.ts"), "utf8");

  for (const token of [
    "--bg: #0b0c0f",
    "--surface: #13151a",
    "--surface-2: #1a1d24",
    "--accent: #3bb273",
    "--radius-lg: 14px",
    ".app-header",
    ".app-shell",
    ".table-wrap",
    ".inspector-empty",
    ".view-toggle",
    ".topology-page",
    ".topology-wrap",
    ".topology-stage",
    ".topology-panel",
    ".inspector-header p {\n      min-width: 0;",
    "#topology-reset { width: auto; padding-inline: 8px; font-size: 12px; }",
    ".filter-chips > .visually-hidden {\n      position: static;",
    "@media (max-width: 720px) { .inspector, .inspector-backdrop { inset: 89px 0 0; } }",
    ".table-wrap table { min-width: 0; table-layout: fixed; }",
    ".table-wrap .branch-tag { display: none; }",
    ".table-wrap .operations-state { padding-inline: 6px; font-size: 10px; }",
    ".topology-page .topology-stage text { font-size: 24px; }",
  ]) assert.ok(REPORT_CSS.includes(token), `missing Open Design CSS contract: ${token}`);

  for (const fragment of [
    "class=\"app-header\"",
    "class=\"brand-mark\"",
    "class=\"repo-name\"",
    "class=\"app-shell\"",
    "class=\"table-wrap\"",
    "class=\"inspector-empty\"",
    "class=\"shortcuts-hint\"",
    "class=\"topology-page\"",
    "class=\"topology-wrap\"",
    "class=\"topology-panel\"",
  ]) assert.ok(html.includes(fragment), `missing Open Design HTML contract: ${fragment}`);

  assert.ok(controller.includes('active: "Active", terminal: "Terminal", risk: "Risk", unmanaged: "Unmanaged"'), "visible secondary filter controls need text labels");

  for (const mode of ["metro", "radar", "timeline", "gittree", "sunburst", "swimlanes", "terminal"]) {
    assert.ok(html.includes(`data-topology-mode="${mode}"`));
  }
  assert.ok(html.includes("Cached read-only evidence"));
  assert.ok(html.includes("guardian-report-data"));
});

test("the packaged plugin retains its binding Open Design authority", async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(process.cwd(), "package.json"), "utf8"));

  assert.ok(packageJson.files.includes("DESIGN.md"));
  await fs.access(path.join(process.cwd(), "DESIGN.md"));
});
