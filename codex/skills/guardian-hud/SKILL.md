---
name: guardian-hud
description: Use when the user asks for the Guardian HUD, dashboard, or control-room view from Codex.
---

# Guardian HUD

Codex does not have the OpenCode TUI HUD layer. Provide the closest Codex surface by running status first:

```bash
node <adapter-path> tool guardian_status '{}'
```

If the user wants an offline control-room artifact, run:

```bash
node <adapter-path> tool guardian_report_html '{}'
```

Do not mutate worktrees, branches, refs, stashes, or files beyond the optional report written by `guardian_report_html`.
