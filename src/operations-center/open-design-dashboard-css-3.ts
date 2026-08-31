export const OPEN_DESIGN_DASHBOARD_CSS_3 = `
      border-radius: 50%;
      background: currentColor;
    }

    .status-clean { color: var(--accent); background: rgba(59, 178, 115, 0.10); border-color: rgba(59, 178, 115, 0.20); }
    .status-dirty { color: var(--warn); background: rgba(229, 164, 67, 0.10); border-color: rgba(229, 164, 67, 0.20); }
    .status-ahead { color: var(--accent-2); background: rgba(92, 138, 255, 0.10); border-color: rgba(92, 138, 255, 0.20); }
    .status-behind { color: var(--danger); background: rgba(228, 87, 101, 0.10); border-color: rgba(228, 87, 101, 0.20); }

    .commit-cell {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--muted);
    }

    .commit-hash { color: var(--fg); font-weight: 500; }

    .actions-cell {
      display: flex;
      justify-content: flex-end;
      gap: 4px;
    }

    .actions-cell button {
      width: 26px;
      height: 26px;
      padding: 0;
      border-color: var(--border);
      color: var(--muted);
    }

    .actions-cell button:hover { color: var(--fg); background: var(--surface-2); }

    .empty-state {
      display: none;
      padding: 56px 24px;
      text-align: center;
      color: var(--muted);
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }

    .empty-state.visible { display: flex; }

    /* Inspector */
    .inspector-header {
      padding: 16px 18px;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }

    .inspector-header h2 {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 2px;
      letter-spacing: -0.01em;
    }

    .inspector-header p {
      min-width: 0;
      color: var(--muted);
      font-size: 11px;
      font-family: var(--font-mono);
      overflow-wrap: anywhere;
    }

    .inspector-body {
      flex: 1;
      overflow: auto;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    .inspector-empty {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: var(--muted);
      text-align: center;
      gap: 10px;
    }

    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      overflow: hidden;
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      background: var(--surface-2);
    }

    .panel-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }

    .panel-body { padding: 14px; }

    .meta-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .meta-item dt {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin-bottom: 3px;
    }

    .meta-item dd {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--fg);
    }

    .divergence {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 4px;
    }

    .divergence-bar {
      flex: 1;
      height: 6px;
      border-radius: 999px;
      background: var(--surface-3);
      overflow: hidden;
      display: flex;
    }

    .divergence-bar .behind { background: var(--danger); }
    .divergence-bar .ahead { background: var(--accent); }

    .file-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .file-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 10px;
      border-radius: var(--radius-md);
      background: var(--surface-2);
      font-family: var(--font-mono);
      font-size: 11px;
    }

    .file-status {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 2px 5px;
      border-radius: 4px;
      background: var(--surface-3);
      color: var(--muted);
    }

    .file-status.modified { color: var(--warn); background: rgba(229, 164, 67, 0.12); }
    .file-status.added { color: var(--accent); background: rgba(59, 178, 115, 0.12); }
    .file-status.deleted { color: var(--danger); background: rgba(228, 87, 101, 0.12); }

    .commit-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .commit-item {
      display: flex;
      gap: 10px;
    }

    .commit-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent-2);
      margin-top: 5px;
      flex-shrink: 0;
    }

    .commit-meta { flex: 1; min-width: 0; }
    .commit-msg {
`;
