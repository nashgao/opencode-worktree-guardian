---
name: guardian-report
description: Use when the user asks Guardian to write or open an offline HTML report of sessions, worktrees, branches, risks, and recovery evidence.
---

# Guardian Report

Run the Guardian Codex adapter:

```bash
node <adapter-path> tool guardian_report_html '{}'
```

Return the report path and summarize the main risks. Do not mutate worktrees, branches, refs, stashes, or workspace files beyond the report that the native tool writes.
