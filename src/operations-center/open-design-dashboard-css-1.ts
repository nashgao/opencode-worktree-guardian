export const OPEN_DESIGN_DASHBOARD_CSS_1 = `
    :root {
      --bg: #0b0c0f;
      --surface: #13151a;
      --surface-2: #1a1d24;
      --surface-3: #22262e;
      --fg: #f0f1f5;
      --muted: #8b8f99;
      --border: rgba(255, 255, 255, 0.08);
      --border-strong: rgba(255, 255, 255, 0.14);
      --accent: #3bb273;
      --accent-2: #5c8aff;
      --warn: #e5a443;
      --danger: #e45765;
      --info: #59b8ff;

      --font-display: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'Segoe UI', system-ui, sans-serif;
      --font-body: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'Segoe UI', system-ui, sans-serif;
      --font-mono: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;

      --radius-sm: 6px;
      --radius-md: 10px;
      --radius-lg: 14px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
      width: 100%;
      height: 100%;
      background: var(--bg);
      color: var(--fg);
      font: 13px/1.5 var(--font-body);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    button, input, select {
      font-family: inherit;
      color: inherit;
    }

    /* Header */
    .app-header {
      position: sticky;
      top: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      height: 56px;
      padding: 0 20px;
      background: color-mix(in srgb, var(--bg) 90%, transparent);
      backdrop-filter: blur(14px);
      border-bottom: 1px solid var(--border);
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }

    .brand-mark {
      width: 26px;
      height: 26px;
      border-radius: var(--radius-sm);
      background: var(--surface);
      border: 1px solid var(--border);
      display: grid;
      place-items: center;
    }

    .brand-mark svg { width: 15px; height: 15px; color: var(--accent); }

    .repo-name {
      color: var(--muted);
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.02em;
      padding: 3px 8px;
      border-radius: var(--radius-sm);
      background: var(--surface);
      border: 1px solid var(--border);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .search {
      position: relative;
    }

    .search input {
      width: 220px;
      height: 32px;
      padding: 0 10px 0 32px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      color: var(--fg);
      font-size: 12px;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }

    .search input::placeholder { color: var(--muted); }
    .search input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(59, 178, 115, 0.12);
    }

    .search svg {
      position: absolute;
      left: 9px;
      top: 50%;
      transform: translateY(-50%);
      width: 14px;
      height: 14px;
      color: var(--muted);
    }

    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      height: 32px;
      padding: 0 12px;
      border-radius: var(--radius-md);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: transform 0.05s, opacity 0.15s, background 0.15s, border-color 0.15s;
      border: 1px solid transparent;
      background: transparent;
      white-space: nowrap;
    }

    button:disabled { opacity: 0.45; cursor: not-allowed; }
    button:active:not(:disabled) { transform: translateY(1px); }

    .btn-primary {
      background: var(--accent);
      color: #07140e;
    }

    .btn-primary:hover:not(:disabled) { background: #4cc883; }

    .btn-ghost {
      background: var(--surface);
      color: var(--fg);
      border-color: var(--border);
    }

    .btn-ghost:hover:not(:disabled) { background: var(--surface-2); border-color: var(--border-strong); }

    .btn-danger {
      color: var(--danger);
      border-color: rgba(228, 87, 101, 0.35);
    }

    .btn-danger:hover:not(:disabled) { background: rgba(228, 87, 101, 0.1); }

    .btn-icon {
      width: 32px;
      padding: 0;
    }

    /* Layout */
    .app-shell {
      display: grid;
      grid-template-columns: 1fr 360px;
      gap: 1px;
      height: calc(100vh - 56px);
      background: var(--border);
    }

    .main-panel, .inspector {
      background: var(--bg);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .main-panel { min-width: 0; }
    .inspector { border-left: 1px solid var(--border); }

    /* Toolbar */
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 18px;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
`;

