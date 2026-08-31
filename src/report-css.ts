import { OPEN_DESIGN_DASHBOARD_CSS } from "./operations-center/open-design-dashboard-css.ts";
import { OPEN_DESIGN_INTEGRATION_CSS } from "./operations-center/open-design-integration-css.ts";
import { OPEN_DESIGN_TOPOLOGY_CSS } from "./operations-center/open-design-topology-css.ts";

const LEGACY_REPORT_CSS = `
:root {
  color-scheme: dark;
  --bg: #080b0d; --bg-lit: #17303a; --bg-edge: #121618;
  --surface: #11181c; --surface-raised: #172126; --surface-nested: rgba(0, 0, 0, .18);
  --surface-sheen-top: rgba(255, 255, 255, .045); --surface-sheen-bottom: rgba(255, 255, 255, .015);
  --fg: #e4efe9; --fg-code: #d7ffea; --muted: #92a49f;
  --border: #31444c; --border-soft: rgba(255, 255, 255, .08); --border-nested: rgba(255, 255, 255, .1);
  --scanline: rgba(255, 255, 255, .025); --accent: #8fd6ff; --accent-wash: rgba(143, 214, 255, .08);
  --success: #7ddf9a; --success-wash: rgba(125, 223, 154, .08);
  --warning: #ffbe5c; --warning-border: rgba(255, 190, 92, .45); --warning-wash: rgba(255, 190, 92, .07);
  --danger: #ff6b5e; --danger-border: rgba(255, 107, 94, .45); --danger-wash: rgba(255, 107, 94, .07);
  --shadow: 0 24px 80px rgba(0, 0, 0, .42); --radius-lg: 18px; --radius-md: 14px; --radius-sm: 8px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 20px; --space-6: 24px; --space-8: 32px; --space-10: 40px; --space-12: 48px;
  --font-display: "Avenir Next", "Helvetica Neue", sans-serif;
  --font-body: "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
* { box-sizing: border-box; }
body { min-width: 0; overflow-x: clip; margin: 0; background: radial-gradient(circle at 20% 0%, var(--bg-lit) 0, var(--bg) 34%), linear-gradient(135deg, var(--bg), var(--bg-edge)); color: var(--fg); font: .9375rem/1.6 var(--font-body); }
body::before { position: fixed; inset: 0; pointer-events: none; background: repeating-linear-gradient(0deg, var(--scanline), var(--scanline) 1px, transparent 1px, transparent 6px); content: ""; }
.skip-link { position: fixed; top: var(--space-3); left: var(--space-3); z-index: 2; transform: translateY(-180%); padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); background: var(--fg); color: var(--bg); font-weight: 600; text-decoration: none; }
.skip-link:focus { transform: translateY(0); }
header, main { width: min(1180px, calc(100% - 32px)); margin: 0 auto; }
header { padding: var(--space-3) 0 var(--space-2); }
.eyebrow { color: var(--accent); font: 600 .75rem/1.4 var(--font-mono); letter-spacing: .1em; text-transform: uppercase; }
.header-kicker { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
.report-label { color: var(--muted); font: 600 .75rem/1.4 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; }
h1 { max-width: 20ch; margin: var(--space-2) 0; font: 650 clamp(2.5rem, 6vw, 4.5rem)/.95 var(--font-display); letter-spacing: -.03em; text-wrap: balance; }
h2 { margin: 0 0 var(--space-4); font: 600 1.125rem/1.25 var(--font-display); letter-spacing: .08em; text-transform: uppercase; }
h3 { margin: var(--space-6) 0 var(--space-3); color: var(--muted); font: 600 .8125rem/1.4 var(--font-body); letter-spacing: .08em; text-transform: uppercase; }
p { max-width: 70ch; }
.timestamp { max-width: 90ch; margin: 0; color: var(--muted); font-size: .8125rem; overflow-wrap: anywhere; }
.tabs { display: flex; gap: var(--space-2); margin: 0 0 var(--space-4); overflow-x: auto; padding-bottom: var(--space-1); }
.tabs button { white-space: nowrap; }
button { color: inherit; font: inherit; }
.tabs button, .action-button, .guidance button { cursor: pointer; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-raised); padding: var(--space-2) var(--space-3); }
.tabs button[aria-selected="true"] { border-color: var(--border); color: var(--fg); background: var(--surface-raised); }
.tabs button:focus-visible, .action-button:focus-visible, .guidance button:focus-visible, .operations-filter:focus-visible, .operations-view-toggle button:focus-visible, .operations-search-label input:focus-visible, .operations-sort-label select:focus-visible, .topology-card button:focus-visible, .topology-terminal-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.action-grid { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.action-button { font: 600 .75rem/1.4 var(--font-mono); letter-spacing: .06em; text-transform: uppercase; }
.action-button:hover, .guidance button:hover { border-color: var(--accent); }
.guidance { margin-top: var(--space-4); padding: var(--space-4); border: 1px solid var(--border-soft); border-radius: var(--radius-md); background: var(--surface-nested); }
.guidance h3 { margin-top: 0; }
.guidance p { margin: 0 0 var(--space-3); white-space: pre-wrap; }
.topology-modes { display: flex; flex-wrap: wrap; gap: var(--space-2); padding-left: 0; list-style: none; }
.topology-modes li { margin: 0; }
.grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: var(--space-4); margin-bottom: var(--space-4); }
.card, .metric { min-width: 0; background: linear-gradient(180deg, var(--surface-sheen-top), var(--surface-sheen-bottom)); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow); }
.card { grid-column: span 12; padding: var(--space-6); overflow: hidden; }
.half, .grid > .risk, .grid > .info { grid-column: span 6; }
.metric { grid-column: span 3; min-height: 104px; padding: var(--space-4); }
.metric span, .hygiene-count span { display: block; color: var(--muted); font-size: .75rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
.metric strong { display: block; margin-top: var(--space-2); font: 600 2.125rem/1.1 var(--font-mono); font-variant-numeric: tabular-nums; }
.metric.good strong, .hygiene-count.good strong { color: var(--success); }
.metric.warn strong, .hygiene-count.warn strong { color: var(--warning); }
.metric.bad strong, .hygiene-count.bad strong, .hygiene-alert { color: var(--danger); }
.status-pill.good { color: var(--success); }
.status-pill.warn { color: var(--warning); }
.status-pill.bad { color: var(--danger); }
.verdict { display: grid; gap: var(--space-2); padding-block: var(--space-8); border: 1px solid var(--border); }
.verdict.good { border-color: var(--success); background: linear-gradient(180deg, var(--success-wash), var(--surface-sheen-bottom)); }
.verdict.warn { border-color: var(--warning-border); background: linear-gradient(180deg, var(--warning-wash), var(--surface-sheen-bottom)); }
.verdict.bad { border-color: var(--danger-border); background: linear-gradient(180deg, var(--danger-wash), var(--surface-sheen-bottom)); }
.verdict-tone { font: 700 .75rem/1.4 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; }
.verdict.good .verdict-tone { color: var(--success); } .verdict.warn .verdict-tone { color: var(--warning); } .verdict.bad .verdict-tone { color: var(--danger); }
.verdict-headline { max-width: 32ch; margin: 0; font: 600 clamp(1.5rem, 3vw, 2.25rem)/1.15 var(--font-display); letter-spacing: -.02em; text-transform: none; text-wrap: balance; }
.verdict-next { margin: 0; color: var(--muted); }
.section-note { margin: 0 0 var(--space-4); color: var(--muted); }
.table-shell { width: 100%; min-width: 0; overflow-x: auto; border: 1px solid var(--border-soft); border-radius: var(--radius-md); background: var(--surface-nested); }
#panel-evidence .table-shell { max-width: 100%; max-height: 32rem; overflow: auto; overscroll-behavior: contain; }
table { width: max-content; min-width: 100%; border-collapse: collapse; table-layout: auto; }
th, td { padding: var(--space-3); border-bottom: 1px solid var(--border-soft); text-align: left; vertical-align: top; overflow-wrap: normal; }
th { color: var(--muted); background: var(--accent-wash); font-size: .75rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
tbody tr:last-child td { border-bottom: 0; }
td { color: var(--fg); font: .875rem/1.6 var(--font-mono); }
.empty { color: var(--muted); }
ul { margin: 0; padding-left: var(--space-6); } li { margin: var(--space-2) 0; }
code, pre { color: var(--fg-code); font: .8125rem/1.5 var(--font-mono); overflow-wrap: anywhere; }
code { padding: 2px 6px; border-radius: var(--radius-sm); background: var(--success-wash); }
pre { max-height: 520px; margin: var(--space-4) 0 0; padding: var(--space-4); overflow: auto; border: 1px solid var(--border-soft); border-radius: var(--radius-md); background: var(--surface-nested); white-space: pre-wrap; word-break: break-word; }
.risk, .hygiene.warning { border-color: var(--warning-border); }
.risk.empty-state, .command-bank, .hygiene.info { border-color: var(--border); }
.hygiene-findings th:nth-child(1), .hygiene-findings td:nth-child(1) { width: 15%; }
.hygiene-findings th:nth-child(2), .hygiene-findings td:nth-child(2) { width: 17%; }
.hygiene-findings th:nth-child(3), .hygiene-findings td:nth-child(3) { width: 31%; }
.hygiene-findings th:nth-child(4), .hygiene-findings td:nth-child(4) { width: 37%; }
.reviewable-table th:nth-child(1), .reviewable-table td:nth-child(1) { width: 14%; }
.reviewable-table th:nth-child(2), .reviewable-table td:nth-child(2) { width: 22%; }
.reviewable-table th:nth-child(3), .reviewable-table td:nth-child(3) { width: 20%; }
.reviewable-table th:nth-child(4), .reviewable-table td:nth-child(4) { width: 44%; }
.hygiene-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-3); margin: var(--space-4) 0; }
.hygiene-count { min-width: 0; padding: var(--space-3); border: 1px solid var(--border-nested); border-radius: var(--radius-md); background: var(--surface-nested); }
.hygiene-count strong { display: block; margin-top: var(--space-1); font: 600 1.5rem/1.1 var(--font-mono); font-variant-numeric: tabular-nums; }
.status-pill { display: inline-block; font: 700 .75rem/1.4 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
details summary { cursor: pointer; color: var(--fg); font-weight: 600; }
details summary:hover { color: var(--muted); }
details summary:focus-visible, .skip-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
@media (max-width: 900px) {
  .metric { grid-column: span 6; } .half, .grid > .risk, .grid > .info { grid-column: span 12; } .hygiene-metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .table-shell { max-height: 32rem; overflow: auto; border: 0; background: transparent; overscroll-behavior: contain; } .table-shell table, .table-shell tbody, .table-shell tr, .table-shell td { display: block; width: 100%; }
  thead { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  tbody { display: grid; gap: var(--space-3); } tr { padding: var(--space-3); border: 1px solid var(--border-soft); border-radius: var(--radius-md); background: var(--surface-nested); }
  td { display: grid; grid-template-columns: minmax(8rem, 30%) minmax(0, 1fr); gap: var(--space-3); padding: var(--space-2) 0; border: 0; overflow-wrap: anywhere; }
  [data-label]::before { content: attr(data-label); color: var(--muted); font: 600 .6875rem/1.5 var(--font-body); letter-spacing: .08em; text-transform: uppercase; }
  td.empty { display: block; }
}
@media (max-width: 900px) { .metric { grid-column: span 6; } .half, .grid > .risk, .grid > .info { grid-column: span 12; } .hygiene-metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); } td { grid-template-columns: minmax(7rem, 36%) minmax(0, 1fr); } }
@media (max-width: 720px) { header, main { width: min(100% - 20px, 1180px); } header { padding: var(--space-4) 0 var(--space-3); } h1 { max-width: none; } .tabs { gap: var(--space-1); padding-inline: 1px; } .tabs button { padding-inline: var(--space-2); font-size: .8125rem; } .card { padding: var(--space-4); } .metric { grid-column: span 12; min-height: auto; } .hygiene-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 420px) { .hygiene-metrics { grid-template-columns: 1fr; } td { grid-template-columns: 1fr; gap: var(--space-1); } }
.operations-dashboard { min-width: 0; max-width: 100%; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow); }
.operations-app-header { display: flex; align-items: end; justify-content: space-between; gap: var(--space-4); padding: var(--space-5) var(--space-6); border-bottom: 1px solid var(--border-soft); background: linear-gradient(180deg, var(--surface-raised), var(--surface)); }
.operations-app-header h2 { margin: var(--space-1) 0; }
.operations-repo { margin: 0; color: var(--muted); font-size: .75rem; }
.operations-search-label, .operations-sort-label { display: grid; gap: var(--space-1); color: var(--muted); font: 600 .75rem/1.4 var(--font-body); letter-spacing: .08em; text-transform: uppercase; }
.operations-search-label input, .operations-sort-label select { min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-nested); color: var(--fg); font: .875rem/1.4 var(--font-mono); padding: var(--space-2) var(--space-3); text-transform: none; letter-spacing: normal; }
.operations-search-label input { width: min(22rem, 42vw); }
.operations-summary { display: flex; flex-wrap: wrap; gap: var(--space-2); padding: var(--space-3) var(--space-6); border-bottom: 1px solid var(--border-soft); color: var(--muted); font: 600 .75rem/1.4 var(--font-mono); }
.operations-summary span { padding: var(--space-1) var(--space-2); border-radius: var(--radius-sm); background: var(--surface-nested); }
.operations-shell { display: grid; grid-template-columns: minmax(0, 1fr) minmax(18rem, 22rem); min-height: 34rem; }
.operations-main { min-width: 0; }
.operations-toolbar { display: flex; align-items: end; justify-content: space-between; gap: var(--space-3); padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border-soft); background: var(--surface-raised); }
.operations-filters, .operations-view-toggle { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.operations-filter, .operations-view-toggle button { cursor: pointer; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-nested); color: var(--muted); font: 600 .75rem/1.4 var(--font-mono); padding: var(--space-2) var(--space-3); text-transform: uppercase; }
.operations-filter.active, .operations-view-toggle button[aria-pressed="true"] { color: var(--fg); border-color: var(--border); background: var(--surface-raised); }
.operations-shortcuts { margin: 0; padding: var(--space-2) var(--space-4); color: var(--muted); font-size: .8125rem; }
kbd { padding: 1px 4px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface-nested); color: var(--fg); font: .6875rem/1.2 var(--font-mono); }
.operations-list { display: grid; gap: 1px; max-height: 31rem; overflow: auto; background: var(--border-soft); outline: none; }
#operations-list:focus-visible, .topology-stage:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.operations-row:focus-visible, .operations-graph-node:focus-visible, .topology-stage [role="button"]:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.operations-row { display: grid; grid-template-columns: minmax(9rem, 1fr) minmax(12rem, 1.5fr) auto minmax(7rem, .7fr); gap: var(--space-3); align-items: center; width: 100%; cursor: pointer; border: 0; background: var(--surface); color: var(--fg); padding: var(--space-3) var(--space-4); text-align: left; }
.operations-row:hover, .operations-row[aria-selected="true"] { background: var(--surface-raised); }
.operations-row strong, .operations-row-path, .operations-row-owner { min-width: 0; overflow-wrap: anywhere; }
.operations-row strong, .operations-row-owner { font: 600 .875rem/1.5 var(--font-mono); }
.operations-row-path { color: var(--muted); font: .875rem/1.5 var(--font-mono); }
.operations-state { padding: var(--space-1) var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-sm); font: 600 .6875rem/1.4 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; }
.operations-state.good { color: var(--success); } .operations-state.bad { color: var(--danger); } .operations-state.neutral { color: var(--warning); }
.operations-graph { min-height: 31rem; padding: var(--space-4); background: var(--surface); }
.operations-graph p { margin-top: 0; color: var(--muted); font-size: .8125rem; }
.operations-graph svg { width: 100%; min-height: 25rem; overflow: visible; }
.operations-graph-edge { stroke: var(--border); stroke-width: 2; stroke-dasharray: 6 6; }
.operations-graph-node { cursor: pointer; } .operations-graph-node circle { fill: var(--surface-raised); stroke: var(--accent); stroke-width: 2; } .operations-graph-node.selected circle { fill: var(--surface-raised); stroke: var(--fg); stroke-width: 4; } .operations-graph-node text { fill: var(--fg); font: .6875rem var(--font-mono); pointer-events: none; }
.operations-inspector { min-width: 0; border-left: 1px solid var(--border-soft); background: linear-gradient(180deg, var(--surface-raised), var(--surface)); }
.operations-inspector > div { display: grid; align-content: start; gap: var(--space-3); padding: var(--space-4); }
.operations-inspector h2 { margin: 0; text-transform: none; letter-spacing: -.02em; }
.operations-inspector p { margin: 0; }
.operations-fact { padding: var(--space-3); border: 1px solid var(--border-soft); border-radius: var(--radius-sm); background: var(--surface-nested); }
.operations-fact h3 { margin: 0 0 var(--space-1); font-size: .75rem; } .operations-fact p { overflow-wrap: anywhere; color: var(--fg); font: .875rem/1.6 var(--font-mono); }
.operations-js-note { margin: 0; padding: var(--space-3) var(--space-6); color: var(--muted); }
@media (max-width: 1020px) { .operations-shell { grid-template-columns: 1fr; } .operations-inspector { border-top: 1px solid var(--border-soft); border-left: 0; } .operations-inspector > div { grid-template-columns: repeat(2, minmax(0, 1fr)); } .operations-inspector > div > .eyebrow, .operations-inspector > div > h2, .operations-inspector > div > .guidance, .operations-inspector > div > .action-grid { grid-column: span 2; } }
@media (max-width: 720px) { #panel-evidence { min-width: 0; } #panel-evidence .table-shell { -webkit-overflow-scrolling: touch; } .operations-app-header, .operations-toolbar { align-items: stretch; flex-direction: column; } .operations-app-header > *, .operations-toolbar > * { min-width: 0; } .operations-search-label input { width: 100%; max-width: 100%; } .operations-filters, .operations-view-toggle { width: 100%; flex-wrap: nowrap; overflow-x: auto; padding-bottom: var(--space-1); overscroll-behavior-inline: contain; -webkit-overflow-scrolling: touch; } .operations-filter, .operations-view-toggle button { flex: 0 0 auto; min-height: 2.75rem; } .operations-sort-label select { width: 100%; max-width: 100%; min-height: 2.75rem; } .operations-row { grid-template-columns: 1fr auto; min-height: 2.75rem; } .operations-row-path, .operations-row-owner { grid-column: span 2; } .operations-row-owner::before { content: "Owner/activity: "; color: var(--muted); } .operations-inspector > div { grid-template-columns: 1fr; } .operations-inspector > div > .eyebrow, .operations-inspector > div > h2, .operations-inspector > div > .guidance, .operations-inspector > div > .action-grid { grid-column: span 1; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; } }
.topology-card, #topology-mode-selector, .topology-stage, .topology-alternative { min-width: 0; max-width: 100%; }
.topology-card { display: grid; gap: var(--space-3); }
.topology-card button { cursor: pointer; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-nested); color: var(--fg); padding: var(--space-2) var(--space-3); font: .75rem/1.4 var(--font-mono); }
#topology-mode-selector { display: flex; flex-wrap: nowrap; gap: var(--space-2); overflow-x: auto; padding-bottom: var(--space-1); overscroll-behavior-inline: contain; scroll-padding-inline: var(--space-2); -webkit-overflow-scrolling: touch; }
#topology-mode-selector button { flex: 0 0 auto; scroll-margin-inline: var(--space-2); white-space: nowrap; }
#topology-mode-selector button[aria-checked="true"] { border-color: var(--border); color: var(--fg); background: var(--surface-raised); }
.topology-controls { display: flex; gap: var(--space-2); }
.topology-stage { min-width: 0; min-height: 21rem; max-height: 32rem; overflow: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; border: 1px solid var(--border-soft); border-radius: var(--radius-md); background: var(--surface-nested); padding: var(--space-3); }
.topology-stage-terminal { max-height: 32rem; overflow: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
.topology-stage-swimlanes, .topology-stage-gittree { max-height: 32rem; }
.topology-stage .topology-drawing { min-width: 50rem; width: 50rem; }
.topology-stage svg { display: block; width: 100%; min-height: 19rem; }
.topology-edge, .topology-metro-trunk, .topology-metro-connector, .topology-timeline-axis, .topology-gittree-root, .topology-swimlane { fill: none; stroke: var(--border); stroke-width: 2; }
.topology-metro-trunk, .topology-timeline-axis { stroke: var(--accent); stroke-width: 3; }
.topology-metro-connector, .topology-gittree-root { stroke-dasharray: 5 5; }
.topology-radar-ring { fill: none; stroke: var(--border); stroke-width: 1.5; stroke-dasharray: 4 5; }
.topology-sunburst-sector { fill: var(--accent-wash); stroke: var(--border); stroke-width: 2; }
.topology-event-marker { fill: var(--success); stroke: var(--bg); stroke-width: 2; }
.topology-node { fill: var(--surface-raised); stroke: var(--accent); stroke-width: 2; cursor: pointer; } .topology-node.good { stroke: var(--success); } .topology-node.bad { stroke: var(--danger); } .topology-node.neutral { stroke: var(--warning); } .topology-node.selected { fill: var(--surface-raised); stroke: var(--fg); stroke-width: 4; }
.topology-stage text { fill: var(--fg); font: .8125rem var(--font-mono); }
.topology-caption, .topology-event-label, .topology-lane-label { fill: var(--muted) !important; font: .75rem var(--font-mono); }
.topology-terminal { min-width: 0; color: var(--fg); font: .875rem/1.6 var(--font-mono); }
.topology-terminal-table { min-width: 58rem; table-layout: auto; }
.topology-event-table { min-width: 38rem; }
.topology-terminal-table th { white-space: nowrap; font-size: .75rem; }
.topology-terminal-table td { min-width: 7rem; font-size: .875rem; }
.topology-terminal-table td:first-child { min-width: 9rem; }
.topology-alternative { max-height: 32rem; margin-top: var(--space-2); overflow: auto; overscroll-behavior-inline: contain; -webkit-overflow-scrolling: touch; border: 1px solid var(--border-soft); border-radius: var(--radius-md); padding: var(--space-2) var(--space-3); background: var(--surface-nested); }
.topology-alternative summary { padding: var(--space-1) 0; }
.topology-graphic { min-width: 0; max-width: 100%; width: 100%; overflow: hidden; margin: var(--space-2) 0 0; }
.topology-graphic summary { padding: var(--space-1) 0; }
.topology-terminal-row { overflow-wrap: anywhere; text-align: left; }
 .topology-terminal-action { white-space: nowrap; padding: var(--space-1) var(--space-2); font-size: .75rem; }
.topology-terminal-action[aria-pressed="true"] { border-color: var(--border); color: var(--fg); background: var(--surface-raised); }
.topology-selected { margin: var(--space-2) 0 0; color: var(--fg); font: .8125rem/1.5 var(--font-mono); overflow-wrap: anywhere; }
@media (min-width: 721px) and (max-width: 900px) { .table-shell tr { padding: var(--space-4); } .table-shell td { gap: var(--space-4); padding: var(--space-2) 0; font-size: .9375rem; line-height: 1.65; } .table-shell [data-label]::before { font-size: .75rem; line-height: 1.6; } .hygiene-metrics { gap: var(--space-4); } .hygiene-count { padding: var(--space-4); } .hygiene-count span, .metric span { font-size: .8125rem; } .hygiene-count strong { font-size: 1.75rem; } .card li, .card .section-note, .card .timestamp { font-size: .9375rem; line-height: 1.65; } }
@media (min-width: 721px) { .topology-stage { min-height: 16rem; padding: var(--space-2); } .topology-stage svg { min-height: 14rem; } }
@media (max-width: 900px) { .topology-terminal-table, .topology-event-table { min-width: 0; width: 100%; table-layout: fixed; } .topology-stage { min-height: 17rem; padding: var(--space-2); } .topology-stage svg { min-height: 15rem; } .topology-terminal-row { width: 100%; } .topology-terminal-table, .topology-terminal-table tbody, .topology-terminal-table tr, .topology-terminal-table td, .topology-event-table, .topology-event-table tbody, .topology-event-table tr, .topology-event-table td { display: block; width: 100%; } .topology-terminal-table thead, .topology-event-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); } .topology-terminal-table tr, .topology-event-table tr { margin-bottom: var(--space-3); padding: var(--space-2); border: 1px solid var(--border-soft); border-radius: var(--radius-sm); } .topology-terminal-table td, .topology-event-table td { display: grid; grid-template-columns: minmax(7rem, 38%) minmax(0, 1fr); gap: var(--space-2); min-width: 0; padding: var(--space-1) 0; overflow-wrap: anywhere; white-space: normal; } .topology-terminal-table td::before, .topology-event-table td::before { content: attr(data-label); color: var(--muted); font: 600 .75rem/1.4 var(--font-body); letter-spacing: .06em; text-transform: uppercase; } }
@media (max-width: 420px) { .topology-stage { min-height: 0; } .topology-stage svg { width: 100%; min-width: 0; } .topology-stage text { font-size: .8125rem; } #topology-mode-selector button, .topology-controls button, .topology-alternative summary, .topology-graphic summary { min-height: 2.75rem; display: flex; align-items: center; } .topology-terminal-table td, .topology-event-table td { grid-template-columns: 1fr; gap: var(--space-1); } .topology-terminal-table td:nth-child(5) { font-size: .875rem; } }
`;

export const REPORT_CSS = `${LEGACY_REPORT_CSS}${OPEN_DESIGN_DASHBOARD_CSS}${OPEN_DESIGN_TOPOLOGY_CSS}${OPEN_DESIGN_INTEGRATION_CSS}`;
