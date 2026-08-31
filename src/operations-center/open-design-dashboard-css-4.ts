export const OPEN_DESIGN_DASHBOARD_CSS_4 = `
      font-size: 12px;
      color: var(--fg);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .commit-time {
      font-size: 10px;
      color: var(--muted);
      margin-top: 1px;
    }

    .inspector-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .inspector-actions button { width: 100%; }

    /* Graph view */
    .graph-view { display: none; padding: 24px; }
    .graph-view.active { display: block; }

    .graph-svg {
      width: 100%;
      height: calc(100vh - 210px);
      min-height: 400px;
    }

    .graph-node {
      cursor: pointer;
      transition: opacity 0.15s;
    }

    .graph-node:hover { opacity: 0.85; }

    /* Modal */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 200;
      padding: 20px;
    }

    .modal-overlay.open { display: flex; }

    .modal {
      width: 100%;
      max-width: 420px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 20px;
      box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5);
    }

    .modal h2 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 4px;
    }

    .modal p {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 18px;
    }

    .field { margin-bottom: 14px; }

    .field label {
      display: block;
      font-size: 10px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.07em;
      margin-bottom: 5px;
    }

    .field input {
      width: 100%;
      height: 36px;
      padding: 0 11px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      color: var(--fg);
      font-size: 12px;
      font-family: var(--font-mono);
      outline: none;
    }

    .field input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(59, 178, 115, 0.12);
    }

    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 6px;
    }

    /* Toast */
    .toast-stack {
      position: fixed;
      bottom: 20px;
      right: 20px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      z-index: 300;
      pointer-events: none;
    }

    .toast {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 11px 14px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
      color: var(--fg);
      font-size: 12px;
      transform: translateX(120%);
      opacity: 0;
      transition: transform 0.25s ease, opacity 0.2s ease;
      pointer-events: auto;
      max-width: 320px;
    }

    .toast.show { transform: translateX(0); opacity: 1; }
    .toast-icon { width: 16px; height: 16px; flex-shrink: 0; }
    .toast-icon.spin { animation: spin 1s linear infinite; }

    @keyframes spin { to { transform: rotate(360deg); } }

    /* Shortcuts hint */
    .shortcuts-hint {
      position: fixed;
      bottom: 20px;
      left: 20px;
      color: var(--muted);
      font-size: 10px;
      letter-spacing: 0.06em;
      z-index: 50;
    }

    .shortcuts-hint kbd {
      font-family: var(--font-mono);
      padding: 1px 5px;
      border-radius: 4px;
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--fg);
    }

    @media (max-width: 1020px) {
      .app-shell { grid-template-columns: 1fr; }
      .inspector {
        position: fixed;
        inset: 56px 0 0 0;
        z-index: 90;
        transform: translateX(100%);
        transition: transform 0.2s ease;
      }
      .inspector.open { transform: translateX(0); }
      .inspector-backdrop {
        position: fixed;
        inset: 56px 0 0 0;
        background: rgba(0, 0, 0, 0.4);
        z-index: 80;
        display: none;
      }
      .inspector-backdrop.open { display: block; }
      .search input { width: 160px; }
    }

    @media (max-width: 720px) {
      .app-header { flex-wrap: wrap; height: auto; padding: 10px 14px; gap: 10px; }
      .header-actions { width: 100%; }
      .search { flex: 1; }
      .search input { width: 100%; }
      .toolbar { flex-wrap: wrap; }
      .toolbar-left { flex-wrap: wrap; }
      .col-actions, .col-commit { display: none; }
      .shortcuts-hint { display: none; }
    }
`;

