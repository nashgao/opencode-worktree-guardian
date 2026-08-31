export const OPEN_DESIGN_INTEGRATION_CSS = `
[hidden] { display: none !important; }
body::before { display: none; }
body > .app-header { width: 100%; margin: 0; }
body:has(#panel-topology:not([hidden])) > .app-header { display: none; }
#main-content { width: 100%; max-width: none; min-width: 0; margin: 0; padding: 0; }
.report-view-nav { position: fixed; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
.report-view-nav:focus-within { top: 64px; left: 16px; z-index: 400; width: auto; height: auto; overflow: visible; clip: auto; padding: 8px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); }
.report-view-nav .tabs { margin: 0; }
#panel-operations { min-height: calc(100vh - 56px); }
#panel-evidence, #panel-raw-data { width: min(1180px, calc(100% - 32px)); margin: 24px auto; }
#panel-evidence > .grid:first-child { margin-top: 0; }
#panel-evidence .card, #panel-raw-data .card { background: var(--surface); }
#panel-raw-data pre { max-height: calc(100vh - 130px); overflow: auto; }
.app-header .header-actions > [data-report-panel] { white-space: nowrap; }
.app-header .search label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
.app-shell { min-height: calc(100vh - 56px); }
.table-wrap table { margin: 0; }
.sort { position: relative; }
.sort::after { content: "⌄"; position: absolute; top: 4px; right: 8px; color: var(--muted); font-size: 12px; pointer-events: none; }
tbody tr.operations-row { display: table-row; min-height: 0; padding: 0; }
tbody tr.operations-row strong { font: inherit; }
.operations-row[aria-selected="true"] td { background: rgba(92, 138, 255, .08); }
.operations-row[aria-selected="true"] { border-left: 2px solid var(--accent-2); }
.operations-row .operations-row-owner { display: inline; }
.operations-row .operations-row-owner::before { content: none; }
.operations-row .actions-cell button { position: relative; }
.operations-row .actions-cell button span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
.table-wrap #operations-empty { padding: 56px 24px; color: var(--muted); text-align: center; }
.view-toggle button[aria-pressed="true"] { background: var(--surface-3); color: var(--fg); }
.view-toggle button svg { width: 14px; height: 14px; }
.graph-view[hidden], .table-wrap[hidden] { display: none; }
.graph-view:not([hidden]) { display: block; }
.graph-view .operations-graph-edge { stroke: var(--border-strong); stroke-width: 1.5; stroke-dasharray: 5 5; }
.graph-view .operations-graph-node circle { fill: var(--surface-2); stroke: var(--accent-2); stroke-width: 2; }
.graph-view .operations-graph-node.selected circle { fill: var(--surface-3); stroke: var(--fg); stroke-width: 4; }
.graph-view .operations-graph-node text { fill: var(--fg); font: 11px var(--font-mono); }
.inspector-empty[hidden] { display: none; }
.inspector-content { min-height: 0; overflow: auto; }
.inspector-content .guidance { margin: 0; border: 0; border-radius: 0; padding: 14px; background: transparent; }
.inspector-content .guidance h3 { margin: 0 0 6px; color: var(--fg); font-size: 11px; }
.inspector-content .guidance p { margin: 0 0 10px; color: var(--muted); font-size: 11px; }
.inspector-content .guidance button { width: auto; }
.inspector-content .action-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; padding: 14px; }
.inspector-content .action-button { width: 100%; border: 1px solid var(--border); background: var(--surface-2); color: var(--muted); font-size: 11px; text-transform: capitalize; }
.inspector-content .action-button:hover, .inspector-content .action-button:focus-visible { color: var(--fg); border-color: var(--border-strong); outline: none; }
.inspector-content .operations-fact { padding: 8px 0; border-bottom: 1px solid var(--border); }
.inspector-content .operations-fact h3 { margin: 0 0 2px; color: var(--muted); font-size: 10px; }
.inspector-content .operations-fact p { margin: 0; color: var(--fg); font: 11px/1.5 var(--font-mono); overflow-wrap: anywhere; }
.status-unavailable { color: var(--muted); background: rgba(139,143,153,.1); border-color: rgba(139,143,153,.2); }
.topology-page[hidden] { display: none; }
.topology-page .topology-graphic > summary { display: none; }
.topology-page .topology-graphic[open] > .topology-stage { display: block; }
.topology-page .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
@media (max-width: 1020px) { .inspector-content .action-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@media (max-width: 900px) { .table-wrap table { display: table; width: 100%; min-width: 720px; } .table-wrap thead { position: static; display: table-header-group; width: auto; height: auto; padding: 0; margin: 0; overflow: visible; clip: auto; white-space: normal; } .table-wrap tbody { display: table-row-group; } .table-wrap tr, .table-wrap tr.operations-row { display: table-row; width: auto; padding: 0; border: 0; border-bottom: 1px solid var(--border); border-radius: 0; background: transparent; } .table-wrap th, .table-wrap td { display: table-cell; width: auto; min-width: 0; grid-template-columns: none; gap: 0; padding: 12px 14px; border-bottom: 1px solid var(--border); } .table-wrap th:nth-child(2), .table-wrap td:nth-child(2) { width: 160px; min-width: 160px; } .table-wrap th:nth-child(3), .table-wrap td:nth-child(3) { width: 280px; min-width: 280px; } .table-wrap td::before { content: none; } }
@media (max-width: 720px) { .app-header .header-actions > [data-report-panel] { padding-inline: 9px; } .inspector-content .action-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .table-wrap .col-commit, .table-wrap .col-actions { display: none; } }
@media (max-width: 720px) { .inspector, .inspector-backdrop { inset: 89px 0 0; } }
@media (max-width: 720px) { .table-wrap { overflow-x: hidden; } .table-wrap table { min-width: 0; table-layout: fixed; } .table-wrap th, .table-wrap td { padding: 10px 8px; } .table-wrap th:nth-child(1), .table-wrap td:nth-child(1) { width: 40px; min-width: 40px; } .table-wrap th:nth-child(2), .table-wrap td:nth-child(2) { width: 100px; min-width: 0; } .table-wrap th:nth-child(3), .table-wrap td:nth-child(3) { width: auto; min-width: 0; } .table-wrap th:nth-child(4), .table-wrap td:nth-child(4) { width: 76px; min-width: 0; } .path-cell { min-width: 0; align-items: flex-start; } .operations-row-path { min-width: 0; overflow-wrap: anywhere; } .path-cell .copy-btn { flex: 0 0 auto; opacity: 1; } }
@media (max-width: 720px) { .table-wrap .branch-tag { display: none; } .table-wrap .branch-cell { gap: 4px; } .table-wrap .branch-name, .table-wrap .operations-state { white-space: nowrap; } .table-wrap .operations-state { padding-inline: 6px; font-size: 10px; } .table-wrap th:nth-child(2), .table-wrap td:nth-child(2) { width: 80px; } .table-wrap th:nth-child(4), .table-wrap td:nth-child(4) { width: 80px; } }
@media (prefers-reduced-motion: reduce) { body *, body *::before, body *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; } }
`;
