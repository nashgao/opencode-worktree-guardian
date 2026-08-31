export const OPEN_DESIGN_DASHBOARD_CSS_2 = `
    }

    .toolbar-left, .toolbar-right {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .filter-chips {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    .filter-chips > .visually-hidden {
      position: static;
      width: auto;
      height: auto;
      overflow: visible;
      clip: auto;
      white-space: normal;
      display: contents;
    }

    .filter-chips > .visually-hidden button {
      height: 26px;
      padding: 0 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 500;
      border: 1px solid var(--border);
      background: var(--surface-2);
      color: var(--muted);
      cursor: pointer;
      transition: all 0.15s;
    }

    .filter-chips > .visually-hidden button::before { content: attr(data-filter) " "; text-transform: capitalize; }

    .filter-chips > .visually-hidden button:hover, .filter-chips > .visually-hidden button:focus-visible { border-color: var(--border-strong); color: var(--fg); }

    .chip {
      height: 26px;
      padding: 0 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 500;
      border: 1px solid var(--border);
      background: var(--surface-2);
      color: var(--muted);
      cursor: pointer;
      transition: all 0.15s;
    }

    .chip:hover { border-color: var(--border-strong); color: var(--fg); }
    .chip.active {
      background: rgba(92, 138, 255, 0.12);
      border-color: rgba(92, 138, 255, 0.35);
      color: var(--accent-2);
    }

    .sort select {
      height: 28px;
      padding: 0 24px 0 10px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border);
      background: var(--surface-2);
      color: var(--fg);
      font-size: 11px;
      appearance: none;
      background-repeat: no-repeat;
      background-position: right 8px center;
    }

    .view-toggle {
      display: flex;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      overflow: hidden;
    }

    .view-toggle button {
      height: 28px;
      border-radius: 0;
      border: none;
      border-right: 1px solid var(--border);
    }

    .view-toggle button:last-child { border-right: none; }
    .view-toggle button.active { background: var(--surface-3); color: var(--fg); }

    /* Table */
    .table-wrap {
      flex: 1;
      overflow: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }

    thead th {
      position: sticky;
      top: 0;
      text-align: left;
      padding: 10px 14px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
      z-index: 10;
    }

    tbody tr {
      cursor: pointer;
      border-bottom: 1px solid var(--border);
    }

    tbody tr:hover td { background: rgba(255, 255, 255, 0.025); }
    tbody tr.selected td { background: rgba(92, 138, 255, 0.08); }
    tbody tr.selected { border-left: 2px solid var(--accent-2); }

    tbody td {
      padding: 12px 14px;
      vertical-align: middle;
      border-left: 2px solid transparent;
      transition: background 0.1s;
    }

    .col-select { width: 36px; }
    .col-branch { width: 24%; }
    .col-path { width: 28%; }
    .col-status { width: 12%; }
    .col-commit { width: 18%; }
    .col-actions { width: 90px; text-align: right; }

    .checkbox {
      width: 16px;
      height: 16px;
      border-radius: 4px;
      border: 1px solid var(--border-strong);
      background: var(--surface);
      cursor: pointer;
      display: grid;
      place-items: center;
    }

    .checkbox svg { width: 11px; height: 11px; color: var(--fg); opacity: 0; }
    .checkbox.checked { background: var(--accent-2); border-color: var(--accent-2); }
    .checkbox.checked svg { opacity: 1; }

    .branch-cell {
      display: flex;
      align-items: center;
      gap: 9px;
    }

    .branch-icon {
      width: 20px;
      height: 20px;
      border-radius: 5px;
      background: rgba(92, 138, 255, 0.12);
      color: var(--accent-2);
      display: grid;
      place-items: center;
      flex-shrink: 0;
    }

    .branch-icon svg { width: 12px; height: 12px; }

    .branch-name {
      font-family: var(--font-mono);
      font-weight: 500;
      font-size: 12px;
    }

    .branch-tag {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 4px;
      background: var(--surface-3);
      color: var(--muted);
      border: 1px solid var(--border);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .path-cell {
      font-family: var(--font-mono);
      color: var(--muted);
      font-size: 11px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .path-cell .copy-btn {
      width: 22px;
      height: 22px;
      padding: 0;
      opacity: 0;
      border-color: var(--border);
      color: var(--muted);
    }

    tbody tr:hover .path-cell .copy-btn { opacity: 1; }
    .path-cell .copy-btn:hover { color: var(--fg); background: var(--surface-2); }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 500;
      border: 1px solid transparent;
    }

    .status-pill::before {
      content: '';
      width: 5px;
      height: 5px;
`;
