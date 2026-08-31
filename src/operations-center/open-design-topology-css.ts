export const OPEN_DESIGN_TOPOLOGY_CSS = `
.topology-page {
  --topology-bg: oklch(15% .02 230); --topology-surface: oklch(21% .022 230); --topology-panel: oklch(25% .024 230);
  --topology-border: oklch(36% .03 230); --topology-text: oklch(95% .01 230); --topology-muted: oklch(62% .03 230);
  --topology-accent: oklch(82% .12 175); --topology-success: oklch(75% .22 145); --topology-warning: oklch(80% .14 85); --topology-danger: oklch(68% .18 25);
  --topology-radius: 18px; position: relative; min-height: 100vh; overflow: hidden; background: var(--topology-bg); color: var(--topology-text);
  font: 15px/1.55 "Space Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
.topology-page::before { content: ""; position: absolute; inset: 0; pointer-events: none; background-image: linear-gradient(color-mix(in oklab, var(--topology-accent) 3%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in oklab, var(--topology-accent) 3%, transparent) 1px, transparent 1px); background-size: 40px 40px; }
.topology-container { width: min(1280px, calc(100% - 32px)); margin: 0 auto; padding: 24px 0; position: relative; z-index: 1; }
.topology-header { width: auto; padding: 0; display: flex; align-items: baseline; justify-content: space-between; margin: 0 0 18px; flex-wrap: wrap; gap: 12px; }
.topology-header h1 { max-width: none; margin: 0; color: var(--topology-text); font: 700 38px/1.05 "Space Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; letter-spacing: -.04em; text-transform: none; }
.topology-page .eyebrow { color: var(--topology-accent); font: 12px "JetBrains Mono", ui-monospace, Menlo, monospace; letter-spacing: .14em; text-transform: uppercase; }
.topology-back { border: 0; background: transparent; color: var(--topology-muted); font-size: 14px; cursor: pointer; }
.topology-back:hover, .topology-back:focus-visible { color: var(--topology-accent); outline: none; }
.topology-subtitle { max-width: 70ch; margin: 0 0 16px; color: var(--topology-muted); font-size: 14px; }
.topology-view-tabs, #topology-mode-selector { display: flex; gap: 6px; flex-wrap: wrap; margin: 0; overflow: visible; padding: 0; }
.topology-view-tabs button, #topology-mode-selector button { min-height: 0; padding: 7px 14px; border: 1px solid var(--topology-border); border-radius: 8px; background: rgba(20,29,35,.9); color: var(--topology-muted); font: 13px "Space Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; cursor: pointer; text-transform: none; letter-spacing: 0; }
.topology-view-tabs button:hover, #topology-mode-selector button:hover { color: var(--topology-text); border-color: var(--topology-accent); }
#topology-mode-selector button[aria-checked="true"] { color: var(--topology-bg); background: var(--topology-accent); border-color: var(--topology-accent); }
.topology-wrap { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 20px; margin-top: 14px; }
.topology-page .topology-stage { position: relative; min-width: 0; min-height: 720px; height: 720px; max-height: 720px; overflow: hidden; padding: 0; border: 1px solid var(--topology-border); border-radius: var(--topology-radius); background: var(--topology-surface); overscroll-behavior: contain; }
.topology-page .topology-stage-radar { background: radial-gradient(circle at center, color-mix(in oklab, var(--topology-success) 10%, var(--topology-surface)) 0%, var(--topology-bg) 75%); cursor: crosshair; }
.topology-page .topology-stage-terminal { overflow: auto; background: color-mix(in oklab, var(--topology-success) 5%, var(--topology-bg)); }
.topology-page .topology-stage svg, .topology-page .topology-drawing { display: block; width: 100% !important; min-width: 0 !important; min-height: 720px; height: 720px; }
.topology-controls { position: absolute; top: 14px; right: 14px; z-index: 5; display: flex; gap: 8px; }
.topology-controls button { width: 34px; height: 34px; padding: 0; border: 1px solid var(--topology-border); border-radius: 8px; background: rgba(20,29,35,.9); color: var(--topology-text); font-size: 16px; cursor: pointer; }
#topology-reset { width: auto; padding-inline: 8px; font-size: 12px; }
.topology-controls button:hover, .topology-controls button:focus-visible { color: var(--topology-accent); border-color: var(--topology-accent); outline: none; }
.topology-panel { height: fit-content; padding: 22px; display: flex; flex-direction: column; gap: 18px; border: 1px solid var(--topology-border); border-radius: var(--topology-radius); background: var(--topology-panel); }
.topology-panel h2 { margin: 0; color: var(--topology-text); font: 600 18px "Space Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; letter-spacing: 0; text-transform: none; }
.topology-legend { display: flex; flex-direction: column; gap: 10px; }
.topology-legend-item { display: flex; align-items: center; gap: 10px; border: 0; padding: 0; background: transparent; color: var(--topology-muted); font-size: 13px; cursor: pointer; text-align: left; }
.topology-legend-item:hover, .topology-legend-item:focus-visible { color: var(--topology-text); outline: none; }
.topology-line-swatch { width: 22px; height: 4px; flex: 0 0 auto; border-radius: 2px; background: var(--topology-accent); }
.topology-detail { border-top: 1px solid var(--topology-border); padding-top: 16px; }
.topology-detail h3 { margin: 0 0 12px; color: var(--topology-text); font: 600 15px "Space Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; letter-spacing: 0; text-transform: none; }
.topology-detail-row { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,.05); font-size: 13px; }
.topology-detail-row span { color: var(--topology-muted); }
.topology-detail-row code { color: var(--topology-text); font: 12px "JetBrains Mono", ui-monospace, Menlo, monospace; overflow-wrap: anywhere; text-align: right; }
.topology-page .section-note, .topology-page .topology-hint { margin: 0; color: var(--topology-muted); font-size: 12px; }
.topology-page .topology-metro-trunk { fill: none; stroke: var(--topology-accent); stroke-width: 5; stroke-linecap: round; }
.topology-page .topology-metro-connector, .topology-page .topology-gittree-root { fill: none; stroke: color-mix(in oklab, var(--topology-text) 16%, transparent); stroke-width: 2; stroke-dasharray: 4 4; }
.topology-page .topology-grid-line { stroke: color-mix(in oklab, var(--topology-text) 7%, transparent); stroke-width: 1; stroke-dasharray: 2 8; }
.topology-page .topology-metro-branch, .topology-page .topology-gittree-branch { fill: none; stroke: var(--worktree-color); stroke-width: 4; stroke-linecap: round; filter: drop-shadow(0 0 5px color-mix(in oklab, var(--worktree-color) 48%, transparent)); }
.topology-page .topology-gittree-branch { stroke-width: 3; }
.topology-page .topology-metro-station, .topology-page .topology-gittree-split { fill: var(--worktree-color); stroke: var(--topology-bg); stroke-width: 2; }
.topology-page .topology-lifecycle-pill { fill: color-mix(in oklab, var(--worktree-color) 16%, var(--topology-surface)); stroke: color-mix(in oklab, var(--worktree-color) 55%, transparent); }
.topology-page .topology-lifecycle-label { fill: var(--worktree-color) !important; font-size: 9px; text-transform: uppercase; }
.topology-page .topology-radar-ring { fill: none; stroke: color-mix(in oklab, var(--topology-success) 24%, transparent); stroke-width: 1; stroke-dasharray: none; }
.topology-page .topology-radar-axis { stroke: color-mix(in oklab, var(--topology-success) 15%, transparent); stroke-width: 1; }
.topology-page .topology-radar-readout { fill: color-mix(in oklab, var(--topology-success) 72%, var(--topology-muted)) !important; font-size: 10px; letter-spacing: .08em; }
.topology-page .topology-timeline-axis, .topology-page .topology-swimlane { fill: none; stroke: color-mix(in oklab, var(--topology-text) 20%, transparent); stroke-width: 2; }
.topology-page .topology-timeline-tick-line { stroke: color-mix(in oklab, var(--topology-text) 7%, transparent); stroke-width: 1; }
.topology-page .topology-timeline-row, .topology-page .topology-swimlane { stroke: var(--worktree-color); stroke-width: 2; }
.topology-page .topology-timeline-row-bg, .topology-page .topology-swimlane-row-bg { fill: color-mix(in oklab, var(--topology-text) 2.5%, transparent); stroke: color-mix(in oklab, var(--topology-text) 6%, transparent); }
.topology-page .topology-timeline-worktree, .topology-page .topology-swimlane-worktree { cursor: pointer; }
.topology-page .topology-timeline-worktree:focus-visible .topology-timeline-row-bg, .topology-page .topology-swimlane-worktree:focus-visible .topology-swimlane-row-bg, .topology-page .topology-timeline-worktree[aria-pressed="true"] .topology-timeline-row-bg, .topology-page .topology-swimlane-worktree[aria-pressed="true"] .topology-swimlane-row-bg { fill: color-mix(in oklab, var(--worktree-color) 12%, transparent); stroke: var(--worktree-color); outline: none; }
.topology-page .topology-timeline-label, .topology-page .topology-timeline-tick, .topology-page .topology-unavailable-label { fill: var(--topology-muted) !important; }
.topology-page .topology-sunburst-sector { fill: color-mix(in oklab, var(--worktree-color) 55%, transparent); stroke: var(--topology-bg); stroke-width: 2; filter: drop-shadow(0 0 4px color-mix(in oklab, var(--worktree-color) 30%, transparent)); }
.topology-page .topology-sunburst-ring { fill: none; stroke: color-mix(in oklab, var(--topology-text) 9%, transparent); stroke-width: 1; pointer-events: none; }
.topology-page .topology-sunburst-center { fill: var(--topology-panel); stroke: var(--topology-accent); stroke-width: 2; }
.topology-page .topology-node { fill: var(--topology-accent); stroke: var(--topology-bg); stroke-width: 3; cursor: pointer; filter: drop-shadow(0 0 6px currentColor); }
.topology-page .topology-node.good { fill: var(--topology-success); } .topology-page .topology-node.bad { fill: var(--topology-danger); } .topology-page .topology-node.neutral { fill: var(--topology-warning); }
.topology-page .palette-0 { --worktree-color: #5eead4; } .topology-page .palette-1 { --worktree-color: #a78bfa; } .topology-page .palette-2 { --worktree-color: #fbbf5c; } .topology-page .palette-3 { --worktree-color: #f87171; } .topology-page .palette-4 { --worktree-color: #8a9ba0; }
.topology-page .topology-node.palette-0, .topology-page .topology-node.palette-1, .topology-page .topology-node.palette-2, .topology-page .topology-node.palette-3, .topology-page .topology-node.palette-4 { fill: var(--worktree-color); color: var(--worktree-color); }
.topology-page .topology-line-swatch.palette-0, .topology-page .topology-line-swatch.palette-1, .topology-page .topology-line-swatch.palette-2, .topology-page .topology-line-swatch.palette-3, .topology-page .topology-line-swatch.palette-4 { background: var(--worktree-color); }
.topology-page .topology-node.selected { fill: var(--topology-text); stroke: var(--topology-accent); stroke-width: 4; }
.topology-page .topology-event-marker { fill: var(--worktree-color, var(--topology-success)); stroke: var(--topology-bg); stroke-width: 2; filter: drop-shadow(0 0 6px var(--worktree-color, currentColor)); }
.topology-page .topology-event-marker[data-topology-palette="0"] { --worktree-color: #5eead4; } .topology-page .topology-event-marker[data-topology-palette="1"] { --worktree-color: #a78bfa; } .topology-page .topology-event-marker[data-topology-palette="2"] { --worktree-color: #fbbf5c; } .topology-page .topology-event-marker[data-topology-palette="3"] { --worktree-color: #f87171; } .topology-page .topology-event-marker[data-topology-palette="4"] { --worktree-color: #8a9ba0; }
.topology-page .topology-stage text { fill: var(--topology-muted); font: 11px "JetBrains Mono", ui-monospace, Menlo, monospace; }
.topology-page .topology-caption, .topology-page .topology-event-label, .topology-page .topology-lane-label { fill: var(--topology-muted) !important; }
.topology-page .topology-selected { position: absolute; left: 18px; bottom: 14px; max-width: calc(100% - 36px); margin: 0; color: var(--topology-muted); font: 11px "JetBrains Mono", ui-monospace, Menlo, monospace; }
.topology-page .topology-terminal { min-width: 760px; padding: 24px; color: var(--topology-success); font: 13px/1.6 "JetBrains Mono", ui-monospace, Menlo, monospace; }
.topology-page .topology-terminal table { width: 100%; min-width: 0; border-collapse: collapse; color: var(--topology-success); }
.topology-page .topology-terminal table { display: table; }
.topology-page .topology-terminal thead { position: static; display: table-header-group; width: auto; height: auto; overflow: visible; clip: auto; }
.topology-page .topology-terminal tbody { display: table-row-group; }
.topology-page .topology-terminal tr { display: table-row; width: auto; margin: 0; padding: 0; border: 0; }
.topology-page .topology-terminal th, .topology-page .topology-terminal td { display: table-cell; width: auto; min-width: 0; }
.topology-page .topology-terminal td::before { content: none; }
.topology-page .topology-terminal caption { padding: 0 0 8px; text-align: left; color: var(--topology-text); }
.topology-page .topology-terminal th, .topology-page .topology-terminal td { padding: 6px 8px; border-bottom: 1px solid color-mix(in oklab, var(--topology-success) 12%, transparent); text-align: left; }
.topology-page .topology-terminal-action { border: 1px solid color-mix(in oklab, var(--topology-success) 30%, transparent); background: transparent; color: var(--topology-success); }
.topology-page .topology-alternative { max-height: 18rem; margin: 0; overflow: auto; border: 0; padding: 0; background: transparent; }
.topology-page .topology-alternative summary { color: var(--topology-muted); font-size: 12px; cursor: pointer; }
.topology-page .topology-alternative .topology-terminal { min-width: 0; padding: 8px 0 0; font-size: 11px; }
.topology-page .topology-alternative table { min-width: 36rem; }
.topology-page .topology-graphic { margin: 0; overflow: visible; }
@media (max-width: 960px) { .topology-wrap { grid-template-columns: 1fr; } .topology-page .topology-stage { min-height: 720px; } }
@media (max-width: 420px) { .topology-container { width: min(100% - 24px, 1280px); padding-top: 20px; } .topology-header h1 { font-size: 34px; } .topology-page .topology-stage { min-height: 720px; } .topology-view-tabs, #topology-mode-selector { flex-wrap: wrap; overflow: visible; } .topology-view-tabs button, #topology-mode-selector button { min-height: 34px; } }
@media (max-width: 420px) { .topology-page .topology-stage text { font-size: 24px; } .topology-page .topology-lifecycle-label { font-size: 20px; } .topology-page .topology-caption { display: none; } }
@media (prefers-reduced-motion: reduce) { .topology-page *, .topology-page *::before, .topology-page *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; } }
`;
